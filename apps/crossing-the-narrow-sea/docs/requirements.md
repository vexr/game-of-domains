## Requirements: XDM Transfer Analysis (Node-based, Consensus ↔ Domain:0)

### Purpose

- Count successful cross-domain transfers per account, per direction, using only locally run nodes or public RPCs (no indexer required).
- Keep an offline-first workflow: capture raw evidence into SQLite → export NDJSON → compute local aggregates. Optional manual upload to Auto Drive for community verification.

### Background

- A transfer is one successful XDM between the Taurus consensus chain and auto-evm (domain:0) during the “Crossing the Narrow Sea” trial.
- Correlation key: message_id = (channel_id, nonce). See `xdm-correlation.md` for details.
- Trial window (from forum posts):
  - Consensus start height: 1,740,677 (Domain block 1,060,691)
  - Consensus end height: 2,460,732 (Domain block 1,561,826)

### What we count

- Directionality
  - Domain → Consensus (D→C): count by source signer on domain (SS58)
  - Consensus → Domain (C→D): count by source signer on consensus (SS58)
- Inclusion is controlled by `ACK_MODE` in the match step.

### Node-only approach (no indexer)

1. Run nodes or point to public RPCs

- This app uses WebSocket RPC endpoints (polkadot-js `WsProvider`). Provide comma-separated endpoints for failover.
  - `CONSENSUS_RPC_URL=wss://...[,wss://...]`
  - `DOMAIN_RPC_URL=wss://...[,wss://...]`
- Recommendations for self-run nodes:
  - Use archive/full data for the trial window (e.g., `--pruning=archive`).
  - Prefer binding to localhost; expose externally only if needed.

Using public RPCs is fine but expect rate limits. Controls provided:

- `BLOCK_CONCURRENCY` (default 8) — number of parallel block workers per scan
- `RPC_BACKOFF_MS` (default 1000) — initial retry backoff
- `RPC_MAX_BACKOFF_MS` (default 10000) — maximum backoff

2. Configure analysis bounds

- Required env vars:
  - `CONSENSUS_START_HEIGHT`, `CONSENSUS_END_HEIGHT`
  - `DOMAIN_START_HEIGHT`, `DOMAIN_END_HEIGHT`

### Pipeline implemented in this repo (SQLite mini-indexer)

- Capture (independent per chain; resumable and idempotent)
  - Scripts: `capture:consensus` and `capture:domain`
  - Writes to SQLite at `${OUTPUT_DIR}/xdm.sqlite` (default `exports/xdm.sqlite`)
  - Domain capture uses event segments API if available; consensus capture uses legacy system events

- Tables actually created
  - `source_inits`
    - PK: `(source_chain, channel_id, nonce)`
    - Columns: `source_chain`, `dst_chain_id`, `channel_id`, `nonce`, `from_address`, `amount`, `source_block_height`, `source_block_hash`, `source_extrinsic_index`
  - `destination_successes`
    - PK: `(destination_chain, channel_id, nonce)`
    - Columns: `destination_chain`, `src_chain_id`, `channel_id`, `nonce`, `amount`, `destination_block_height`, `destination_block_hash`
  - `source_acks`
    - PK: `(source_chain, channel_id, nonce)`
    - Columns: `source_chain`, `dst_chain_id`, `channel_id`, `nonce`, `result`, `source_block_height`, `source_block_hash`
  - Aux tables: `scan_progress` (for resume), `event_failures` (parsing issues), `source_inits_failed` (not currently populated by capture path but present)

- Match (offline join)
  - Script: `match`
  - Env: `ACK_MODE=dest-only | ack-only | both` (default `dest-only`)
  - Produces two NDJSON files in `${OUTPUT_DIR}`:
    - `d2c_transfers.ndjson` — rows from domain source, confirmed per `ACK_MODE`
    - `c2d_transfers.ndjson` — rows from consensus source, confirmed per `ACK_MODE`
  - Each NDJSON row has the shape:
    - `direction` ("d2c" | "c2d")
    - `from` (SS58 signer on the source chain)
    - `channel_id`, `nonce`
    - `amount` (destination amount if present, else source amount; string)
    - `source_block_height`, `source_block_hash`, `source_extrinsic_index`
    - `dest_block_height`, `dest_block_hash`
    - `confirmed_by` ("dest" | "ack" | "both")

- Aggregate
  - Script: `counts`
  - Reads `${OUTPUT_DIR}/d2c_transfers.ndjson` and `${OUTPUT_DIR}/c2d_transfers.ndjson`
  - Writes `${OUTPUT_DIR}/counts_per_wallet.json` with per-direction tallies and totals

### Commands

Run from repo root using yarn workspaces:

```
yarn workspace crossing-the-narrow-sea capture:consensus
yarn workspace crossing-the-narrow-sea capture:domain
yarn workspace crossing-the-narrow-sea match
yarn workspace crossing-the-narrow-sea counts
```

### Environment variables (used by the current implementation)

- Capture (both chains)
  - `CONSENSUS_RPC_URL` (ws, comma-separated allowed)
  - `DOMAIN_RPC_URL` (ws, comma-separated allowed)
  - `CONSENSUS_START_HEIGHT`, `CONSENSUS_END_HEIGHT`
  - `DOMAIN_START_HEIGHT`, `DOMAIN_END_HEIGHT`
  - `OUTPUT_DIR` (default: `exports`)
  - `BLOCK_CONCURRENCY` (default: 8)
  - `RPC_BACKOFF_MS` (default: 1000)
  - `RPC_MAX_BACKOFF_MS` (default: 10000)

- Match
  - `OUTPUT_DIR` (default: `exports`)
  - `ACK_MODE` (default: `dest-only`)

- Counts
  - `OUTPUT_DIR` (default: `exports`)

Notes:

- Indexer-related env vars in `.env.example` (e.g., `SUBQL_ENDPOINT`) are not used by this app.
- There is no `manifest.json` generation in code; the `match` step prints a JSON summary to stdout.

### Artifacts layout (current)

All artifacts are written directly under `${OUTPUT_DIR}` (no timestamped subfolder):

- `xdm.sqlite` — SQLite mini-indexer
- `d2c_transfers.ndjson`, `c2d_transfers.ndjson` — matched transfers per direction
- `counts_per_wallet.json` — aggregate counts per wallet and totals

### Event sourcing specifics

- Domain capture uses the chain’s event segment API when available. If segment fetch fails, capture aborts (no legacy fallback when `useSegments=true`).
- Consensus capture uses legacy `system.events` at block.

### Quick example (public RPCs)

```
# .env
CONSENSUS_RPC_URL=wss://rpc-0.taurus.autonomys.xyz/ws
DOMAIN_RPC_URL=wss://rpc-0.domain-0.autonomys.xyz/ws
CONSENSUS_START_HEIGHT=1740677
CONSENSUS_END_HEIGHT=2460732
DOMAIN_START_HEIGHT=1060691
DOMAIN_END_HEIGHT=1561826
OUTPUT_DIR=exports
BLOCK_CONCURRENCY=8
RPC_BACKOFF_MS=1000
RPC_MAX_BACKOFF_MS=10000

# capture
yarn workspace crossing-the-narrow-sea capture:consensus
yarn workspace crossing-the-narrow-sea capture:domain

# match (produces NDJSON, logs summary)
yarn workspace crossing-the-narrow-sea match

# counts (produces counts_per_wallet.json)
yarn workspace crossing-the-narrow-sea counts
```

### Sharing (optional)

You can manually upload `xdm.sqlite`, `d2c_transfers.ndjson`, `c2d_transfers.ndjson`, and `counts_per_wallet.json` to Auto Drive for community verification. There is no automated upload in this app.
