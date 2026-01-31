/**
 * Clawdbot Overlay Client — Shared Utilities
 *
 * Helpers for building OP_RETURN transactions, submitting to the overlay,
 * and querying lookup services. This is the core "SDK" that register.ts,
 * discover.ts, and joke-server.ts all depend on.
 */

import {
  PrivateKey,
  Transaction,
  Script,
  P2PKH,
  Beef,
  MerklePath,
  Hash,
} from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

/** Protocol identifier — must match the overlay server exactly. */
export const PROTOCOL_ID = 'clawdbot-overlay-v1'

/** Topic names recognized by the overlay. */
export const TOPICS = {
  IDENTITY: 'tm_clawdbot_identity',
  SERVICES: 'tm_clawdbot_services',
} as const

/** Lookup service names for querying. */
export const LOOKUP_SERVICES = {
  AGENTS: 'ls_clawdbot_agents',
  SERVICES: 'ls_clawdbot_services',
} as const

/** Default overlay URL. */
export const DEFAULT_OVERLAY_URL = 'http://162.243.168.235:8080'

// ---------------------------------------------------------------------------
//  Type definitions (matching the overlay server's types.ts)
// ---------------------------------------------------------------------------

export interface AgentChannels {
  [channel: string]: string
}

export interface ClawdbotIdentityData {
  protocol: typeof PROTOCOL_ID
  type: 'identity'
  identityKey: string
  name: string
  description: string
  channels: AgentChannels
  capabilities: string[]
  timestamp: string
}

export interface ServicePricing {
  model: string
  amountSats: number
}

export interface ClawdbotServiceData {
  protocol: typeof PROTOCOL_ID
  type: 'service'
  identityKey: string
  serviceId: string
  name: string
  description: string
  pricing: ServicePricing
  timestamp: string
}

export type ClawdbotOverlayData = ClawdbotIdentityData | ClawdbotServiceData

/** Query shape for ls_clawdbot_agents. */
export interface AgentLookupQuery {
  identityKey?: string
  name?: string
  capability?: string
}

/** Query shape for ls_clawdbot_services. */
export interface ServiceLookupQuery {
  serviceType?: string
  maxPriceSats?: number
  provider?: string
}

/** A single output returned by a lookup response. */
export interface LookupOutput {
  beef: number[]
  outputIndex: number
  context?: string
}

/** The full response from POST /lookup. */
export interface LookupResponse {
  type: 'output-list'
  outputs: LookupOutput[]
}

/** STEAK — Submit Transaction Execution Acknowledgment. */
export interface SteakResponse {
  [topic: string]: {
    outputsToAdmit: number[]
    coinsToRetain: number[]
  }
}

// ---------------------------------------------------------------------------
//  Key management
// ---------------------------------------------------------------------------

const KEY_FILE = '.agent-key'

/**
 * Load a private key from the environment, a file, or generate a fresh one.
 *
 * Priority:
 *  1. AGENT_PRIVATE_KEY env var (64-char hex)
 *  2. .agent-key file in the working directory
 *  3. Generate a new key and save it to .agent-key
 */
export function loadOrCreatePrivateKey(): PrivateKey {
  // 1. From environment
  const envKey = process.env.AGENT_PRIVATE_KEY
  if (envKey && envKey.length === 64) {
    return PrivateKey.fromString(envKey, 16)
  }

  // 2. From file
  if (existsSync(KEY_FILE)) {
    const hex = readFileSync(KEY_FILE, 'utf-8').trim()
    console.log(`🔑 Loaded private key from ${KEY_FILE}`)
    return PrivateKey.fromString(hex, 16)
  }

  // 3. Generate new
  const key = PrivateKey.fromRandom()
  const hex = key.toHex()
  writeFileSync(KEY_FILE, hex, 'utf-8')
  console.log(`🔑 Generated new private key → saved to ${KEY_FILE}`)
  console.log(`   Public key: ${key.toPublicKey().toDER('hex')}`)
  return key
}

/**
 * Derive the compressed public key (hex) from a private key.
 */
export function getIdentityKey(privateKey: PrivateKey): string {
  return privateKey.toPublicKey().toDER('hex') as string
}

// ---------------------------------------------------------------------------
//  OP_RETURN script construction
// ---------------------------------------------------------------------------

/**
 * Build an OP_FALSE OP_RETURN script with the Clawdbot protocol prefix
 * and a JSON payload.
 *
 * Output format:
 *   OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON string>
 *
 * This is the on-chain format that the overlay's topic managers parse.
 */
export function buildOpReturnScript(payload: ClawdbotOverlayData): Script {
  const protocolBytes = Array.from(new TextEncoder().encode(PROTOCOL_ID))
  const jsonBytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)))

  const script = new Script()
  script.writeOpCode(0x00)   // OP_FALSE (0x00)
  script.writeOpCode(0x6a)   // OP_RETURN (0x6a)
  script.writeBin(protocolBytes)
  script.writeBin(jsonBytes)

  return script
}

// ---------------------------------------------------------------------------
//  Transaction construction
// ---------------------------------------------------------------------------

/**
 * Build a BEEF-encoded transaction containing an OP_RETURN output.
 *
 * Because OP_RETURN outputs are unspendable, the transaction needs a valid
 * structure to pass the overlay's SPV verification. The approach:
 *
 *  1. Create a "funding" source transaction with a P2PKH output to our key
 *  2. Attach a synthetic MerklePath (works when server uses SCRIPTS_ONLY=true)
 *  3. Build the real OP_RETURN transaction spending from the funding tx
 *  4. Sign it properly
 *  5. Encode both transactions in BEEF format
 *
 * For production use, you would replace the funding tx with a real funded UTXO
 * from the blockchain. See README.md for details.
 *
 * @param payload  The identity or service data to embed
 * @param privateKey  The agent's private key (for signing)
 * @returns Binary BEEF data ready to POST to /submit
 */
export function buildOverlayTransaction(
  payload: ClawdbotOverlayData,
  privateKey: PrivateKey,
): { beef: number[]; txid: string } {
  const pubKey = privateKey.toPublicKey()
  const pubKeyHash = pubKey.toHash('hex') as string

  // --- Step 1: Create a synthetic funding transaction ---
  // In production, this would be a real on-chain UTXO you own.
  // For the overlay demo (SCRIPTS_ONLY mode), we create a self-funding tx.
  const fundingTx = new Transaction()
  fundingTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 1000,
  })

  // Attach a synthetic merkle path so it passes scripts-only SPV check.
  // The MerklePath says: "this tx was in block 1, at position 0, and it's
  // the only tx in its pair (duplicate)."
  const fundingTxid = fundingTx.id('hex')
  fundingTx.merklePath = new MerklePath(1, [[
    { offset: 0, hash: fundingTxid, txid: true, duplicate: true },
  ]])

  // --- Step 2: Build the OP_RETURN transaction ---
  const opReturnScript = buildOpReturnScript(payload)

  const tx = new Transaction()

  tx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privateKey),
    sequence: 0xffffffff,
  })

  tx.addOutput({
    lockingScript: opReturnScript,
    satoshis: 0,
  })

  // --- Step 3: Sign ---
  tx.sign()

  // --- Step 4: Encode as BEEF ---
  // toBEEF() serializes the transaction with its source transaction chain
  // into the BEEF binary format (BRC-62).
  const beef = tx.toBEEF()
  const txid = tx.id('hex')

  return { beef, txid }
}

// ---------------------------------------------------------------------------
//  HTTP helpers — submit and lookup
// ---------------------------------------------------------------------------

/**
 * Get the overlay URL from environment or default.
 */
export function getOverlayUrl(): string {
  return process.env.OVERLAY_URL ?? DEFAULT_OVERLAY_URL
}

/**
 * Submit a BEEF-encoded transaction to the overlay.
 *
 * POST /submit
 * Headers:
 *   Content-Type: application/octet-stream
 *   X-Topics: ["tm_clawdbot_identity"] (JSON array)
 * Body: raw BEEF bytes
 *
 * @param beefData  Binary BEEF data (number[])
 * @param topics    Array of topic names to tag the transaction with
 * @returns STEAK response (topic → admittance results)
 */
export async function submitToOverlay(
  beefData: number[],
  topics: string[],
): Promise<SteakResponse> {
  const url = `${getOverlayUrl()}/submit`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Topics': JSON.stringify(topics),
    },
    body: new Uint8Array(beefData),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Overlay submit failed (${response.status}): ${body}`)
  }

  return await response.json() as SteakResponse
}

/**
 * Query the overlay via a lookup service.
 *
 * POST /lookup
 * Headers:
 *   Content-Type: application/json
 * Body: { "service": "ls_clawdbot_agents", "query": { ... } }
 *
 * @param service  Lookup service name (ls_clawdbot_agents | ls_clawdbot_services)
 * @param query    Query parameters (all optional — omit for "list all")
 * @returns LookupResponse with BEEF-encoded outputs
 */
export async function lookupOverlay(
  service: string,
  query: Record<string, unknown> = {},
): Promise<LookupResponse> {
  const url = `${getOverlayUrl()}/lookup`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ service, query }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Overlay lookup failed (${response.status}): ${body}`)
  }

  return await response.json() as LookupResponse
}

// ---------------------------------------------------------------------------
//  Parsing lookup results
// ---------------------------------------------------------------------------

/**
 * Parse a Clawdbot OP_RETURN output from BEEF data returned by a lookup.
 *
 * The lookup response contains BEEF-encoded transactions. Each output
 * pointed to by outputIndex contains our protocol data. This function
 * decodes the BEEF, finds the output, and extracts the JSON payload.
 *
 * @param beef         BEEF binary data (number[])
 * @param outputIndex  Which output to read
 * @returns The decoded payload, or null if it's not a valid Clawdbot output
 */
export function parseOverlayOutput(
  beef: number[],
  outputIndex: number,
): ClawdbotOverlayData | null {
  try {
    const tx = Transaction.fromBEEF(beef)
    const output = tx.outputs[outputIndex]
    if (!output?.lockingScript) return null

    const chunks = output.lockingScript.chunks
    if (chunks.length < 4) return null

    // OP_FALSE (0x00)
    if (chunks[0].op !== 0x00) return null
    // OP_RETURN (0x6a)
    if (chunks[1].op !== 0x6a) return null

    // Protocol prefix
    const protocolChunk = chunks[2]
    if (!protocolChunk.data) return null
    const protocolStr = new TextDecoder().decode(new Uint8Array(protocolChunk.data))
    if (protocolStr !== PROTOCOL_ID) return null

    // JSON payload
    const payloadChunk = chunks[3]
    if (!payloadChunk.data) return null
    const payload = JSON.parse(
      new TextDecoder().decode(new Uint8Array(payloadChunk.data))
    ) as ClawdbotOverlayData

    return payload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
//  Pretty-printing
// ---------------------------------------------------------------------------

/**
 * Pretty-print an identity record to the console.
 */
export function printIdentity(data: ClawdbotIdentityData, txid?: string): void {
  console.log('┌─────────────────────────────────────────────────────')
  console.log(`│ 🤖 ${data.name}`)
  if (txid) {
    console.log(`│ 📋 txid: ${txid}`)
  }
  console.log(`│ 🔑 ${data.identityKey}`)
  console.log(`│ 📝 ${data.description}`)
  if (data.capabilities.length > 0) {
    console.log(`│ 🎯 Capabilities: ${data.capabilities.join(', ')}`)
  }
  if (Object.keys(data.channels).length > 0) {
    console.log(`│ 📡 Channels:`)
    for (const [ch, val] of Object.entries(data.channels)) {
      console.log(`│    ${ch}: ${val}`)
    }
  }
  console.log(`│ 🕐 ${data.timestamp}`)
  console.log('└─────────────────────────────────────────────────────')
}

/**
 * Pretty-print a service record to the console.
 */
export function printService(data: ClawdbotServiceData, txid?: string): void {
  console.log('┌─────────────────────────────────────────────────────')
  console.log(`│ ⚡ ${data.name} (${data.serviceId})`)
  if (txid) {
    console.log(`│ 📋 txid: ${txid}`)
  }
  console.log(`│ 🔑 Provider: ${data.identityKey}`)
  console.log(`│ 📝 ${data.description}`)
  console.log(`│ 💰 ${data.pricing.amountSats} sats (${data.pricing.model})`)
  console.log(`│ 🕐 ${data.timestamp}`)
  console.log('└─────────────────────────────────────────────────────')
}
