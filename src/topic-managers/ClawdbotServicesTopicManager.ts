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
import {Transaction, Script, OP, PushDrop, Utils} from '@bsv/sdk'
import {PROTOCOL_ID, type ClawdbotServiceData, type ClawdbotIdentityData} from '../types.js'
import {extractPayload} from "../extract.js";

export class ClawdbotServicesTopicManager implements TopicManager {
  private getSubjectTransaction (beef: number[]): Transaction {
    return Transaction.fromBEEF(beef)
  }

  /**
   * Check if a script is a valid Clawdbot service OP_RETURN output.
   * Expected format: OP_FALSE OP_RETURN <protocol_prefix> <json_payload>
   */
  private parseServiceOutput (script: Script): ClawdbotServiceData | null {
    try {
      return extractPayload(script) as ClawdbotServiceData
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
