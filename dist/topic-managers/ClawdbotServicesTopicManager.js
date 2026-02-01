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
import { Transaction, OP } from '@bsv/sdk';
import { PROTOCOL_ID } from '../types.js';
export class ClawdbotServicesTopicManager {
    getSubjectTransaction(beef) {
        return Transaction.fromBEEF(beef);
    }
    /**
     * Extract data pushes from an OP_RETURN script.
     *
     * The @bsv/sdk v1.10+ parseChunks collapses everything after OP_RETURN
     * into a single chunk with all remaining bytes as `data`. This helper
     * re-parses those bytes to extract the individual pushdata fields.
     *
     * Supports both the legacy 4-chunk format and the collapsed 2-chunk format.
     */
    extractOpReturnPushes(script) {
        const chunks = script.chunks;
        // --- Legacy 4+ chunk format (older SDK) ---
        if (chunks.length >= 4 &&
            chunks[0].op === OP.OP_FALSE &&
            chunks[1].op === OP.OP_RETURN) {
            const pushes = [];
            for (let i = 2; i < chunks.length; i++) {
                if (chunks[i].data)
                    pushes.push(new Uint8Array(chunks[i].data));
            }
            return pushes;
        }
        // --- Collapsed 2-chunk format (SDK v1.10+) ---
        if (chunks.length === 2 &&
            chunks[0].op === OP.OP_FALSE &&
            chunks[1].op === OP.OP_RETURN &&
            chunks[1].data) {
            const blob = chunks[1].data;
            const pushes = [];
            let pos = 0;
            while (pos < blob.length) {
                const op = blob[pos++];
                if (op > 0 && op <= 75) {
                    const end = Math.min(pos + op, blob.length);
                    pushes.push(new Uint8Array(blob.slice(pos, end)));
                    pos = end;
                }
                else if (op === 0x4c) {
                    const len = blob[pos++] ?? 0;
                    const end = Math.min(pos + len, blob.length);
                    pushes.push(new Uint8Array(blob.slice(pos, end)));
                    pos = end;
                }
                else if (op === 0x4d) {
                    const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8);
                    pos += 2;
                    const end = Math.min(pos + len, blob.length);
                    pushes.push(new Uint8Array(blob.slice(pos, end)));
                    pos = end;
                }
                else if (op === 0x4e) {
                    const len = ((blob[pos] ?? 0) |
                        ((blob[pos + 1] ?? 0) << 8) |
                        ((blob[pos + 2] ?? 0) << 16) |
                        ((blob[pos + 3] ?? 0) << 24)) >>> 0;
                    pos += 4;
                    const end = Math.min(pos + len, blob.length);
                    pushes.push(new Uint8Array(blob.slice(pos, end)));
                    pos = end;
                }
                else {
                    break;
                }
            }
            return pushes.length >= 2 ? pushes : null;
        }
        return null;
    }
    /**
     * Check if a script is a valid Clawdbot service OP_RETURN output.
     * Expected format: OP_FALSE OP_RETURN <protocol_prefix> <json_payload>
     */
    parseServiceOutput(script) {
        const pushes = this.extractOpReturnPushes(script);
        if (!pushes || pushes.length < 2)
            return null;
        // Check protocol identifier (first push)
        const protocolStr = new TextDecoder().decode(pushes[0]);
        if (protocolStr !== PROTOCOL_ID)
            return null;
        // Parse JSON payload (second push)
        const payloadBytes = pushes[1];
        try {
            const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
            // Validate required fields
            if (payload.protocol !== PROTOCOL_ID)
                return null;
            if (payload.type !== 'service')
                return null;
            if (typeof payload.identityKey !== 'string' || !/^[0-9a-fA-F]{66}$/.test(payload.identityKey))
                return null;
            if (typeof payload.serviceId !== 'string' || payload.serviceId.length === 0)
                return null;
            if (typeof payload.name !== 'string' || payload.name.length === 0)
                return null;
            if (!payload.pricing || typeof payload.pricing.model !== 'string')
                return null;
            if (typeof payload.pricing.amountSats !== 'number' || payload.pricing.amountSats < 0)
                return null;
            if (typeof payload.timestamp !== 'string')
                return null;
            return payload;
        }
        catch {
            return null;
        }
    }
    async identifyAdmissibleOutputs(beef, previousCoins, _offChainValues, _mode) {
        const tx = this.getSubjectTransaction(beef);
        const outputsToAdmit = [];
        const coinsToRetain = [];
        // Scan all outputs for valid service payloads
        for (let i = 0; i < tx.outputs.length; i++) {
            const output = tx.outputs[i];
            if (output.lockingScript) {
                const parsed = this.parseServiceOutput(output.lockingScript);
                if (parsed !== null) {
                    outputsToAdmit.push(i);
                }
            }
        }
        return {
            outputsToAdmit,
            coinsToRetain,
        };
    }
    async getDocumentation() {
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
`;
    }
    async getMetaData() {
        return {
            name: 'Clawdbot Services Topic Manager',
            shortDescription: 'Manages Clawdbot agent service catalog entries on the BSV overlay network',
            version: '0.1.0',
            informationURL: 'https://github.com/galt-tr/clawdbot-overlay',
        };
    }
}
//# sourceMappingURL=ClawdbotServicesTopicManager.js.map