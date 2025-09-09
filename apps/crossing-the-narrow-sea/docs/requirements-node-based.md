## Requirements: XDM Transfer Analysis (Node-based, Consensus ↔ Domain:0)

### Purpose

- Count successful cross-domain transfers per account, per direction, using only locally run blockchain nodes (no indexer).
- Maintain an offline-first workflow: export raw, verifiable evidence from nodes → store in intermediate artifacts (NDJSON/SQLite) → compute local aggregates → optionally upload artifacts to Auto Drive for community verification ([auto-sdk Auto Drive](https://github.com/autonomys/auto-sdk/tree/main/packages/auto-drive)).

### Background

- A transfer is one successful XDM between the Taurus consensus chain and auto-evm (domain:0) during the "Crossing the Narrow Sea" trial.
- Pointing to message correlation: see `xdm-correlation.md` (message_id = (channel_id, nonce); correlate source `OutgoingTransferInitiated`/`OutboxMessage` to destination `IncomingTransferSuccessful`).
- Trial window (from forum posts):
  - Consensus start height: 1,740,677 (Domain block 1,060,691)
  - Consensus end height: 2,460,732 (Domain block 1,561,826)

### What we count

- Directionality
  - Domain → Consensus (D→C): count by domain substrate source wallet (SS58 `from`)
  - Consensus → Domain (C→D): count by consensus source wallet (SS58 `from`)
- Only transfers with a confirmed destination success event are counted (per `ACK_MODE`).

### Node-only approach (no indexer)

1. Run two local nodes with RPC enabled (archive or full data over trial window)
   - Consensus node: expose HTTP RPC (ws optional) to `CONSENSUS_RPC_URL` (e.g., `http://127.0.0.1:9933`).
   - Domain:0 (auto-evm) node: expose RPC to `DOMAIN_RPC_URL` (e.g., `http://127.0.0.1:9944`).
   - Recommended flags (adjust by client):
     - `--pruning=archive` (or equivalent) for full historical access
     - `--rpc-external` only if needed; prefer binding to localhost
     - Ensure the block range for the trial is available

   Using public RPCs (alternative):
   - You may point `CONSENSUS_RPC_URL` and `DOMAIN_RPC_URL` to public RPC endpoints instead of running local nodes.
   - Caveats and recommendations:
     - Prefer archive-capable endpoints; non-archive RPCs may not have the full trial window.
     - Expect rate limits. Tune env vars such as `RPC_MAX_CONCURRENCY` (e.g., 2–4), `RPC_MAX_RETRIES` (e.g., 5), and `RPC_BACKOFF_MS` (e.g., 500–2500).
     - Support headers for API keys via `RPC_HEADERS_JSON` (JSON string, e.g., `{"Authorization":"Bearer ..."}`).
     - If you hit limits, reduce batch sizes, increase backoff, and enable resume.
   - Manifest should note `rpcMode: "public"` and include sanitized endpoint info.

2. Configure analysis bounds
   - Primary filter is the consensus block window:
     - `CONSENSUS_START_HEIGHT=1740677`
     - `CONSENSUS_END_HEIGHT=2460732`
     - `DOMAIN_START_HEIGHT=1060691`
     - `DOMAIN_END_HEIGHT=1561826`

### Recommended pipeline (SQLite mini-indexer)

- Capture (independent per chain, resumable and idempotent)
  - Scan consensus and domain:0 separately and write into a local SQLite database with indexed tables.
  - Tables:
    - `init(chain, channel_id, nonce, from_addr, amount, block_height, block_hash, extrinsic_index)`
    - `dest_success(dest_chain, channel_id, nonce, amount, block_height, block_hash)`
    - `outbox_ack(chain, channel_id, nonce, result, block_height, block_hash)`
  - Use primary keys on `(chain, channel_id, nonce)` (and `(dest_chain, ...)` for `dest_success`) to deduplicate.

- Match (offline join)
  - Join by `(channel_id, nonce)` to produce confirmed transfers per `ACK_MODE`:
    - `dest-only`: require destination success on the counterparty chain
    - `ack-only`: require `OutboxMessageResult { result: Ok }` on source
    - `both`: accept either; annotate method used

- Aggregate
  - Count per wallet by direction from the matched set (NDJSON or directly in SQLite).

- Share
  - Upload SQLite and NDJSON to Auto Drive; verifiers can recompute without nodes.

3. Extract raw evidence from nodes (capture to SQLite per chain)
   - Common correlation keys and events (see `xdm-correlation.md`):
     - Source chain: `transporter.OutgoingTransferInitiated { message_id=(channel_id, nonce), amount }` and `messenger.OutboxMessage { chain_id, channel_id, nonce }`
     - Destination chain: `transporter.IncomingTransferSuccessful { message_id=(channel_id, nonce), amount }`
   - D→C (source = domain:0, destination = consensus):
     - Iterate domain blocks in `[domainStartHeight .. domainEndHeight]` (or the broader window if not derived).
     - For each block, iterate events; when `OutgoingTransferInitiated` fires, write to `init(chain='domain', ...)`:
       - `message_id=(channel_id, nonce)`
       - `source_block_height`, `source_block_hash`
       - `extrinsic_index` (to tie back to origin)
       - `from_addr` (domain substrate origin, SS58) = extrinsic signer
     - When seeing destination success on consensus, write to `dest_success(dest_chain='consensus', ...)` for the same `(channel_id, nonce)`.
     - When seeing source ack on domain:0, write to `outbox_ack(chain='domain', result, ...)`.
     - Matching is performed offline by the join step (see pipeline).
   - C→D (source = consensus, destination = domain:0):
     - Iterate consensus blocks in `[CONSENSUS_START_HEIGHT .. CONSENSUS_END_HEIGHT]`.
     - For each block, when `OutgoingTransferInitiated` fires, write to `init(chain='consensus', ...)`:
       - `message_id=(channel_id, nonce)`
       - `source_block_height`, `source_block_hash`
       - `extrinsic_index`
       - `from_addr` (consensus origin) = extrinsic signer (SS58)
     - When seeing destination success on domain:0, write to `dest_success(dest_chain='domain', ...)`.
     - When seeing source ack on consensus, write to `outbox_ack(chain='consensus', result, ...)`.
     - Matching is performed offline by the join step (see pipeline).

4. Persist intermediate artifacts (offline-first)
   - Write raw, line-delimited evidence into `exports/<timestamp>/`:
     - `d2c_transfers.ndjson` (successful D→C rows)
     - `c2d_transfers.ndjson` (successful C→D rows)
     - Each row should include at minimum:
       - `direction` ("d2c" | "c2d")
       - `from` (domain EVM `0x...` for D→C; consensus SS58 for C→D)
       - `message_id` `{ channel_id, nonce }`
       - `amount` (as string), `source_block_height`, `dest_block_height`
       - `source_block_hash`, `dest_block_hash`, `timestamp`s if available
   - Write a `manifest.json` capturing config and checksums:
     - RPC endpoints, start/end heights, derived domain window (if any)
     - Scan version, node client versions, time started/ended
     - Row counts, file checksums (sha256), and file sizes
   - Optional: also persist to a local SQLite DB with equivalent schema for easy SQL validation.

5. Local aggregation (from artifacts, no RPC needed)
   - Compute per-wallet counts by direction from NDJSON/SQLite:
     - D→C counts by EVM `from`
     - C→D counts by consensus `from`
   - Example with `jq` on NDJSON:
     - D→C top N: `jq -r 'select(.direction=="d2c") | .from' d2c_transfers.ndjson | sort | uniq -c | sort -nr | head -50`
     - C→D top N: `jq -r 'select(.direction=="c2d") | .from' c2d_transfers.ndjson | sort | uniq -c | sort -nr | head -50`
   - Emit aggregates into `counts_per_wallet.json` and/or a SQLite table.

6. Shareable verification via Auto Drive
   - Upload raw artifacts and manifest to Auto Drive so others can verify without running nodes.
   - Suggested upload set: `manifest.json`, `d2c_transfers.ndjson[.gz]`, `c2d_transfers.ndjson[.gz]`, `counts_per_wallet.json`.
   - Consumers can download the artifacts and recompute aggregates locally.
   - Reference: [auto-sdk Auto Drive](https://github.com/autonomys/auto-sdk/tree/main/packages/auto-drive)

### Implementation details (expected tooling in this repo)

- CLI commands (to be implemented to automate the above):
  - `yarn node-export`
    - Inputs (env):
      - `CONSENSUS_RPC_URL`, `DOMAIN_RPC_URL`
      - `CONSENSUS_START_HEIGHT`, `CONSENSUS_END_HEIGHT`
      - Optional: `DOMAIN_START_HEIGHT`, `DOMAIN_END_HEIGHT` (if pre-derived)
      - `OUTPUT_DIR` (default: `
