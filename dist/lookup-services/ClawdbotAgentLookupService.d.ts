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
import type { LookupService, LookupFormula, AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent, LookupServiceMetaData } from '@bsv/overlay';
import type { LookupQuestion } from '@bsv/sdk';
import type Knex from 'knex';
/**
 * Factory that creates a ClawdbotAgentLookupService backed by Knex.
 *
 * Usage with OverlayExpress:
 * ```ts
 * server.configureLookupServiceWithKnex('ls_clawdbot_agents', createAgentLookupService)
 * ```
 */
export declare function createAgentLookupService(knex: Knex.Knex): {
    service: LookupService;
    migrations: Array<{
        name: string;
        up: (k: Knex.Knex) => Promise<void>;
        down?: (k: Knex.Knex) => Promise<void>;
    }>;
};
export declare class ClawdbotAgentLookupService implements LookupService {
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
    /**
     * Extract ClawdbotIdentityData from a locking script.
     */
    /**
     * Extract data pushes from an OP_RETURN script.
     * Handles both legacy 4+ chunk format and collapsed 2-chunk format (SDK v1.10+).
     */
    private extractOpReturnPushes;
    private parseIdentityFromScript;
}
//# sourceMappingURL=ClawdbotAgentLookupService.d.ts.map