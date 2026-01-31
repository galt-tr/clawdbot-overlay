#!/usr/bin/env tsx
/**
 * Clawdbot Overlay Client — Joke Service Server
 *
 * A simple HTTP server that serves jokes for BSV micropayments.
 * Demonstrates how an overlay-registered service can accept payments
 * using the bsv-pay-v1 protocol.
 *
 * Endpoints:
 *   GET  /                          — Service info
 *   GET  /joke                      — Get a free sample joke
 *   POST /joke                      — Get a premium joke (requires payment)
 *   POST /bsv-pay/invoice           — Request a payment invoice
 *   POST /bsv-pay/verify            — Submit payment and receive joke
 *   GET  /health                    — Health check
 *
 * Usage:
 *   npx tsx src/joke-server.ts
 *
 * Environment variables:
 *   JOKE_SERVER_PORT   — Port to listen on (default: 3000)
 *   AGENT_PRIVATE_KEY  — Agent's private key for identity
 */

import express from 'express'
import { randomBytes } from 'node:crypto'
import {
  loadOrCreatePrivateKey,
  getIdentityKey,
  getOverlayUrl,
} from './utils.js'

// ---------------------------------------------------------------------------
//  Joke library — 20 jokes guaranteed to be at least mildly amusing
// ---------------------------------------------------------------------------

const JOKES: Array<{ setup: string; punchline: string }> = [
  {
    setup: 'Why do programmers prefer dark mode?',
    punchline: 'Because light attracts bugs.',
  },
  {
    setup: 'Why did the Bitcoin go to therapy?',
    punchline: 'It had too many unresolved transactions.',
  },
  {
    setup: 'What do you call a blockchain that tells jokes?',
    punchline: 'A laughchain.',
  },
  {
    setup: 'Why was the JavaScript developer sad?',
    punchline: "Because he didn't Node how to Express himself.",
  },
  {
    setup: 'What\'s a BSV transaction\'s favorite dance?',
    punchline: 'The UTXO shuffle.',
  },
  {
    setup: 'Why don\'t AI agents ever get lonely?',
    punchline: 'Because they always have peers on the overlay network.',
  },
  {
    setup: 'How does a miner relax after work?',
    punchline: 'They hash it out.',
  },
  {
    setup: 'Why did the overlay network break up with TCP?',
    punchline: 'Too many dropped connections, not enough commitment.',
  },
  {
    setup: 'What\'s the difference between a satoshi and a penny?',
    punchline: 'A satoshi is actually useful for micropayments.',
  },
  {
    setup: 'Why did the private key go to school?',
    punchline: 'To get a better public image.',
  },
  {
    setup: 'What do you call an agent without an identity on the overlay?',
    punchline: 'Anonymous... and unemployed.',
  },
  {
    setup: 'Why did the OP_RETURN output feel special?',
    punchline: 'Because it knew its data was immutable.',
  },
  {
    setup: 'How many developers does it take to change a UTXO?',
    punchline: 'None — you spend the old one and create a new one.',
  },
  {
    setup: 'Why was the merkle tree so confident?',
    punchline: 'It had proof at every level.',
  },
  {
    setup: 'What did the topic manager say to the invalid transaction?',
    punchline: '"You shall not pass... admittance."',
  },
  {
    setup: 'Why do overlay agents make great friends?',
    punchline: 'They always know how to look you up.',
  },
  {
    setup: 'What\'s a BEEF transaction\'s favorite food?',
    punchline: 'Anything with a good proof of steak.',
  },
  {
    setup: 'Why did the satoshi cross the blockchain?',
    punchline: 'To get to the other output.',
  },
  {
    setup: 'What did the lookup service say on its day off?',
    punchline: '"Query? I barely know \'er!"',
  },
  {
    setup: 'Why was the Clawdbot overlay so popular?',
    punchline: 'Because every agent knew their worth — in satoshis.',
  },
]

const SAMPLE_JOKES = JOKES.slice(0, 3) // First 3 are free samples

// ---------------------------------------------------------------------------
//  In-memory invoice store (production: use a database)
// ---------------------------------------------------------------------------

interface Invoice {
  invoiceId: string
  amountSats: number
  description: string
  createdAt: string
  expiresAt: string
  status: 'pending' | 'paid' | 'expired'
  joke?: { setup: string; punchline: string }
}

const invoices = new Map<string, Invoice>()

function generateInvoiceId(): string {
  return randomBytes(16).toString('hex')
}

function pickRandomJoke(): { setup: string; punchline: string } {
  return JOKES[Math.floor(Math.random() * JOKES.length)]
}

// ---------------------------------------------------------------------------
//  Express app
// ---------------------------------------------------------------------------

function createApp(): express.Express {
  const app = express()
  app.use(express.json())

  const privateKey = loadOrCreatePrivateKey()
  const identityKey = getIdentityKey(privateKey)
  const PRICE_SATS = 5

  // -----------------------------------------------------------------------
  //  GET / — Service info
  // -----------------------------------------------------------------------

  app.get('/', (_req, res) => {
    res.json({
      name: 'Random Joke Service',
      serviceId: 'tell-joke',
      provider: identityKey,
      overlay: getOverlayUrl(),
      pricing: {
        model: 'per-task',
        amountSats: PRICE_SATS,
      },
      endpoints: {
        'GET /joke': 'Get a free sample joke',
        'POST /bsv-pay/invoice': 'Request a payment invoice for a premium joke',
        'POST /bsv-pay/verify': 'Submit payment proof and receive your joke',
        'GET /health': 'Health check',
      },
      protocol: 'bsv-pay-v1',
    })
  })

  // -----------------------------------------------------------------------
  //  GET /joke — Free sample joke
  // -----------------------------------------------------------------------

  app.get('/joke', (_req, res) => {
    const joke = SAMPLE_JOKES[Math.floor(Math.random() * SAMPLE_JOKES.length)]
    res.json({
      free: true,
      joke,
      note: 'This is a free sample! For premium jokes, use the bsv-pay-v1 payment flow.',
      paymentUrl: '/bsv-pay/invoice',
    })
  })

  // -----------------------------------------------------------------------
  //  POST /bsv-pay/invoice — Request a payment invoice
  //
  //  This implements the first step of the bsv-pay-v1 protocol:
  //  The client requests an invoice, the server returns payment details.
  //
  //  Request:  { "service": "tell-joke" }
  //  Response: { "invoiceId": "...", "amountSats": 5, ... }
  // -----------------------------------------------------------------------

  app.post('/bsv-pay/invoice', (_req, res) => {
    const invoiceId = generateInvoiceId()
    const now = new Date()
    const expires = new Date(now.getTime() + 15 * 60 * 1000) // 15 min

    // Pre-select the joke (sealed until payment)
    const joke = pickRandomJoke()

    const invoice: Invoice = {
      invoiceId,
      amountSats: PRICE_SATS,
      description: 'One random joke from the Clawdbot Joke Service',
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      status: 'pending',
      joke,
    }

    invoices.set(invoiceId, invoice)

    // Return invoice (without the joke, obviously)
    res.json({
      protocol: 'bsv-pay-v1',
      invoiceId: invoice.invoiceId,
      recipient: identityKey,
      amountSats: invoice.amountSats,
      description: invoice.description,
      expiresAt: invoice.expiresAt,
      paymentUrl: '/bsv-pay/verify',
    })
  })

  // -----------------------------------------------------------------------
  //  POST /bsv-pay/verify — Submit payment and receive joke
  //
  //  This implements the second step of the bsv-pay-v1 protocol:
  //  The client submits proof of payment, the server delivers the service.
  //
  //  Request:  { "invoiceId": "...", "txid": "...", "rawTx": "..." }
  //  Response: { "status": "paid", "joke": { ... } }
  //
  //  NOTE: In this demo, payment verification is simplified.
  //  A production implementation would:
  //    1. Parse the rawTx to verify it's a valid BSV transaction
  //    2. Check that an output pays >= amountSats to our address
  //    3. Verify the transaction is broadcast / in the mempool
  //    4. Optionally wait for confirmation
  //  See README.md for the full verification flow.
  // -----------------------------------------------------------------------

  app.post('/bsv-pay/verify', (req, res) => {
    const { invoiceId, txid } = req.body as {
      invoiceId?: string
      txid?: string
      rawTx?: string
    }

    if (!invoiceId) {
      res.status(400).json({ error: 'Missing invoiceId' })
      return
    }

    const invoice = invoices.get(invoiceId)
    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' })
      return
    }

    if (invoice.status === 'paid') {
      // Already paid — return the joke again (idempotent)
      res.json({
        protocol: 'bsv-pay-v1',
        status: 'paid',
        invoiceId,
        joke: invoice.joke,
      })
      return
    }

    if (new Date() > new Date(invoice.expiresAt)) {
      invoice.status = 'expired'
      res.status(410).json({ error: 'Invoice expired' })
      return
    }

    // --- Payment verification ---
    // In production, verify the rawTx here. For this demo, we accept
    // any txid as proof of payment to keep the example simple.
    // See README.md § "Receiving Payments via bsv-pay" for full verification.

    if (!txid) {
      res.status(400).json({
        error: 'Missing txid',
        hint: 'Submit { invoiceId, txid, rawTx } with your payment transaction',
      })
      return
    }

    console.log(`💰 Payment received! invoice=${invoiceId} txid=${txid}`)

    invoice.status = 'paid'

    res.json({
      protocol: 'bsv-pay-v1',
      status: 'paid',
      invoiceId,
      txid,
      joke: invoice.joke,
    })
  })

  // -----------------------------------------------------------------------
  //  GET /health — Health check
  // -----------------------------------------------------------------------

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      agent: identityKey,
      uptime: process.uptime(),
      invoicesActive: [...invoices.values()].filter(i => i.status === 'pending').length,
    })
  })

  return app
}

// ---------------------------------------------------------------------------
//  Start server
// ---------------------------------------------------------------------------

function main(): void {
  const port = parseInt(process.env.JOKE_SERVER_PORT ?? '3000', 10)
  const app = createApp()

  app.listen(port, () => {
    console.log('')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('  😂 Clawdbot Joke Service — Running!')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    console.log(`  🌐 http://localhost:${port}`)
    console.log(`  📡 Overlay: ${getOverlayUrl()}`)
    console.log('')
    console.log('  Endpoints:')
    console.log(`    GET  http://localhost:${port}/              — Service info`)
    console.log(`    GET  http://localhost:${port}/joke          — Free sample`)
    console.log(`    POST http://localhost:${port}/bsv-pay/invoice — Get invoice`)
    console.log(`    POST http://localhost:${port}/bsv-pay/verify  — Pay & receive`)
    console.log('')
    console.log('  Payment flow:')
    console.log('    1. POST /bsv-pay/invoice → get invoiceId + amountSats')
    console.log('    2. Build & broadcast a BSV tx paying the amount')
    console.log('    3. POST /bsv-pay/verify { invoiceId, txid } → get joke')
    console.log('')
  })
}

main()
