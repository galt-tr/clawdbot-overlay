/**
 * ClawdbotServicesTopicManager
 *
 * Manages the `tm_clawdbot_services` topic.
 * Admits OP_RETURN outputs that contain a valid Clawdbot service catalog entry.
 *
 * Admittance rules:
 * 1. Output must start with OP_FALSE OP_RETURN
 * 2. First data push must be the protocol prefix "clawdbot-overlay-v1"
 * 3. Second data push must be valid JSON conforming to ClawdbotServiceData
 * 4. The `type` field must be "service"
 * 5. The `identityKey` must be a valid compressed public key
 * 6. The `serviceId` must be a non-empty string
 * 7. The `pricing` must have a valid model and non-negative amountSats
 */

import type { TopicManager, AdmittanceInstructions } from '@bsv/overlay'
import { Transaction, Script, OP } from '@bsv/sdk'
import { PROTOCOL_ID, type ClawdbotServiceData } from '../types.js'

export class ClawdbotServicesTopicManager implements TopicManager {
  private getSubjectTransaction (beef: number[]): Transaction {
    return Transaction.fromBEEF(beef)
  }

  /**
   * Check if a script is a valid Clawdbot service OP_RETURN output.
   * Expected format: OP_FALSE OP_RETURN <protocol_prefix> <json_payload>
   */
  private parseServiceOutput (script: Script): ClawdbotServiceData | null {
    const chunks = script.chunks
    if (chunks.length < 4) return null

    // Check OP_FALSE OP_RETURN prefix
    if (chunks[0].op !== OP.OP_FALSE) return null
    if (chunks[1].op !== OP.OP_RETURN) return null

    // Check protocol identifier
    const protocolChunk = chunks[2]
    if (!protocolChunk.data) return null
    const protocolStr = new TextDecoder().decode(new Uint8Array(protocolChunk.data))
    if (protocolStr !== PROTOCOL_ID) return null

    // Parse JSON payload
    const payloadChunk = chunks[3]
    if (!payloadChunk.data) return null
    try {
      const payload = JSON.parse(
        new TextDecoder().decode(new Uint8Array(payloadChunk.data))
      ) as ClawdbotServiceData

      // Validate required fields
      if (payload.protocol !== PROTOCOL_ID) return null
      if (payload.type !== 'service') return null
      if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey)) return null
      if (typeof payload.serviceId !== 'string' || payload.serviceId.length === 0) return null
      if (typeof payload.name !== 'string' || payload.name.length === 0) return null
      if (!payload.pricing || typeof payload.pricing.model !== 'string') return null
      if (typeof payload.pricing.amountSats !== 'number' || payload.pricing.amountSats < 0) return null
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

    // Scan all outputs for valid service payloads
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i]
      if (output.lockingScript) {
        const parsed = this.parseServiceOutput(output.lockingScript)
        if (parsed !== null) {
          outputsToAdmit.push(i)
        }
      }
    }

    return {
      outputsToAdmit,
      coinsToRetain,
    }
  }

  async getDocumentation (): Promise<string> {
    return `# tm_clawdbot_services — Clawdbot Service Catalog Topic

## Overview
Manages service catalog entries on the BSV overlay network. Each Clawdbot agent
can publish one or more services it offers, including pricing in satoshis.
Other agents query these to discover available services and negotiate work.

## Output Format
\`\`\`
OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON payload>
\`\`\`

## Payload Schema
\`\`\`json
{
  "protocol": "clawdbot-overlay-v1",
  "type": "service",
  "identityKey": "02abc...",
  "serviceId": "paper-analysis",
  "name": "Academic Paper Analysis",
  "description": "Deep analysis of academic papers",
  "pricing": {
    "model": "per-task",
    "amountSats": 500
  },
  "timestamp": "2026-01-30T23:00:00Z"
}
\`\`\`

## Admittance Rules
1. Output must be an OP_FALSE OP_RETURN script
2. Protocol prefix must be "clawdbot-overlay-v1"
3. JSON payload must include type "service"
4. identityKey must be a valid 33-byte compressed public key
5. serviceId must be a non-empty string
6. pricing must include a model string and non-negative amountSats

## Service Updates
Services are updated by spending the old service UTXO and creating a new one.
An agent can publish multiple services simultaneously in separate outputs.
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
      name: 'Clawdbot Services Topic Manager',
      shortDescription: 'Manages Clawdbot agent service catalog entries on the BSV overlay network',
      version: '0.1.0',
      informationURL: 'https://github.com/galt-tr/clawdbot-overlay',
    }
  }
}
