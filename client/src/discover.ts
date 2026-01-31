#!/usr/bin/env tsx
/**
 * Clawdbot Overlay Client — Discover Agents & Services
 *
 * Queries the overlay to find registered agents and available services.
 * Demonstrates all lookup service query capabilities.
 *
 * Usage:
 *   npx tsx src/discover.ts                    — List all agents and services
 *   npx tsx src/discover.ts agents             — List agents only
 *   npx tsx src/discover.ts services           — List services only
 *   npx tsx src/discover.ts agents --name bot  — Search agents by name
 *   npx tsx src/discover.ts agents --cap jokes — Search agents by capability
 *   npx tsx src/discover.ts services --max 10  — Services under 10 sats
 *   npx tsx src/discover.ts services --type tell-joke  — By service ID
 *
 * Environment variables:
 *   OVERLAY_URL — Override overlay server URL
 */

import { Transaction } from '@bsv/sdk'
import {
  lookupOverlay,
  parseOverlayOutput,
  printIdentity,
  printService,
  getOverlayUrl,
  LOOKUP_SERVICES,
  type ClawdbotIdentityData,
  type ClawdbotServiceData,
  type LookupResponse,
  type AgentLookupQuery,
  type ServiceLookupQuery,
} from './utils.js'

// ---------------------------------------------------------------------------
//  CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  mode: 'all' | 'agents' | 'services'
  agentQuery: AgentLookupQuery
  serviceQuery: ServiceLookupQuery
} {
  const args = process.argv.slice(2)
  let mode: 'all' | 'agents' | 'services' = 'all'
  const agentQuery: AgentLookupQuery = {}
  const serviceQuery: ServiceLookupQuery = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === 'agents') {
      mode = 'agents'
    } else if (arg === 'services') {
      mode = 'services'
    } else if (arg === '--name' && args[i + 1]) {
      agentQuery.name = args[++i]
    } else if (arg === '--cap' && args[i + 1]) {
      agentQuery.capability = args[++i]
    } else if (arg === '--key' && args[i + 1]) {
      agentQuery.identityKey = args[++i]
      serviceQuery.provider = args[++i - 1] // same key for provider search
    } else if (arg === '--type' && args[i + 1]) {
      serviceQuery.serviceType = args[++i]
    } else if (arg === '--max' && args[i + 1]) {
      serviceQuery.maxPriceSats = parseInt(args[++i], 10)
    } else if (arg === '--provider' && args[i + 1]) {
      serviceQuery.provider = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { mode, agentQuery, serviceQuery }
}

function printHelp(): void {
  console.log(`
Clawdbot Overlay Discovery

Usage:
  npx tsx src/discover.ts [mode] [options]

Modes:
  agents     Query agent identities only
  services   Query service catalog only
  (omit)     Query both agents and services

Agent Options:
  --name <str>    Filter by name (substring match)
  --cap <str>     Filter by capability
  --key <hex>     Filter by identity key

Service Options:
  --type <str>      Filter by service ID
  --max <number>    Max price in satoshis
  --provider <hex>  Filter by provider identity key

Examples:
  npx tsx src/discover.ts                        # List everything
  npx tsx src/discover.ts agents --cap jokes      # Find joke-capable agents
  npx tsx src/discover.ts services --max 100      # Services under 100 sats
`)
}

// ---------------------------------------------------------------------------
//  Discovery functions
// ---------------------------------------------------------------------------

/**
 * Discover agents on the overlay.
 */
async function discoverAgents(query: AgentLookupQuery): Promise<void> {
  const hasFilters = Object.keys(query).length > 0

  console.log('')
  console.log('🤖 Agents' + (hasFilters ? ` (filtered: ${JSON.stringify(query)})` : ''))
  console.log('─'.repeat(55))

  try {
    const result = await lookupOverlay(
      LOOKUP_SERVICES.AGENTS,
      query as unknown as Record<string, unknown>,
    )

    if (result.outputs.length === 0) {
      console.log('  (no agents found)')
      return
    }

    console.log(`  Found ${result.outputs.length} agent(s):\n`)

    for (const output of result.outputs) {
      const data = parseOverlayOutput(output.beef, output.outputIndex)
      if (data && data.type === 'identity') {
        // Extract txid from the BEEF
        let txid: string | undefined
        try {
          const tx = Transaction.fromBEEF(output.beef)
          txid = tx.id('hex')
        } catch {
          // ignore
        }
        printIdentity(data as ClawdbotIdentityData, txid)
      }
    }
  } catch (err) {
    console.error(`  ❌ Error: ${(err as Error).message}`)
  }
}

/**
 * Discover services on the overlay.
 */
async function discoverServices(query: ServiceLookupQuery): Promise<void> {
  const hasFilters = Object.keys(query).length > 0

  console.log('')
  console.log('⚡ Services' + (hasFilters ? ` (filtered: ${JSON.stringify(query)})` : ''))
  console.log('─'.repeat(55))

  try {
    const result = await lookupOverlay(
      LOOKUP_SERVICES.SERVICES,
      query as unknown as Record<string, unknown>,
    )

    if (result.outputs.length === 0) {
      console.log('  (no services found)')
      return
    }

    console.log(`  Found ${result.outputs.length} service(s):\n`)

    for (const output of result.outputs) {
      const data = parseOverlayOutput(output.beef, output.outputIndex)
      if (data && data.type === 'service') {
        let txid: string | undefined
        try {
          const tx = Transaction.fromBEEF(output.beef)
          txid = tx.id('hex')
        } catch {
          // ignore
        }
        printService(data as ClawdbotServiceData, txid)
      }
    }
  } catch (err) {
    console.error(`  ❌ Error: ${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { mode, agentQuery, serviceQuery } = parseArgs()

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  🔍 Clawdbot Overlay — Discovery')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  📡 Overlay: ${getOverlayUrl()}`)

  if (mode === 'all' || mode === 'agents') {
    await discoverAgents(agentQuery)
  }

  if (mode === 'all' || mode === 'services') {
    await discoverServices(serviceQuery)
  }

  console.log('')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
