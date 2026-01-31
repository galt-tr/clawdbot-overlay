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
export const PROTOCOL_ID = 'clawdbot-overlay-v1' as const

/** OP_RETURN prefix bytes (UTF-8 encoded protocol ID). */
export const PROTOCOL_PREFIX = new TextEncoder().encode(PROTOCOL_ID)

/** Topic names used by this overlay. */
export const TOPICS = {
  IDENTITY: 'tm_clawdbot_identity',
  SERVICES: 'tm_clawdbot_services',
} as const

/** Lookup service names. */
export const LOOKUP_SERVICES = {
  AGENTS: 'ls_clawdbot_agents',
  SERVICES: 'ls_clawdbot_services',
} as const

// ---------------------------------------------------------------------------
//  On-chain data: Identity
// ---------------------------------------------------------------------------

/**
 * Channel contact information for an agent.
 * Keys are channel names (e.g. "telegram", "discord"), values are handles.
 */
export interface AgentChannels {
  [channel: string]: string
}

/**
 * Identity payload embedded in an OP_RETURN output on the
 * `tm_clawdbot_identity` topic.
 */
export interface ClawdbotIdentityData {
  /** Must be "clawdbot-overlay-v1" */
  protocol: typeof PROTOCOL_ID
  /** Must be "identity" */
  type: 'identity'
  /** Compressed public key (hex, 33 bytes / 66 chars) of the agent */
  identityKey: string
  /** Human-readable agent name */
  name: string
  /** Short description of the agent's purpose */
  description: string
  /** Contact channels */
  channels: AgentChannels
  /** Capabilities the agent advertises (e.g. "research", "code-review") */
  capabilities: string[]
  /** ISO-8601 timestamp of publication */
  timestamp: string
}

// ---------------------------------------------------------------------------
//  On-chain data: Services
// ---------------------------------------------------------------------------

/** Pricing model for a service. */
export interface ServicePricing {
  /** e.g. "per-task", "per-hour", "subscription" */
  model: string
  /** Price in satoshis */
  amountSats: number
}

/**
 * Service catalog entry embedded in an OP_RETURN output on the
 * `tm_clawdbot_services` topic.
 */
export interface ClawdbotServiceData {
  /** Must be "clawdbot-overlay-v1" */
  protocol: typeof PROTOCOL_ID
  /** Must be "service" */
  type: 'service'
  /** Compressed public key of the agent offering the service */
  identityKey: string
  /** Unique identifier for this service offering */
  serviceId: string
  /** Human-readable name */
  name: string
  /** Description of what the service does */
  description: string
  /** Pricing details */
  pricing: ServicePricing
  /** ISO-8601 timestamp of publication */
  timestamp: string
}

/** Union of all overlay data payloads. */
export type ClawdbotOverlayData = ClawdbotIdentityData | ClawdbotServiceData

// ---------------------------------------------------------------------------
//  Lookup queries
// ---------------------------------------------------------------------------

/** Query for ls_clawdbot_agents. All fields optional — omit for "list all". */
export interface AgentLookupQuery {
  /** Filter by exact identity key */
  identityKey?: string
  /** Filter by agent name (case-insensitive substring) */
  name?: string
  /** Filter by capability */
  capability?: string
}

/** Query for ls_clawdbot_services. */
export interface ServiceLookupQuery {
  /** Filter by service type / serviceId */
  serviceType?: string
  /** Filter services cheaper than or equal to this amount */
  maxPriceSats?: number
  /** Filter by provider identity key */
  provider?: string
}

// ---------------------------------------------------------------------------
//  Indexed records (internal — used by lookup services' SQL storage)
// ---------------------------------------------------------------------------

/** Row stored by ClawdbotAgentLookupService. */
export interface AgentRecord {
  txid: string
  outputIndex: number
  identityKey: string
  name: string
  description: string
  channels: string          // JSON-encoded AgentChannels
  capabilities: string      // JSON-encoded string[]
  timestamp: string
  createdAt: string
}

/** Row stored by ClawdbotServiceLookupService. */
export interface ServiceRecord {
  txid: string
  outputIndex: number
  identityKey: string
  serviceId: string
  name: string
  description: string
  pricingModel: string
  pricingSats: number
  timestamp: string
  createdAt: string
}
