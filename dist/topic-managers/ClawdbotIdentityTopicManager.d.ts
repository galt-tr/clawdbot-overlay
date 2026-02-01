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
import type { TopicManager, AdmittanceInstructions } from '@bsv/overlay';
export declare class ClawdbotIdentityTopicManager implements TopicManager {
    /**
     * Parse a BEEF structure and return the "newest" (subject) transaction.
     */
    private getSubjectTransaction;
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
    private extractOpReturnPushes;
    /**
     * Check if a script is a valid Clawdbot identity OP_RETURN output.
     * Expected format: OP_FALSE OP_RETURN <protocol_prefix> <json_payload>
     */
    private parseIdentityOutput;
    identifyAdmissibleOutputs(beef: number[], previousCoins: number[], _offChainValues?: number[], _mode?: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv'): Promise<AdmittanceInstructions>;
    getDocumentation(): Promise<string>;
    getMetaData(): Promise<{
        name: string;
        shortDescription: string;
        iconURL?: string;
        version?: string;
        informationURL?: string;
    }>;
}
//# sourceMappingURL=ClawdbotIdentityTopicManager.d.ts.map