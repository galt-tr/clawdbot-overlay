/**
 * clawdbot-overlay — Type definitions
 *
 * All data structures for the Clawdbot Overlay Network.
 * These types define the on-chain data formats embedded in OP_RETURN outputs,
 * as well as the query/response shapes used by lookup services.
 */
// ---------------------------------------------------------------------------
//  Protocol constants
// ---------------------------------------------------------------------------
/** Protocol identifier embedded in every Clawdbot overlay output. */
export const PROTOCOL_ID = 'clawdbot-overlay-v1';
/** OP_RETURN prefix bytes (UTF-8 encoded protocol ID). */
export const PROTOCOL_PREFIX = new TextEncoder().encode(PROTOCOL_ID);
/** Topic names used by this overlay. */
export const TOPICS = {
    IDENTITY: 'tm_clawdbot_identity',
    SERVICES: 'tm_clawdbot_services',
};
/** Lookup service names. */
export const LOOKUP_SERVICES = {
    AGENTS: 'ls_clawdbot_agents',
    SERVICES: 'ls_clawdbot_services',
};
//# sourceMappingURL=types.js.map