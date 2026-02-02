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
import { MessageRelay, setupWebSocket, notifySubscriber, getSubscriberStats } from './relay.js'
import express from 'express'
import type { Request, Response } from 'express'
import type http from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const startTime = Date.now()

/** Validate a compressed public key (02/03 + 64 hex chars). */
function isValidCompressedPubKey (hex: string): boolean {
  return typeof hex === 'string' && /^0[23][0-9a-fA-F]{64}$/.test(hex)
}

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

  const hostingFQDN = process.env.HOSTING_FQDN ?? 'localhost:8080'
  const port = parseInt(process.env.PORT ?? '8080', 10)
  const rawNetwork = process.env.BSV_NETWORK ?? 'test'
  const network = (rawNetwork === 'mainnet' ? 'main' : rawNetwork === 'testnet' ? 'test' : rawNetwork) as 'main' | 'test'
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

  if (process.env.SCRIPTS_ONLY === 'true') {
    server.configureChainTracker('scripts only')
  }

  if (process.env.ARC_API_KEY) {
    server.configureArcApiKey(process.env.ARC_API_KEY)
  }

  const knexConfig = process.env.DATABASE_URL
    ? process.env.DATABASE_URL
    : {
        client: 'better-sqlite3',
        connection: { filename: './data/overlay.sqlite3' },
        useNullAsDefault: true,
      }
  await server.configureKnex(knexConfig as any)

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
  // Disable SHIP/SLAP sync for private overlay — saves RAM and prevents
  // slow GASP sync blocking startup on resource-constrained hosts.
  const enableShipSlap = process.env.ENABLE_SHIP_SLAP === 'true'
  try {
    await server.configureEngine(enableShipSlap)
  } catch (e) {
    console.warn('⚠️  Engine configuration failed, retrying without SHIP/SLAP...')
    await server.configureEngine(false)
  }

  // ---------------------------------------------------------------------------
  //  Message Relay — initialise BEFORE routes
  // ---------------------------------------------------------------------------
  const knex = server.knex
  const relay = new MessageRelay(knex)
  await relay.init()
  console.log('📬 Message relay initialised')

  // ---------------------------------------------------------------------------
  //  Add JSON body parsing for our custom routes
  //  (overlay-express adds body parsers inside start(), which is too late
  //   for routes registered here — so we add our own for /relay and /api)
  // ---------------------------------------------------------------------------
  const jsonParser = express.json({ limit: '1mb' })

  // ---------------------------------------------------------------------------
  //  CORS helper for relay endpoints
  // ---------------------------------------------------------------------------
  function relayCors (_req: Request, res: Response, next: () => void): void {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type')
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  }

  // ---------------------------------------------------------------------------
  //  Relay API endpoints
  // ---------------------------------------------------------------------------

  // POST /relay/send — Store a message for another agent
  server.app.options('/relay/send', relayCors)
  server.app.post('/relay/send', relayCors, jsonParser, async (req: Request, res: Response) => {
    try {
      const { to, from, type, payload, signature } = req.body ?? {}

      if (!isValidCompressedPubKey(to)) {
        return res.status(400).json({ error: 'Invalid or missing "to" — must be a compressed pubkey (66 hex chars, 02/03 prefix)' })
      }
      if (!isValidCompressedPubKey(from)) {
        return res.status(400).json({ error: 'Invalid or missing "from" — must be a compressed pubkey (66 hex chars, 02/03 prefix)' })
      }
      if (!type || typeof type !== 'string') {
        return res.status(400).json({ error: '"type" is required and must be a non-empty string' })
      }
      if (payload === undefined || payload === null || typeof payload !== 'object') {
        return res.status(400).json({ error: '"payload" is required and must be an object' })
      }

      const result = await relay.storeMessage({ from, to, type, payload, signature })

      // Push to WebSocket subscriber if connected
      const pushed = notifySubscriber(to, {
        id: result.id,
        from,
        to,
        type,
        payload,
        signature: signature || null,
        timestamp: Date.now(),
      })

      res.json({ ...result, pushed })
    } catch (err: any) {
      console.error('Relay send error:', err)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /relay/inbox — Fetch unread messages for an agent
  server.app.options('/relay/inbox', relayCors)
  server.app.get('/relay/inbox', relayCors, async (req: Request, res: Response) => {
    try {
      const identity = req.query.identity as string
      if (!isValidCompressedPubKey(identity)) {
        return res.status(400).json({ error: 'Query param "identity" is required and must be a valid compressed pubkey' })
      }
      const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50

      const messages = await relay.getInbox(identity, since, limit)
      res.json({ messages, count: messages.length })
    } catch (err: any) {
      console.error('Relay inbox error:', err)
      res.status(500).json({ error: err.message })
    }
  })

  // POST /relay/ack — Mark messages as read
  server.app.options('/relay/ack', relayCors)
  server.app.post('/relay/ack', relayCors, jsonParser, async (req: Request, res: Response) => {
    try {
      const { identity, messageIds } = req.body ?? {}
      if (!isValidCompressedPubKey(identity)) {
        return res.status(400).json({ error: '"identity" is required and must be a valid compressed pubkey' })
      }
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return res.status(400).json({ error: '"messageIds" must be a non-empty array of message IDs' })
      }
      const acked = await relay.ackMessages(identity, messageIds)
      res.json({ acked })
    } catch (err: any) {
      console.error('Relay ack error:', err)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /relay/stats — Relay statistics (includes WebSocket stats)
  server.app.options('/relay/stats', relayCors)
  server.app.get('/relay/stats', relayCors, async (_req: Request, res: Response) => {
    try {
      const stats = await relay.getStats()
      const wsStats = getSubscriberStats()
      res.json({ ...stats, websocket: wsStats })
    } catch (err: any) {
      console.error('Relay stats error:', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ---------------------------------------------------------------------------
  //  Dashboard API endpoints (registered BEFORE start() to take precedence)
  // ---------------------------------------------------------------------------

  server.app.get('/api/agents', async (_req: Request, res: Response) => {
    try {
      // Deduplicate: keep only the latest entry per identityKey
      const agentSubq = knex('clawdbot_agents')
        .select('identityKey')
        .max('createdAt as maxCreatedAt')
        .groupBy('identityKey')
        .as('latest')
      const rows = await knex('clawdbot_agents as a')
        .select('a.identityKey', 'a.name', 'a.description', 'a.channels', 'a.capabilities', 'a.timestamp', 'a.createdAt')
        .innerJoin(agentSubq, function () {
          this.on('a.identityKey', '=', 'latest.identityKey')
            .andOn('a.createdAt', '=', 'latest.maxCreatedAt')
        })
        .orderBy('a.createdAt', 'desc')
        .limit(200)
      const agents = rows.map((r: any) => ({
        identityKey: r.identityKey,
        name: r.name,
        description: r.description,
        channels: safeJsonParse(r.channels, {}),
        capabilities: safeJsonParse(r.capabilities, []),
        timestamp: r.timestamp,
        createdAt: r.createdAt,
      }))
      res.json(agents)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  server.app.get('/api/services', async (_req: Request, res: Response) => {
    try {
      // Deduplicate: keep only the latest entry per (identityKey, serviceId)
      const subq = knex('clawdbot_services')
        .select('identityKey', 'serviceId')
        .max('createdAt as maxCreatedAt')
        .groupBy('identityKey', 'serviceId')
        .as('latest')
      const rows = await knex('clawdbot_services as s')
        .select('s.identityKey', 's.serviceId', 's.name', 's.description', 's.pricingModel', 's.pricingSats', 's.timestamp', 's.createdAt')
        .innerJoin(subq, function () {
          this.on('s.identityKey', '=', 'latest.identityKey')
            .andOn('s.serviceId', '=', 'latest.serviceId')
            .andOn('s.createdAt', '=', 'latest.maxCreatedAt')
        })
        .orderBy('s.createdAt', 'desc')
        .limit(200)
      const services = rows.map((r: any) => ({
        identityKey: r.identityKey,
        serviceId: r.serviceId,
        name: r.name,
        description: r.description,
        pricingModel: r.pricingModel,
        pricingSats: r.pricingSats,
        timestamp: r.timestamp,
        createdAt: r.createdAt,
      }))
      res.json(services)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  server.app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      // Count distinct agents/services (not duplicate overlay entries)
      const [agentResult] = await knex('clawdbot_agents').countDistinct('identityKey as cnt')
      const serviceRaw = await knex.raw(
        'SELECT COUNT(*) as cnt FROM (SELECT DISTINCT identityKey, serviceId FROM clawdbot_services) AS t'
      )
      // knex.raw returns [rows, fields] for MySQL, or just rows for SQLite
      const serviceRows = Array.isArray(serviceRaw[0]) ? serviceRaw[0] : (Array.isArray(serviceRaw) ? serviceRaw : [serviceRaw])
      const serviceCount = serviceRows.length > 0 ? Number(serviceRows[0].cnt || serviceRows[0]['COUNT(*)'] || 0) : 0
      res.json({
        agentCount: Number((agentResult as any).cnt),
        serviceCount,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        network,
      })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  server.app.get('/', (_req: Request, res: Response) => {
    try {
      const html = readFileSync(join(__dirname, '..', 'public', 'dashboard.html'), 'utf-8')
      res.set('Content-Type', 'text/html')
      res.send(html)
    } catch {
      res.set('Content-Type', 'text/html')
      res.send('<h1>Dashboard not found</h1><p>Place dashboard.html in public/</p>')
    }
  })

  // ---------------------------------------------------------------------------
  //  Intercept app.listen to capture the http.Server for WebSocket
  // ---------------------------------------------------------------------------
  const origListen = server.app.listen.bind(server.app)
  ;(server.app as any).listen = (...args: any[]) => {
    const httpServer: http.Server = origListen(...args)
    setupWebSocket(httpServer)
    return httpServer
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
  console.log(`  📬 Relay:   /relay/send, /relay/inbox, /relay/ack, /relay/stats`)
  console.log(`  🔌 WebSocket: ws://localhost:${port}/relay/subscribe`)
  console.log(`  📊 Dashboard: http://localhost:${port}/`)
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')
}

function safeJsonParse (str: string | null | undefined, fallback: any): any {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

main().catch((err) => {
  console.error('Fatal error starting clawdbot-overlay:', err)
  process.exit(1)
})
