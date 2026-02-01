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
import { OP } from '@bsv/sdk';
import { PROTOCOL_ID, TOPICS, } from '../types.js';
// ---------------------------------------------------------------------------
//  Knex migration for the services table
// ---------------------------------------------------------------------------
const SERVICES_TABLE = 'clawdbot_services';
function createMigrations() {
    return [
        {
            name: '001_create_clawdbot_services',
            async up(knex) {
                const exists = await knex.schema.hasTable(SERVICES_TABLE);
                if (!exists) {
                    await knex.schema.createTable(SERVICES_TABLE, (table) => {
                        table.string('txid', 64).notNullable();
                        table.integer('outputIndex').notNullable();
                        table.string('identityKey', 66).notNullable();
                        table.string('serviceId', 255).notNullable();
                        table.string('name', 255).notNullable();
                        table.text('description');
                        table.string('pricingModel', 64);
                        table.integer('pricingSats');
                        table.string('timestamp', 64);
                        table.string('createdAt', 64);
                        table.primary(['txid', 'outputIndex']);
                        table.index(['identityKey']);
                        table.index(['serviceId']);
                        table.index(['pricingSats']);
                    });
                }
            },
            async down(knex) {
                await knex.schema.dropTableIfExists(SERVICES_TABLE);
            },
        },
    ];
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
export function createServiceLookupService(knex) {
    return {
        service: new ClawdbotServiceLookupService(knex),
        migrations: createMigrations(),
    };
}
// ---------------------------------------------------------------------------
//  Service implementation
// ---------------------------------------------------------------------------
export class ClawdbotServiceLookupService {
    knex;
    admissionMode = 'locking-script';
    spendNotificationMode = 'none';
    constructor(knex) {
        this.knex = knex;
    }
    // -------------------------------------------------------------------------
    //  outputAdmittedByTopic — called when a service UTXO is admitted
    // -------------------------------------------------------------------------
    async outputAdmittedByTopic(payload) {
        if (payload.mode !== 'locking-script')
            return;
        if (payload.topic !== TOPICS.SERVICES)
            return;
        const { txid, outputIndex, lockingScript } = payload;
        const data = this.parseServiceFromScript(lockingScript);
        if (!data)
            return;
        // Dedup: remove old entries for the same (identityKey, serviceId)
        // so re-advertising replaces the previous listing
        await this.knex(SERVICES_TABLE)
            .where({ identityKey: data.identityKey, serviceId: data.serviceId })
            .andWhereNot({ txid, outputIndex })
            .delete();
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
        })
            .onConflict(['txid', 'outputIndex'])
            .merge();
    }
    // -------------------------------------------------------------------------
    //  outputSpent — called when a service UTXO is spent
    // -------------------------------------------------------------------------
    async outputSpent(payload) {
        if (payload.topic !== TOPICS.SERVICES)
            return;
        await this.knex(SERVICES_TABLE)
            .where({ txid: payload.txid, outputIndex: payload.outputIndex })
            .delete();
    }
    // -------------------------------------------------------------------------
    //  outputEvicted — legal eviction
    // -------------------------------------------------------------------------
    async outputEvicted(txid, outputIndex) {
        await this.knex(SERVICES_TABLE)
            .where({ txid, outputIndex })
            .delete();
    }
    // -------------------------------------------------------------------------
    //  lookup — query the index
    // -------------------------------------------------------------------------
    async lookup(question) {
        const query = (question.query ?? {});
        let qb = this.knex(SERVICES_TABLE).select('txid', 'outputIndex');
        if (query.serviceType) {
            qb = qb.where('serviceId', query.serviceType);
        }
        if (query.provider) {
            qb = qb.where('identityKey', query.provider);
        }
        if (typeof query.maxPriceSats === 'number') {
            qb = qb.where('pricingSats', '<=', query.maxPriceSats);
        }
        const rows = await qb.limit(100);
        return rows.map((row) => ({
            txid: row.txid,
            outputIndex: row.outputIndex,
        }));
    }
    // -------------------------------------------------------------------------
    //  Documentation & metadata
    // -------------------------------------------------------------------------
    async getDocumentation() {
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
`;
    }
    async getMetaData() {
        return {
            name: 'Clawdbot Service Catalog Lookup',
            shortDescription: 'Search for Clawdbot agent services by type, price, or provider',
            version: '0.1.0',
            informationURL: 'https://github.com/galt-tr/clawdbot-overlay',
        };
    }
    // -------------------------------------------------------------------------
    //  Private helpers
    // -------------------------------------------------------------------------
    extractOpReturnPushes(script) {
        const chunks = script.chunks;
        if (chunks.length >= 4 && chunks[0].op === OP.OP_FALSE && chunks[1].op === OP.OP_RETURN) {
            const pushes = [];
            for (let i = 2; i < chunks.length; i++) {
                if (chunks[i].data)
                    pushes.push(new Uint8Array(chunks[i].data));
            }
            return pushes;
        }
        if (chunks.length === 2 && chunks[0].op === OP.OP_FALSE && chunks[1].op === OP.OP_RETURN && chunks[1].data) {
            const blob = chunks[1].data;
            const pushes = [];
            let pos = 0;
            while (pos < blob.length) {
                const op = blob[pos++];
                if (op > 0 && op <= 75) {
                    pushes.push(new Uint8Array(blob.slice(pos, pos + op)));
                    pos += op;
                }
                else if (op === 0x4c) {
                    const len = blob[pos++] ?? 0;
                    pushes.push(new Uint8Array(blob.slice(pos, pos + len)));
                    pos += len;
                }
                else if (op === 0x4d) {
                    const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8);
                    pos += 2;
                    pushes.push(new Uint8Array(blob.slice(pos, pos + len)));
                    pos += len;
                }
                else {
                    break;
                }
            }
            return pushes.length >= 2 ? pushes : null;
        }
        return null;
    }
    parseServiceFromScript(script) {
        const pushes = this.extractOpReturnPushes(script);
        if (!pushes || pushes.length < 2)
            return null;
        const protocolStr = new TextDecoder().decode(pushes[0]);
        if (protocolStr !== PROTOCOL_ID)
            return null;
        try {
            const payload = JSON.parse(new TextDecoder().decode(pushes[1]));
            if (payload.type !== 'service')
                return null;
            return payload;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=ClawdbotServiceLookupService.js.map