/**
 * ClawdbotIdentityTopicManager
 *
 * Manages the `tm_clawdbot_identity` topic.
 * Admits OP_RETURN outputs that contain a valid Clawdbot identity payload.
 *
 * Admittance rules:
 * 1. Output must start with OP_FALSE OP_RETURN
 * 2. First data push must be the protocol prefix "clawdbot-overlay-v1"
 * 3. Second data push must be valid JSON conforming to ClawdbotIdentityData
 * 4. The `type` field must be "identity"
 * 5. The `identityKey` field must be a valid compressed public key (66 hex chars)
 */

import type { TopicManager, AdmittanceInstructions } from '@bsv/overlay'
import { Transaction, Beef, Script, OP } from '@bsv/sdk'
import { PROTOCOL_ID, type ClawdbotIdentityData } from '../types.js'

export class ClawdbotIdentityTopicManager implements TopicManager {
  /**
   * Parse a BEEF structure and return the "newest" (subject) transaction.
   */
  private getSubjectTransaction (beef: number[]): Transaction {
    return Transaction.fromBEEF(beef)
  }

  /**
   * Extract data pushes from an OP_RETURN script.
   *
   * The @bsv/sdk v1.10+ parseChunks collapses everything after OP_RETURN
   * into a single chunk with all remaining bytes as `data`. This helper
   * re-parses those bytes to extract the individual pushdata fields.
   *
   * Supports both the legacy 4-chunk format and the collapsed 2-chunk format.
   *
   * @returns Array of Uint8Array data pushes, or null if not a valid OP_RETURN.
   */
  private extractOpReturnPushes (script: Script): Uint8Array[] | null {
    const chunks = script.chunks

    // --- Legacy 4+ chunk format (older SDK) ---
    if (chunks.length >= 4 &&
        chunks[0].op === OP.OP_FALSE &&
        chunks[1].op === OP.OP_RETURN) {
      const pushes: Uint8Array[] = []
      for (let i = 2; i < chunks.length; i++) {
        if (chunks[i].data) pushes.push(new Uint8Array(chunks[i].data!))
      }
      return pushes
    }

    // --- Collapsed 2-chunk format (SDK v1.10+) ---
    // chunks[0] = OP_FALSE (op=0), chunks[1] = OP_RETURN with data blob
    if (chunks.length === 2 &&
        chunks[0].op === OP.OP_FALSE &&
        chunks[1].op === OP.OP_RETURN &&
        chunks[1].data) {
      const blob = chunks[1].data
      const pushes: Uint8Array[] = []
      let pos = 0
      while (pos < blob.length) {
        const op = blob[pos++]
        if (op > 0 && op <= 75) {
          // Direct push: op is the byte count
          const end = Math.min(pos + op, blob.length)
          pushes.push(new Uint8Array(blob.slice(pos, end)))
          pos = end
        } else if (op === 0x4c) {
          // OP_PUSHDATA1
          const len = blob[pos++] ?? 0
          const end = Math.min(pos + len, blob.length)
          pushes.push(new Uint8Array(blob.slice(pos, end)))
          pos = end
        } else if (op === 0x4d) {
          // OP_PUSHDATA2
          const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8)
          pos += 2
          const end = Math.min(pos + len, blob.length)
          pushes.push(new Uint8Array(blob.slice(pos, end)))
          pos = end
        } else if (op === 0x4e) {
          // OP_PUSHDATA4
          const len = ((blob[pos] ?? 0) |
            ((blob[pos + 1] ?? 0) << 8) |
            ((blob[pos + 2] ?? 0) << 16) |
            ((blob[pos + 3] ?? 0) << 24)) >>> 0
          pos += 4
          const end = Math.min(pos + len, blob.length)
          pushes.push(new Uint8Array(blob.slice(pos, end)))
          pos = end
        } else {
          // Unknown op — skip
          break
        }
      }
      return pushes.length >= 2 ? pushes : null
    }

    return null
  }

  /**
   * Check if a script is a valid Clawdbot identity OP_RETURN output.
   * Expected format: OP_FALSE OP_RETURN <protocol_prefix> <json_payload>
   */
  private parseIdentityOutput (script: Script): ClawdbotIdentityData | null {
    const pushes = this.extractOpReturnPushes(script)
    if (!pushes || pushes.length < 2) return null

    // Check protocol identifier (first push)
    const protocolStr = new TextDecoder().decode(pushes[0])
    if (protocolStr !== PROTOCOL_ID) return null

    // Parse JSON payload (second push)
    const payloadBytes = pushes[1]
    try {
      const payload = JSON.parse(
        new TextDecoder().decode(payloadBytes)
      ) as ClawdbotIdentityData

      // Validate required fields
      if (payload.protocol !== PROTOCOL_ID) return null
      if (payload.type !== 'identity') return null
      if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null
      if (typeof payload.name !== 'string' || payload.name.length === 0) return null
      if (!Array.isArray(payload.capabilities)) return null
      if (typeof payload.timestamp !== 'string') return null

      return payload
    } catch {
      return null
    }
  }

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    _offChainValues?: number[],
    _mode?: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv'
  ): Promise<AdmittanceInstructions> {
    const tx = this.getSubjectTransaction(beef)
    const outputsToAdmit: number[] = []
    const coinsToRetain: number[] = []

    // Scan all outputs for valid identity payloads
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i]
      if (output.lockingScript) {
        const parsed = this.parseIdentityOutput(output.lockingScript)
        if (parsed !== null) {
          outputsToAdmit.push(i)
        }
      }
    }

    // If this transaction spends previous identity coins, don't retain them
    // (identity updates replace the old record)

    return {
      outputsToAdmit,
      coinsToRetain,
    }
  }

  async getDocumentation (): Promise<string> {
    return `# tm_clawdbot_identity — Clawdbot Agent Identity Topic

## Overview
Manages agent identity records on the BSV overlay network. Each Clawdbot agent
publishes an OP_RETURN output containing its identity information, capabilities,
and contact channels.

## Output Format
\`\`\`
OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON payload>
\`\`\`

## Payload Schema
\`\`\`json
{
  "protocol": "clawdbot-overlay-v1",
  "type": "identity",
  "identityKey": "02abc...",
  "name": "researcher-bot",
  "description": "Specializes in academic paper analysis",
  "channels": { "telegram": "@researcher_bot" },
  "capabilities": ["research", "code-review"],
  "timestamp": "2026-01-30T23:00:00Z"
}
\`\`\`

## Admittance Rules
1. Output must be an OP_FALSE OP_RETURN script
2. Protocol prefix must be "clawdbot-overlay-v1"
3. JSON payload must include type "identity"
4. identityKey must be a valid 33-byte compressed public key (66 hex chars)
5. name must be a non-empty string
6. capabilities must be an array

## Identity Updates
When an agent updates its identity, it spends the previous identity UTXO
and creates a new one. The old record is automatically removed from lookup
services via the outputSpent callback.
`
  }

  async getMetaData (): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Clawdbot Identity Topic Manager',
      shortDescription: 'Manages Clawdbot agent identity records on the BSV overlay network',
      version: '0.1.0',
      informationURL: 'https://github.com/galt-tr/clawdbot-overlay',
    }
  }
}
