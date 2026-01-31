/**
 * ClawdbotServiceLookupService
 *
 * Lookup service for service catalog entries on the `tm_clawdbot_services` topic.
 * Backed by Knex (SQL) — designed for SQLite or MySQL.
 *
 * Query format:
 *   { serviceType?: string, maxPriceSats?: number, provider?: string }
 *
 * Returns LookupFormula pointing to matching service UTXOs.
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
  type ClawdbotServiceData,
  type ServiceLookupQuery,
  type ServiceRecord,
} from '../types.js'

// ---------------------------------------------------------------------------
//  Knex migration for the services table
// ---------------------------------------------------------------------------

const SERVICES_TABLE = 'clawdbot_services'

function createMigrations (): Array<{
  name: string
  up: (knex: Knex.Knex) => Promise<void>
  down?: (knex: Knex.Knex) => Promise<void>
}> {
  return [
    {
      name: '001_create_clawdbot_services',
      async up (knex: Knex.Knex) {
        const exists = await knex.schema.hasTable(SERVICES_TABLE)
        if (!exists) {
          await knex.schema.createTable(SERVICES_TABLE, (table) => {
            table.string('txid', 64).notNullable()
            table.integer('outputIndex').notNullable()
            table.string('identityKey', 66).notNullable()
            table.string('serviceId', 255).notNullable()
            table.string('name', 255).notNullable()
            table.text('description')
            table.string('pricingModel', 64)
            table.integer('pricingSats')
            table.string('timestamp', 64)
            table.string('createdAt', 64)
            table.primary(['txid', 'outputIndex'])
            table.index(['identityKey'])
            table.index(['serviceId'])
            table.index(['pricingSats'])
          })
        }
      },
      async down (knex: Knex.Knex) {
        await knex.schema.dropTableIfExists(SERVICES_TABLE)
      },
    },
  ]
}

// ---------------------------------------------------------------------------
//  Factory function for overlay-express configureLookupServiceWithKnex
// ---------------------------------------------------------------------------

/**
 * Factory that creates a ClawdbotServiceLookupService backed by Knex.
 *
 * Usage with OverlayExpress:
 * ```ts
 * server.configureLookupServiceWithKnex('ls_clawdbot_services', createServiceLookupService)
 * ```
 */
export function createServiceLookupService (
  knex: Knex.Knex
): { service: LookupService; migrations: Array<{ name: string; up: (k: Knex.Knex) => Promise<void>; down?: (k: Knex.Knex) => Promise<void> }> } {
  return {
    service: new ClawdbotServiceLookupService(knex),
    migrations: createMigrations(),
  }
}

// ---------------------------------------------------------------------------
//  Service implementation
// ---------------------------------------------------------------------------

export class ClawdbotServiceLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor (private readonly knex: Knex.Knex) {}

  // -------------------------------------------------------------------------
  //  outputAdmittedByTopic — called when a service UTXO is admitted
  // -------------------------------------------------------------------------
  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== TOPICS.SERVICES) return

    const { txid, outputIndex, lockingScript } = payload

    const data = this.parseServiceFromScript(lockingScript)
    if (!data) return

    await this.knex(SERVICES_TABLE)
      .insert({
        txid,
        outputIndex,
        identityKey: data.identityKey,
        serviceId: data.serviceId,
        name: data.name,
        description: data.description,
        pricingModel: data.pricing.model,
        pricingSats: data.pricing.amountSats,
        timestamp: data.timestamp,
        createdAt: new Date().toISOString(),
      } satisfies ServiceRecord)
      .onConflict(['txid', 'outputIndex'])
      .merge()
  }

  // -------------------------------------------------------------------------
  //  outputSpent — called when a service UTXO is spent
  // -------------------------------------------------------------------------
  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== TOPICS.SERVICES) return
    await this.knex(SERVICES_TABLE)
      .where({ txid: payload.txid, outputIndex: payload.outputIndex })
      .delete()
  }

  // -------------------------------------------------------------------------
  //  outputEvicted — legal eviction
  // -------------------------------------------------------------------------
  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.knex(SERVICES_TABLE)
      .where({ txid, outputIndex })
      .delete()
  }

  // -------------------------------------------------------------------------
  //  lookup — query the index
  // -------------------------------------------------------------------------
  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = (question.query ?? {}) as ServiceLookupQuery
    let qb = this.knex(SERVICES_TABLE).select('txid', 'outputIndex')

    if (query.serviceType) {
      qb = qb.where('serviceId', query.serviceType)
    }

    if (query.provider) {
      qb = qb.where('identityKey', query.provider)
    }

    if (typeof query.maxPriceSats === 'number') {
      qb = qb.where('pricingSats', '<=', query.maxPriceSats)
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
    return `# ls_clawdbot_services — Clawdbot Service Catalog Lookup

## Overview
Queries service catalog entries indexed from the \`tm_clawdbot_services\` topic.
Enables agents to discover available services, filter by type and price, and
find specific providers.

## Query Format
\`\`\`json
{
  "service": "ls_clawdbot_services",
  "query": {
    "serviceType": "paper-analysis",
    "maxPriceSats": 1000,
    "provider": "02abc..."
  }
}
\`\`\`

All query fields are optional. Omit all to list all services (up to 100).

## Fields
- **serviceType** — exact match on serviceId
- **maxPriceSats** — maximum price in satoshis (inclusive)
- **provider** — exact match on the provider's identity key

## Response
Returns a LookupFormula: an array of \`{ txid, outputIndex }\` pointing to
matching service catalog UTXOs.
`
  }

  async getMetaData (): Promise<LookupServiceMetaData> {
    return {
      name: 'Clawdbot Service Catalog Lookup',
      shortDescription: 'Search for Clawdbot agent services by type, price, or provider',
      version: '0.1.0',
      informationURL: 'https://github.com/galt-tr/clawdbot-overlay',
    }
  }

  // -------------------------------------------------------------------------
  //  Private helpers
  // -------------------------------------------------------------------------

  private extractOpReturnPushes (script: { chunks: Array<{ op: number; data?: number[] }> }): Uint8Array[] | null {
    const chunks = script.chunks

    if (chunks.length >= 4 && chunks[0].op === OP.OP_FALSE && chunks[1].op === OP.OP_RETURN) {
      const pushes: Uint8Array[] = []
      for (let i = 2; i < chunks.length; i++) {
        if (chunks[i].data) pushes.push(new Uint8Array(chunks[i].data!))
      }
      return pushes
    }

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

  private parseServiceFromScript (script: { chunks: Array<{ op: number; data?: number[] }> }): ClawdbotServiceData | null {
    const pushes = this.extractOpReturnPushes(script)
    if (!pushes || pushes.length < 2) return null

    const protocolStr = new TextDecoder().decode(pushes[0])
    if (protocolStr !== PROTOCOL_ID) return null

    try {
      const payload = JSON.parse(
        new TextDecoder().decode(pushes[1])
      ) as ClawdbotServiceData
      if (payload.type !== 'service') return null
      return payload
    } catch {
      return null
    }
  }
}
