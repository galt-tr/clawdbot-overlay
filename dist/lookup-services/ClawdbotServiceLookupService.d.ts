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
import type { LookupService, LookupFormula, AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent, LookupServiceMetaData } from '@bsv/overlay';
import type { LookupQuestion } from '@bsv/sdk';
import type Knex from 'knex';
/**
 * Factory that creates a ClawdbotServiceLookupService backed by Knex.
 *
 * Usage with OverlayExpress:
 * ```ts
 * server.configureLookupServiceWithKnex('ls_clawdbot_services', createServiceLookupService)
 * ```
 */
export declare function createServiceLookupService(knex: Knex.Knex): {
    service: LookupService;
    migrations: Array<{
        name: string;
        up: (k: Knex.Knex) => Promise<void>;
        down?: (k: Knex.Knex) => Promise<void>;
    }>;
};
export declare class ClawdbotServiceLookupService implements LookupService {
    private readonly knex;
    readonly admissionMode: AdmissionMode;
    readonly spendNotificationMode: SpendNotificationMode;
    constructor(knex: Knex.Knex);
    outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void>;
    outputSpent(payload: OutputSpent): Promise<void>;
    outputEvicted(txid: string, outputIndex: number): Promise<void>;
    lookup(question: LookupQuestion): Promise<LookupFormula>;
    getDocumentation(): Promise<string>;
    getMetaData(): Promise<LookupServiceMetaData>;
    private extractOpReturnPushes;
    private parseServiceFromScript;
}
//# sourceMappingURL=ClawdbotServiceLookupService.d.ts.map