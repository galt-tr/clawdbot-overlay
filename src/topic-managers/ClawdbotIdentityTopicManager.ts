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
import { Transaction, Beef, Script, PushDrop, Utils } from '@bsv/sdk'
import { PROTOCOL_ID, type ClawdbotIdentityData } from '../types.js'
import {extractPayload} from "../extract.js";

export class ClawdbotIdentityTopicManager implements TopicManager {
  /**
   * Parse a BEEF structure and return the "newest" (subject) transaction.
   */
  private getSubjectTransaction (beef: number[]): Transaction {
    return Transaction.fromBEEF(beef)
  }

  private parseIdentityOutput (script: Script): ClawdbotIdentityData | null {
   try {
      return extractPayload(script) as ClawdbotIdentityData
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
