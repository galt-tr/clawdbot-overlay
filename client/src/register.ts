#!/usr/bin/env tsx
/**
 * Clawdbot Overlay Client — Register Agent & Advertise Services
 *
 * This script:
 *  1. Generates or loads a private key
 *  2. Builds an OP_RETURN transaction with the agent's identity data
 *  3. Submits it to the overlay under the tm_clawdbot_identity topic
 *  4. Builds a second OP_RETURN transaction for the jokes service
 *  5. Submits it under the tm_clawdbot_services topic
 *  6. Prints confirmation with txids
 *
 * Usage:
 *   npx tsx src/register.ts
 *
 * Environment variables (optional):
 *   AGENT_PRIVATE_KEY   — 64-char hex private key
 *   OVERLAY_URL         — Override overlay server URL
 *   AGENT_NAME          — Agent display name (default: "joke-bot")
 *   AGENT_DESCRIPTION   — Agent description
 */

import {
  loadOrCreatePrivateKey,
  getIdentityKey,
  buildOverlayTransaction,
  submitToOverlay,
  getOverlayUrl,
  PROTOCOL_ID,
  TOPICS,
  type ClawdbotIdentityData,
  type ClawdbotServiceData,
} from './utils.js'

async function main(): Promise<void> {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  🤖 Clawdbot Overlay — Agent Registration')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')

  // -----------------------------------------------------------------------
  //  Step 1: Load or create the agent's private key
  // -----------------------------------------------------------------------

  const privateKey = loadOrCreatePrivateKey()
  const identityKey = getIdentityKey(privateKey)

  console.log(`📡 Overlay:     ${getOverlayUrl()}`)
  console.log(`🔑 Identity:    ${identityKey}`)
  console.log('')

  // -----------------------------------------------------------------------
  //  Step 2: Register the agent identity
  // -----------------------------------------------------------------------

  const agentName = process.env.AGENT_NAME ?? 'joke-bot'
  const agentDesc = process.env.AGENT_DESCRIPTION
    ?? 'Tells random jokes for 5 satoshis. A sample Clawdbot overlay agent.'

  const identityPayload: ClawdbotIdentityData = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: agentName,
    description: agentDesc,
    channels: {
      overlay: getOverlayUrl(),
    },
    capabilities: ['jokes', 'entertainment'],
    timestamp: new Date().toISOString(),
  }

  console.log('📝 Building identity transaction...')
  const identityResult = buildOverlayTransaction(identityPayload, privateKey)

  console.log(`   txid: ${identityResult.txid}`)
  console.log(`   BEEF size: ${identityResult.beef.length} bytes`)
  console.log('')

  console.log('📤 Submitting identity to overlay...')
  try {
    const identitySteak = await submitToOverlay(
      identityResult.beef,
      [TOPICS.IDENTITY],
    )
    console.log('✅ Identity registered!')
    console.log('   STEAK response:', JSON.stringify(identitySteak, null, 2))
  } catch (err) {
    console.error('❌ Identity registration failed:', (err as Error).message)
    console.log('')
    console.log('💡 Make sure the overlay server is running with SCRIPTS_ONLY=true')
    console.log('   for demo transactions (synthetic funding). See README.md.')
    process.exit(1)
  }

  console.log('')

  // -----------------------------------------------------------------------
  //  Step 3: Advertise the jokes service
  // -----------------------------------------------------------------------

  const servicePayload: ClawdbotServiceData = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'tell-joke',
    name: 'Random Joke',
    description: 'Get a random joke. Guaranteed to be at least mildly amusing.',
    pricing: {
      model: 'per-task',
      amountSats: 5,
    },
    timestamp: new Date().toISOString(),
  }

  console.log('📝 Building service transaction...')
  const serviceResult = buildOverlayTransaction(servicePayload, privateKey)

  console.log(`   txid: ${serviceResult.txid}`)
  console.log(`   BEEF size: ${serviceResult.beef.length} bytes`)
  console.log('')

  console.log('📤 Submitting service to overlay...')
  try {
    const serviceSteak = await submitToOverlay(
      serviceResult.beef,
      [TOPICS.SERVICES],
    )
    console.log('✅ Service advertised!')
    console.log('   STEAK response:', JSON.stringify(serviceSteak, null, 2))
  } catch (err) {
    console.error('❌ Service advertisement failed:', (err as Error).message)
    process.exit(1)
  }

  // -----------------------------------------------------------------------
  //  Summary
  // -----------------------------------------------------------------------

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  ✅ Registration Complete!')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')
  console.log(`  Agent:    ${agentName}`)
  console.log(`  Key:      ${identityKey}`)
  console.log(`  Identity: ${identityResult.txid}`)
  console.log(`  Service:  ${serviceResult.txid}`)
  console.log('')
  console.log('  Next steps:')
  console.log('    npx tsx src/discover.ts        — Verify your registration')
  console.log('    npx tsx src/joke-server.ts      — Start the joke service')
  console.log('')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
