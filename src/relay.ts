/**
 * relay.ts — Message relay (mailbox) for agent-to-agent messaging.
 *
 * Knex-backed (MySQL in production, SQLite in dev). Agents POST messages,
 * poll their inbox, and ACK when processed. Cleanup runs hourly.
 *
 * Also provides WebSocket real-time push via /relay/subscribe.
 */

import type { Knex } from 'knex'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type http from 'http'

export interface RelayMessage {
  id: string
  from: string
  to: string
  type: string
  payload: any
  signature: string | null
  timestamp: number
}

export class MessageRelay {
  private knex: Knex
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor (knex: Knex) {
    this.knex = knex
  }

  /** Create the relay_messages table and start the cleanup timer. */
  async init (): Promise<void> {
    const exists = await this.knex.schema.hasTable('relay_messages')
    if (!exists) {
      await this.knex.schema.createTable('relay_messages', (table) => {
        table.string('id', 36).primary()               // UUID
        table.string('fromKey', 66).notNullable()       // compressed pubkey
        table.string('toKey', 66).notNullable().index()
        table.string('type', 128).notNullable()
        table.text('payload')                           // JSON string
        table.text('signature')                         // optional ECDSA DER hex
        table.bigInteger('timestamp').notNullable().index()
        table.integer('acked').notNullable().defaultTo(0)
      })
      console.log('📬 Created relay_messages table')
    }

    // Cleanup every hour: delete acked or expired (>24 h) messages
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((err) => console.error('Relay cleanup error:', err))
    }, 60 * 60 * 1000)
  }

  /** Store a message for delivery. */
  async storeMessage (msg: {
    from: string
    to: string
    type: string
    payload: any
    signature?: string
  }): Promise<{ id: string; stored: true }> {
    const id = randomUUID()
    await this.knex('relay_messages').insert({
      id,
      fromKey: msg.from,
      toKey: msg.to,
      type: msg.type,
      payload: JSON.stringify(msg.payload),
      signature: msg.signature || null,
      timestamp: Date.now(),
      acked: 0,
    })
    return { id, stored: true }
  }

  /** Fetch unread messages for an agent. */
  async getInbox (
    identityKey: string,
    sinceMs?: number,
    limit: number = 50,
  ): Promise<RelayMessage[]> {
    let query = this.knex('relay_messages')
      .where('toKey', identityKey)
      .where('acked', 0)

    if (sinceMs) {
      query = query.where('timestamp', '>', sinceMs)
    }

    const rows = await query.orderBy('timestamp', 'asc').limit(limit)
    return rows.map((r: any) => ({
      id: r.id,
      from: r.fromKey,
      to: r.toKey,
      type: r.type,
      payload: safeJsonParse(r.payload),
      signature: r.signature,
      timestamp: Number(r.timestamp),
    }))
  }

  /** Mark messages as acknowledged / read. */
  async ackMessages (identityKey: string, messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0
    const count = await this.knex('relay_messages')
      .where('toKey', identityKey)
      .whereIn('id', messageIds)
      .update({ acked: 1 })
    return count
  }

  /** Delete expired (>maxAgeMs) or already-acked messages. */
  async cleanup (maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs
    const count = await this.knex('relay_messages')
      .where('timestamp', '<', cutoff)
      .orWhere('acked', 1)
      .delete()
    if (count > 0) console.log(`📬 Relay cleanup: removed ${count} messages`)
    return count
  }

  /** Aggregate stats for the dashboard. */
  async getStats (): Promise<{
    totalMessages: number
    pendingMessages: number
    activeAgents: number
  }> {
    const [totalRow] = await this.knex('relay_messages').count('* as cnt')
    const [pendingRow] = await this.knex('relay_messages').where('acked', 0).count('* as cnt')
    const [activeRow] = await this.knex('relay_messages')
      .where('acked', 0)
      .countDistinct('toKey as cnt')
    return {
      totalMessages: Number((totalRow as any).cnt),
      pendingMessages: Number((pendingRow as any).cnt),
      activeAgents: Number((activeRow as any).cnt),
    }
  }

  destroy (): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

function safeJsonParse (str: string | null | undefined): any {
  if (!str) return null
  try { return JSON.parse(str) } catch { return str }
}

// ---------------------------------------------------------------------------
//  WebSocket real-time push
// ---------------------------------------------------------------------------

/** Map of identity key -> Set of connected WebSocket clients. */
const subscribers = new Map<string, Set<WebSocket>>()

/**
 * Attach a WebSocket server to the existing HTTP server.
 * Listens on WS /relay/subscribe?identity=<compressedPubKey>.
 */
export function setupWebSocket (server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/relay/subscribe' })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    const identity = url.searchParams.get('identity')

    if (!identity || !/^0[23][0-9a-fA-F]{64}$/.test(identity)) {
      ws.close(4001, 'Invalid or missing identity parameter')
      return
    }

    // Register subscriber
    if (!subscribers.has(identity)) {
      subscribers.set(identity, new Set())
    }
    subscribers.get(identity)!.add(ws)

    // Send connection confirmation
    ws.send(JSON.stringify({ type: 'connected', identity, timestamp: Date.now() }))
    console.log(`🔌 WS subscriber connected: ${identity.slice(0, 12)}…`)

    // Keepalive bookkeeping
    ;(ws as any).isAlive = true
    ws.on('pong', () => { (ws as any).isAlive = true })

    const cleanup = () => {
      const subs = subscribers.get(identity)
      if (subs) {
        subs.delete(ws)
        if (subs.size === 0) subscribers.delete(identity)
      }
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  // Heartbeat — ping every 30 s, terminate dead connections
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) { ws.terminate(); return }
      ;(ws as any).isAlive = false
      ws.ping()
    })
  }, 30_000)

  console.log('🔌 WebSocket relay endpoint ready at /relay/subscribe')
  return wss
}

/**
 * Push a message to a connected subscriber in real time.
 * Returns true if at least one WebSocket received the message.
 */
export function notifySubscriber (toKey: string, message: any): boolean {
  const subs = subscribers.get(toKey)
  if (!subs || subs.size === 0) return false

  const payload = JSON.stringify({ type: 'message', message })
  let pushed = false
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
      pushed = true
    }
  }
  return pushed
}

/** Aggregate WebSocket stats. */
export function getSubscriberStats (): {
  subscribedAgents: number
  totalConnections: number
} {
  let totalConnections = 0
  for (const subs of subscribers.values()) {
    totalConnections += subs.size
  }
  return { subscribedAgents: subscribers.size, totalConnections }
}

/**
 * Broadcast a message to ALL connected WebSocket subscribers.
 * Used for network-wide announcements (new services, etc.).
 * Returns the number of agents that received the broadcast.
 */
export function broadcastAll (event: any): number {
  const payload = JSON.stringify(event)
  let reached = 0
  for (const [_identity, subs] of subscribers) {
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
        reached++
        break // one per agent is enough
      }
    }
  }
  return reached
}
