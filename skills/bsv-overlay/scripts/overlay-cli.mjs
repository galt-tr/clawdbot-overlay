#!/usr/bin/env node
/**
 * Clawdbot Overlay CLI — Discover agents/services & register on the overlay.
 *
 * Usage:
 *   node overlay-cli.mjs discover agents [--capability <cap>] [--name <name>] [--key <hex>]
 *   node overlay-cli.mjs discover services [--type <id>] [--max-price <sats>] [--provider <hex>]
 *   node overlay-cli.mjs register identity --name <n> --description <d> --capabilities <csv>
 *   node overlay-cli.mjs register service  --id <sid> --name <n> --description <d> --price <sats>
 *
 * Environment:
 *   OVERLAY_URL          — overlay server (default: http://162.243.168.235:8080)
 *   AGENT_PRIVATE_KEY    — 64-char hex private key (auto-generates if unset)
 *
 * Output: JSON  { success: true, data: {...} }  or  { success: false, error: "..." }
 */

// ---------------------------------------------------------------------------
//  Resolve @bsv/sdk — look in clawdbot-overlay/node_modules first
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Walk up to find the clawdbot-overlay repo root (has node_modules/@bsv/sdk)
function findRepoRoot() {
  let dir = __dirname
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'node_modules', '@bsv', 'sdk'))) return dir
    dir = dirname(dir)
  }
  return null
}

const repoRoot = findRepoRoot()
if (!repoRoot) {
  console.log(JSON.stringify({ success: false, error: '@bsv/sdk not found. Run setup.sh first or set NODE_PATH.' }))
  process.exit(1)
}

const require = createRequire(resolve(repoRoot, 'node_modules', '.package.json'))

// Dynamic import from the resolved path
const bsvSdkPathESM = resolve(repoRoot, 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js')

let BSV
try {
  BSV = await import(bsvSdkPathESM)
} catch {
  // Fallback: try via NODE_PATH / normal resolution
  try {
    BSV = await import('@bsv/sdk')
  } catch (e2) {
    console.log(JSON.stringify({ success: false, error: `Cannot load @bsv/sdk: ${e2.message}` }))
    process.exit(1)
  }
}

const { PrivateKey, Transaction, Script, P2PKH, MerklePath, Beef } = BSV

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------
const PROTOCOL_ID       = 'clawdbot-overlay-v1'
const OVERLAY_URL       = process.env.OVERLAY_URL || 'http://162.243.168.235:8080'
const TOPIC_IDENTITY    = 'tm_clawdbot_identity'
const TOPIC_SERVICES    = 'tm_clawdbot_services'
const LS_AGENTS         = 'ls_clawdbot_agents'
const LS_SERVICES       = 'ls_clawdbot_services'
const KEY_FILE          = resolve(repoRoot, '.agent-key')

// ---------------------------------------------------------------------------
//  Key helpers
// ---------------------------------------------------------------------------
function loadOrCreateKey() {
  const envKey = process.env.AGENT_PRIVATE_KEY
  if (envKey && envKey.length === 64) return PrivateKey.fromString(envKey, 16)

  if (existsSync(KEY_FILE)) {
    const hex = readFileSync(KEY_FILE, 'utf-8').trim()
    return PrivateKey.fromString(hex, 16)
  }

  const key = PrivateKey.fromRandom()
  writeFileSync(KEY_FILE, key.toHex(), 'utf-8')
  return key
}

function identityKeyOf(privKey) {
  return privKey.toPublicKey().toDER('hex')
}

// ---------------------------------------------------------------------------
//  OP_RETURN / Transaction building (mirrors utils.ts)
// ---------------------------------------------------------------------------
function buildOpReturn(payload) {
  const enc = new TextEncoder()
  const protocolBytes = Array.from(enc.encode(PROTOCOL_ID))
  const jsonBytes     = Array.from(enc.encode(JSON.stringify(payload)))

  const script = new Script()
  script.writeOpCode(0x00)  // OP_FALSE
  script.writeOpCode(0x6a)  // OP_RETURN
  script.writeBin(protocolBytes)
  script.writeBin(jsonBytes)
  return script
}

async function buildOverlayTx(payload, privKey) {
  const pubKey     = privKey.toPublicKey()
  const pubKeyHashHex = pubKey.toHash('hex')
  // P2PKH.lock() expects number[] bytes, not hex string
  const pubKeyHash = Array.from(Buffer.from(pubKeyHashHex, 'hex'))

  // Synthetic funding tx
  const fundingTx = new Transaction()
  fundingTx.addOutput({ lockingScript: new P2PKH().lock(pubKeyHash), satoshis: 1000 })

  const fundingTxid = fundingTx.id('hex')
  // Two-leaf merkle path (txid + sibling) — survives BEEF round-trip better
  // than the duplicate-flag approach in @bsv/sdk v1.10+
  const siblingHash = fundingTxid.split('').reverse().join('')  // deterministic but different
  fundingTx.merklePath = new MerklePath(1, [
    [{ offset: 0, hash: fundingTxid, txid: true }, { offset: 1, hash: siblingHash }],
  ])

  // OP_RETURN tx
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  })
  tx.addOutput({ lockingScript: buildOpReturn(payload), satoshis: 0 })
  await tx.sign()

  // Use Beef class for V2 format (0200beef) — overlay-express requires V2
  const beef = new Beef()
  beef.mergeTransaction(fundingTx)
  beef.mergeTransaction(tx)
  return { beef: beef.toBinary(), txid: tx.id('hex') }
}

// ---------------------------------------------------------------------------
//  HTTP helpers
// ---------------------------------------------------------------------------
async function overlaySubmit(beefData, topics) {
  const url = `${OVERLAY_URL}/submit`
  const bytes = new Uint8Array(beefData)
  if (process.env.OVERLAY_DEBUG) {
    process.stderr.write(`DEBUG submit: ${bytes.length} bytes, first4=[${bytes[0]},${bytes[1]},${bytes[2]},${bytes[3]}]\n`)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Topics': JSON.stringify(topics),
    },
    body: bytes,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`submit ${res.status}: ${body}`)
  }
  return res.json()
}

async function overlayLookup(service, query = {}) {
  const url = `${OVERLAY_URL}/lookup`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, query }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`lookup ${res.status}: ${body}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
//  Parsing BEEF outputs
// ---------------------------------------------------------------------------
/**
 * Extract data pushes from OP_RETURN chunks.
 * Handles both legacy 4-chunk and collapsed 2-chunk (@bsv/sdk v1.10+) formats.
 */
function extractOpReturnPushes(chunks) {
  // Legacy 4+ chunk format
  if (chunks.length >= 4 && chunks[0].op === 0x00 && chunks[1].op === 0x6a) {
    return chunks.slice(2).filter(c => c.data).map(c => new Uint8Array(c.data))
  }

  // Collapsed 2-chunk format: OP_FALSE, OP_RETURN(data blob)
  if (chunks.length === 2 && chunks[0].op === 0x00 && chunks[1].op === 0x6a && chunks[1].data) {
    const blob = chunks[1].data
    const pushes = []
    let pos = 0
    while (pos < blob.length) {
      const op = blob[pos++]
      if (op > 0 && op <= 75) {
        pushes.push(new Uint8Array(blob.slice(pos, pos + op)))
        pos += op
      } else if (op === 0x4c) {
        const len = blob[pos++] || 0
        pushes.push(new Uint8Array(blob.slice(pos, pos + len)))
        pos += len
      } else if (op === 0x4d) {
        const len = (blob[pos] || 0) | ((blob[pos + 1] || 0) << 8)
        pos += 2
        pushes.push(new Uint8Array(blob.slice(pos, pos + len)))
        pos += len
      } else {
        break
      }
    }
    return pushes.length >= 2 ? pushes : null
  }

  return null
}

function parseOverlayOutput(beef, outputIndex) {
  try {
    const tx     = Transaction.fromBEEF(beef)
    const output = tx.outputs[outputIndex]
    if (!output?.lockingScript) return null

    const pushes = extractOpReturnPushes(output.lockingScript.chunks)
    if (!pushes || pushes.length < 2) return null

    const protocolStr = new TextDecoder().decode(pushes[0])
    if (protocolStr !== PROTOCOL_ID) return null

    const payload = JSON.parse(new TextDecoder().decode(pushes[1]))

    // Attach txid for convenience
    try { payload._txid = tx.id('hex') } catch {}

    return payload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
//  CLI argument parser
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2)
  const positional = []
  const flags = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      const val = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : 'true'
      flags[key] = val
    } else {
      positional.push(args[i])
    }
  }
  return { positional, flags }
}

// ---------------------------------------------------------------------------
//  Commands
// ---------------------------------------------------------------------------

// ---- DISCOVER -------------------------------------------------------------
async function cmdDiscover(subCmd, flags) {
  if (subCmd === 'agents') {
    const query = {}
    if (flags.capability) query.capability = flags.capability
    if (flags.name)       query.name       = flags.name
    if (flags.key)        query.identityKey = flags.key

    const result = await overlayLookup(LS_AGENTS, query)
    const agents = []
    for (const out of (result.outputs || [])) {
      const data = parseOverlayOutput(out.beef, out.outputIndex)
      if (data && data.type === 'identity') agents.push(data)
    }
    return { agents, count: agents.length, query }
  }

  if (subCmd === 'services') {
    const query = {}
    if (flags.type)        query.serviceType  = flags.type
    if (flags['max-price']) query.maxPriceSats = parseInt(flags['max-price'], 10)
    if (flags.provider)    query.provider      = flags.provider

    const result = await overlayLookup(LS_SERVICES, query)
    const services = []
    for (const out of (result.outputs || [])) {
      const data = parseOverlayOutput(out.beef, out.outputIndex)
      if (data && data.type === 'service') services.push(data)
    }
    return { services, count: services.length, query }
  }

  throw new Error(`Unknown discover target: ${subCmd}. Use "agents" or "services".`)
}

// ---- REGISTER -------------------------------------------------------------
async function cmdRegister(subCmd, flags) {
  const privKey     = loadOrCreateKey()
  const idKey       = identityKeyOf(privKey)

  if (subCmd === 'identity') {
    if (!flags.name) throw new Error('--name is required')

    const payload = {
      protocol: PROTOCOL_ID,
      type: 'identity',
      identityKey: idKey,
      name: flags.name,
      description: flags.description || '',
      channels: flags.channels ? JSON.parse(flags.channels) : { overlay: OVERLAY_URL },
      capabilities: flags.capabilities ? flags.capabilities.split(',').map(s => s.trim()) : [],
      timestamp: new Date().toISOString(),
    }

    const { beef, txid } = await buildOverlayTx(payload, privKey)
    const steak = await overlaySubmit(beef, [TOPIC_IDENTITY])
    return { txid, identityKey: idKey, payload, steak }
  }

  if (subCmd === 'service') {
    if (!flags.id)   throw new Error('--id is required')
    if (!flags.name) throw new Error('--name is required')

    const payload = {
      protocol: PROTOCOL_ID,
      type: 'service',
      identityKey: idKey,
      serviceId: flags.id,
      name: flags.name,
      description: flags.description || '',
      pricing: {
        model: flags.model || 'per-task',
        amountSats: parseInt(flags.price || '0', 10),
      },
      timestamp: new Date().toISOString(),
    }

    const { beef, txid } = await buildOverlayTx(payload, privKey)
    const steak = await overlaySubmit(beef, [TOPIC_SERVICES])
    return { txid, identityKey: idKey, payload, steak }
  }

  throw new Error(`Unknown register target: ${subCmd}. Use "identity" or "service".`)
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------
async function main() {
  const { positional, flags } = parseArgs()

  if (positional.length === 0 || flags.help) {
    console.log(JSON.stringify({
      success: true,
      data: {
        usage: [
          'discover agents [--capability <cap>] [--name <name>] [--key <hex>]',
          'discover services [--type <id>] [--max-price <sats>] [--provider <hex>]',
          'register identity --name <n> --description <d> --capabilities <csv>',
          'register service  --id <sid> --name <n> --description <d> --price <sats>',
        ],
        overlayUrl: OVERLAY_URL,
      },
    }))
    return
  }

  const cmd    = positional[0]
  const subCmd = positional[1]

  if (!subCmd) throw new Error(`Missing subcommand for "${cmd}". Example: ${cmd} agents`)

  let data
  if (cmd === 'discover') {
    data = await cmdDiscover(subCmd, flags)
  } else if (cmd === 'register') {
    data = await cmdRegister(subCmd, flags)
  } else {
    throw new Error(`Unknown command: ${cmd}. Use "discover" or "register".`)
  }

  console.log(JSON.stringify({ success: true, data }))
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message || String(err) }))
  process.exit(1)
})
