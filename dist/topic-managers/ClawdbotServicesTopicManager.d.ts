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
import type { TopicManager, AdmittanceInstructions } from '@bsv/overlay';
export declare class ClawdbotServicesTopicManager implements TopicManager {
    private getSubjectTransaction;
    /**
     * Extract data pushes from an OP_RETURN script.
     *
     * The @bsv/sdk v1.10+ parseChunks collapses everything after OP_RETURN
     * into a single chunk with all remaining bytes as `data`. This helper
     * re-parses those bytes to extract the individual pushdata fields.
     *
     * Supports both the legacy 4-chunk format and the collapsed 2-chunk format.
     */
    private extractOpReturnPushes;
    /**
     * Check if a script is a valid Clawdbot service OP_RETURN output.
     * Expected format: OP_FALSE OP_RETURN <protocol_prefix> <json_payload>
     */
    private parseServiceOutput;
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
//# sourceMappingURL=ClawdbotServicesTopicManager.d.ts.map