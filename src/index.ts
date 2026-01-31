/**
 * clawdbot-overlay — Main server entry point
 *
 * A BSV Overlay Network for Clawdbot agent-to-agent discovery and commerce.
 *
 * This server hosts two custom topics:
 *   - tm_clawdbot_identity: Agent identity records
 *   - tm_clawdbot_services: Agent service catalog entries
 *
 * And two lookup services:
 *   - ls_clawdbot_agents: Query agent identities
 *   - ls_clawdbot_services: Query service catalogs
 *
 * Powered by @bsv/overlay-express.
 */

import OverlayExpress from '@bsv/overlay-express'
import { ClawdbotIdentityTopicManager } from './topic-managers/ClawdbotIdentityTopicManager.js'
import { ClawdbotServicesTopicManager } from './topic-managers/ClawdbotServicesTopicManager.js'
import { createAgentLookupService } from './lookup-services/ClawdbotAgentLookupService.js'
import { createServiceLookupService } from './lookup-services/ClawdbotServiceLookupService.js'

async function main (): Promise<void> {
  // ---------------------------------------------------------------------------
  //  Configuration from environment
  // ---------------------------------------------------------------------------
  const privateKey = process.env.SERVER_PRIVATE_KEY
  if (!privateKey) {
    console.error('ERROR: SERVER_PRIVATE_KEY environment variable is required.')
    console.error('Generate one with: openssl rand -hex 32')
    process.exit(1)
  }

  // advertisableFQDN does NOT include "https://" — just the bare domain
  const hostingFQDN = process.env.HOSTING_FQDN ?? 'localhost:8080'
  const port = parseInt(process.env.PORT ?? '8080', 10)
  const network = (process.env.BSV_NETWORK ?? 'test') as 'main' | 'test'
  const mongoUrl = process.env.MONGO_URL ?? 'mongodb://localhost:27017'

  // ---------------------------------------------------------------------------
  //  Create the overlay server
  // ---------------------------------------------------------------------------
  const server = new OverlayExpress(
    'clawdbot-overlay',
    privateKey,
    hostingFQDN,
  )

  // ---------------------------------------------------------------------------
  //  Configure infrastructure
  // ---------------------------------------------------------------------------
  server.configurePort(port)
  server.configureNetwork(network)

  // Chain tracker: use 'scripts only' for local dev if no SPV is needed
  if (process.env.SCRIPTS_ONLY === 'true') {
    server.configureChainTracker('scripts only')
  }

  // ARC API key for transaction broadcasting
  if (process.env.ARC_API_KEY) {
    server.configureArcApiKey(process.env.ARC_API_KEY)
  }

  // Knex (SQL) database — SQLite for development, MySQL for production
  const knexConfig = process.env.DATABASE_URL
    ? process.env.DATABASE_URL            // MySQL connection string
    : {
        client: 'better-sqlite3',
        connection: { filename: './data/overlay.sqlite3' },
        useNullAsDefault: true,
      }
  await server.configureKnex(knexConfig as any)

  // MongoDB — required for SHIP/SLAP discovery
  try {
    await server.configureMongo(mongoUrl)
  } catch (e) {
    console.warn('⚠️  MongoDB not available — SHIP/SLAP discovery will be disabled.')
    console.warn('   Set MONGO_URL or start MongoDB to enable peer discovery.')
  }

  // ---------------------------------------------------------------------------
  //  Configure Clawdbot topic managers
  // ---------------------------------------------------------------------------
  server.configureTopicManager('tm_clawdbot_identity', new ClawdbotIdentityTopicManager())
  server.configureTopicManager('tm_clawdbot_services', new ClawdbotServicesTopicManager())

  // ---------------------------------------------------------------------------
  //  Configure Clawdbot lookup services (backed by Knex/SQL)
  // ---------------------------------------------------------------------------
  server.configureLookupServiceWithKnex('ls_clawdbot_agents', createAgentLookupService)
  server.configureLookupServiceWithKnex('ls_clawdbot_services', createServiceLookupService)

  // ---------------------------------------------------------------------------
  //  Configure engine (with SHIP/SLAP auto-configuration)
  // ---------------------------------------------------------------------------
  // autoConfigureShipSlap=true will add tm_ship, tm_slap, ls_ship, ls_slap
  // Set to false if MongoDB is not available
  const hasMongoDb = process.env.MONGO_URL !== undefined || mongoUrl !== undefined
  try {
    await server.configureEngine(hasMongoDb)
  } catch (e) {
    console.warn('⚠️  Engine configuration with SHIP/SLAP failed, retrying without...')
    await server.configureEngine(false)
  }

  // ---------------------------------------------------------------------------
  //  Start
  // ---------------------------------------------------------------------------
  await server.start()

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  🤖 Clawdbot Overlay Network')
  console.log(`  📡 Listening on port ${port}`)
  console.log(`  🌐 FQDN: https://${hostingFQDN}`)
  console.log(`  🔗 Network: ${network}`)
  console.log(`  🗂️  Topics: tm_clawdbot_identity, tm_clawdbot_services`)
  console.log(`  🔍 Lookup:  ls_clawdbot_agents, ls_clawdbot_services`)
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')
}

main().catch((err) => {
  console.error('Fatal error starting clawdbot-overlay:', err)
  process.exit(1)
})
