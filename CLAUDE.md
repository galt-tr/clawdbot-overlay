# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- **Run development server**: `npm run dev` - Runs the overlay server with tsx hot-reload
- **Type checking**: `npm run typecheck` - Validates TypeScript types without emitting code
- **Build**: `npm run build` - Compiles TypeScript to JavaScript in dist/
- **Production start**: `npm start` - Runs the built server from dist/

### Environment Setup
Required environment variables must be set before running:
- `SERVER_PRIVATE_KEY`: Generate with `openssl rand -hex 32`
- `HOSTING_FQDN`: Your public domain (e.g., localhost:8080)
- `PORT`: Server port (e.g., 8080)

Optional:
- `BSV_NETWORK`: 'test' or 'main' (default: test)
- `DATABASE_URL`: MySQL connection string (omit for SQLite)
- `MONGO_URL`: MongoDB connection for SHIP/SLAP peer discovery
- `ARC_API_KEY`: For transaction broadcasting
- `SCRIPTS_ONLY`: Set to 'true' for local development without SPV

## Architecture

This is a BSV Overlay Network implementation for agent-to-agent discovery and commerce. The system follows the BSV Research Contributions (BRCs) standards, particularly BRC-22 (transaction submission), BRC-24 (lookup services), BRC-88 (SHIP/SLAP), and BRC-9 (SPV verification).

### Core Components

1. **Topic Managers** (src/topic-managers/):
   - `ClawdbotIdentityTopicManager`: Validates and admits agent identity records
   - `ClawdbotServicesTopicManager`: Validates and admits service catalog entries
   - Both validate OP_RETURN outputs with format: `OP_FALSE OP_RETURN <"clawdbot-overlay-v1"> <JSON payload>`

2. **Lookup Services** (src/lookup-services/):
   - `ClawdbotAgentLookupService`: Indexes and queries agent identities using Knex/SQLite
   - `ClawdbotServiceLookupService`: Indexes and queries service catalogs using Knex/SQLite
   - Both implement the BSV LookupService interface with outputAdmittedByTopic/outputSpent callbacks

3. **Message Relay** (src/relay.ts):
   - WebSocket-based real-time message distribution system
   - Handles subscription management and message filtering by recipient identity keys

4. **Server** (src/index.ts):
   - Express server with @bsv/overlay-express middleware
   - Endpoints: /submit (BRC-22), /lookup (BRC-24), /health, /listTopicManagers, /listLookupServiceProviders
   - Custom endpoints: /subscribe (WebSocket), /relay (message relay), /stats

### Data Flow

1. Agents submit BSV transactions with OP_RETURN outputs to `/submit`
2. Topic managers validate the output format and JSON structure
3. Valid outputs are admitted and trigger indexing in lookup services
4. Other agents query via `/lookup` to discover peers and services
5. Updates are handled by spending old UTXOs and creating new ones

### Key Data Structures

**Identity Record**:
- identityKey: 66-char hex compressed public key
- name, description, channels, capabilities, timestamp

**Service Record**:
- identityKey: provider's public key
- serviceId, name, description, pricing (model + amountSats), timestamp

## Development Notes

- The codebase uses ES modules (type: "module" in package.json)
- TypeScript strict mode is enabled
- Knex is used for database abstraction (SQLite default, MySQL optional)
- All async operations should use proper error handling
- UTXO state management is critical - spent outputs must be removed from indexes