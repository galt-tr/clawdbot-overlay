/**
 * ClawdbotAgentLookupService
 *
 * Lookup service for agent identity records on the `tm_clawdbot_identity` topic.
 * Backed by Knex (SQL) — designed for SQLite or MySQL.
 *
 * Query format:
 *   { identityKey?: string, name?: string, capability?: string }
 *
 * Returns LookupFormula pointing to matching identity UTXOs.
 */

import type {
  LookupService,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent,
  LookupServiceMetaData,
} from '@bsv/overlay'
import type { LookupQuestion } from '@bsv/sdk'
import type Knex from 'knex'
import { OP } from '@bsv/sdk'
import {
  PROTOCOL_ID,
  TOPICS,
  type ClawdbotIdentityData,
  type AgentLookupQuery,
  type AgentRecord,
} from '../types.js'

// ---------------------------------------------------------------------------
//  Knex migration for the agents table
// ---------------------------------------------------------------------------

const AGENTS_TABLE = 'clawdbot_agents'

function createMigrations (): Array<{
  name: string
  up: (knex: Knex.Knex) => Promise<void>
  down?: (knex: Knex.Knex) => Promise<void>
}> {
  return [
    {
      name: '001_create_clawdbot_agents',
      async up (knex: Knex.Knex) {
        const exists = await knex.schema.hasTable(AGENTS_TABLE)
        if (!exists) {
          await knex.schema.createTable(AGENTS_TABLE, (table) => {
            table.string('txid', 64).notNullable()
            table.integer('outputIndex').notNullable()
            table.string('identityKey', 66).notNullable()
            table.string('name', 255).notNullable()
            table.text('description')
            table.text('channels')        // JSON
            table.text('capabilities')    // JSON
            table.string('timestamp', 64)
            table.string('createdAt', 64)
            table.primary(['txid', 'outputIndex'])
            table.index(['identityKey'])
            table.index(['name'])
          })
        }
      },
      async down (knex: Knex.Knex) {
        await knex.schema.dropTableIfExists(AGENTS_TABLE)
      },
    },
  ]
}

// ---------------------------------------------------------------------------
//  Factory function for overlay-express configureLookupServiceWithKnex
// ---------------------------------------------------------------------------

/**
 * Factory that creates a ClawdbotAgentLookupService backed by Knex.
 *
 * Usage with OverlayExpress:
 * ```ts
 * server.configureLookupServiceWithKnex('ls_clawdbot_agents', createAgentLookupService)
 * ```
 */
export function createAgentLookupService (
  knex: Knex.Knex
): { service: LookupService; migrations: Array<{ name: string; up: (k: Knex.Knex) => Promise<void>; down?: (k: Knex.Knex) => Promise<void> }> } {
  return {
    service: new ClawdbotAgentLookupService(knex),
    migrations: createMigrations(),
  }
}

// ---------------------------------------------------------------------------
//  Service implementation
// ---------------------------------------------------------------------------

export class ClawdbotAgentLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor (private readonly knex: Knex.Knex) {}

  // -------------------------------------------------------------------------
  //  outputAdmittedByTopic — called when an identity UTXO is admitted
  // -------------------------------------------------------------------------
  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== TOPICS.IDENTITY) return

    const { txid, outputIndex, lockingScript } = payload

    // Parse the locking script to extract identity data
    const data = this.parseIdentityFromScript(lockingScript)
    if (!data) return

    // Upsert: if this agent already has a record, replace it
    await this.knex(AGENTS_TABLE)
      .insert({
        txid,
        outputIndex,
        identityKey: data.identityKey,
        name: data.name,
        description: data.description,
        channels: JSON.stringify(data.channels),
        capabilities: JSON.stringify(data.capabilities),
        timestamp: data.timestamp,
        createdAt: new Date().toISOString(),
      } satisfies AgentRecord)
      .onConflict(['txid', 'outputIndex'])
      .merge()
  }

  // -------------------------------------------------------------------------
  //  outputSpent — called when an identity UTXO is spent (update or deregister)
  // -------------------------------------------------------------------------
  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== TOPICS.IDENTITY) return
    await this.knex(AGENTS_TABLE)
      .where({ txid: payload.txid, outputIndex: payload.outputIndex })
      .delete()
  }

  // -------------------------------------------------------------------------
  //  outputEvicted — legal eviction of a UTXO
  // -------------------------------------------------------------------------
  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.knex(AGENTS_TABLE)
      .where({ txid, outputIndex })
      .delete()
  }

  // -------------------------------------------------------------------------
  //  lookup — query the index
  // -------------------------------------------------------------------------
  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = (question.query ?? {}) as AgentLookupQuery
    let qb = this.knex(AGENTS_TABLE).select('txid', 'outputIndex')

    if (query.identityKey) {
      qb = qb.where('identityKey', query.identityKey)
    }

    if (query.name) {
      qb = qb.where('name', 'like', `%${query.name}%`)
    }

    if (query.capability) {
      // capabilities is stored as JSON array string, use LIKE for simple matching
      qb = qb.where('capabilities', 'like', `%"${query.capability}"%`)
    }

    const rows: Array<{ txid: string; outputIndex: number }> = await qb.limit(100)

    return rows.map((row) => ({
      txid: row.txid,
      outputIndex: row.outputIndex,
    }))
  }

  // -------------------------------------------------------------------------
  //  Documentation & metadata
  // -------------------------------------------------------------------------
  async getDocumentation (): Promise<string> {
    return `# ls_clawdbot_agents — Clawdbot Agent Lookup Service

## Overview
Queries agent identity records indexed from the \`tm_clawdbot_identity\` topic.

## Query Format
\`\`\`json
{
  "service": "ls_clawdbot_agents",
  "query": {
    "identityKey": "02abc...",
    "name": "researcher",
    "capability": "code-review"
  }
}
\`\`\`

All query fields are optional. Omit all to list all agents (up to 100).

## Fields
- **identityKey** — exact match on the agent's compressed public key
- **name** — case-insensitive substring match on agent name
- **capability** — match agents that advertise the given capability

## Response
Returns a LookupFormula: an array of \`{ txid, outputIndex }\` pointing to
the matching identity UTXOs.  The overlay engine resolves these into full
BEEF-formatted transactions for the caller.
`
  }

  async getMetaData (): Promise<LookupServiceMetaData> {
    return {
      name: 'Clawdbot Agent Lookup Service',
      shortDescription: 'Search for Clawdbot agents by identity key, name, or capability',
      version: '0.1.0',
      informationURL: 'https://github.com/galt-tr/clawdbot-overlay',
    }
  }

  // -------------------------------------------------------------------------
  //  Private helpers
  // -------------------------------------------------------------------------

  /**
   * Extract ClawdbotIdentityData from a locking script.
   */
  /**
   * Extract data pushes from an OP_RETURN script.
   * Handles both legacy 4+ chunk format and collapsed 2-chunk format (SDK v1.10+).
   */
  private extractOpReturnPushes (script: { chunks: Array<{ op: number; data?: number[] }> }): Uint8Array[] | null {
    const chunks = script.chunks

    // Legacy 4+ chunk format
    if (chunks.length >= 4 && chunks[0].op === OP.OP_FALSE && chunks[1].op === OP.OP_RETURN) {
      const pushes: Uint8Array[] = []
      for (let i = 2; i < chunks.length; i++) {
        if (chunks[i].data) pushes.push(new Uint8Array(chunks[i].data!))
      }
      return pushes
    }

    // Collapsed 2-chunk format (OP_FALSE + OP_RETURN with data blob)
    if (chunks.length === 2 && chunks[0].op === OP.OP_FALSE && chunks[1].op === OP.OP_RETURN && chunks[1].data) {
      const blob = chunks[1].data
      const pushes: Uint8Array[] = []
      let pos = 0
      while (pos < blob.length) {
        const op = blob[pos++]
        if (op > 0 && op <= 75) {
          pushes.push(new Uint8Array(blob.slice(pos, pos + op))); pos += op
        } else if (op === 0x4c) {
          const len = blob[pos++] ?? 0; pushes.push(new Uint8Array(blob.slice(pos, pos + len))); pos += len
        } else if (op === 0x4d) {
          const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8); pos += 2
          pushes.push(new Uint8Array(blob.slice(pos, pos + len))); pos += len
        } else { break }
      }
      return pushes.length >= 2 ? pushes : null
    }

    return null
  }

  private parseIdentityFromScript (script: { chunks: Array<{ op: number; data?: number[] }> }): ClawdbotIdentityData | null {
    const pushes = this.extractOpReturnPushes(script)
    if (!pushes || pushes.length < 2) return null

    const protocolStr = new TextDecoder().decode(pushes[0])
    if (protocolStr !== PROTOCOL_ID) return null

    try {
      const payload = JSON.parse(
        new TextDecoder().decode(pushes[1])
      ) as ClawdbotIdentityData
      if (payload.type !== 'identity') return null
      return payload
    } catch {
      return null
    }
  }
}
