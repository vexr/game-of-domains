## Requirements: XDM Transfer Analysis (Consensus ↔ Domain:0)

### Purpose

- Calculate how many cross-domain transfers happened per wallet between the Taurus consensus chain and auto-evm during the "Crossing the Narrow Sea" trial.
- Prefer an offline-first workflow: export intermediate flat files (NDJSON/CSV) once, then perform analysis locally without relying on the remote GraphQL endpoint.

### Background

- One point per successful XDM transfer; points will be converted to AI3 later. See:
  - Game of Domains: Crossing The Narrow Sea ([link](https://forum.autonomys.xyz/t/game-of-domains-crossing-the-narrow-sea/4751))
  - Game of Domains: Crossing The Narrow Sea Concludes ([link](https://forum.autonomys.xyz/t/game-of-domains-crossing-the-narrow-sea-concludes/4824))
- Trial window (from forum posts):
  - Start marked at consensus block 1,740,677 with a system.remark (see kickoff post)
  - Trial concluded at consensus block 2,460,732 (see conclusion post)

### Data Source

- Hasura/GraphQL endpoint: `https://subql.blue.taurus.subspace.network/v1/graphql`
- Known table: `domain_auto_evm_transfers`
  - Fields seen/expected: `from`, `to`, `from_chain`, `to_chain`, `timestamp`, `block_height`,
  - Direction filters observed:
    - Domain → Consensus: `from_chain = 'domain:0'` and `to_chain = 'consensus:null'`
    - Consensus → Domain: expected `from_chain = 'consensus:null'` and `to_chain = 'domain:0'`
- Consensus-side table: `consensus_transfers`
  - Fields: `_block_range`, `block_hash`, `block_height`, `event_id`, `extrinsic_id`, `fee`, `from`, `from_chain`, `id`, `success`, `timestamp`, `to`, `to_chain`, `uuid`, `value`
  - Direction filter for C→D: `from_chain = 'consensus:null'` and `to_chain = 'domain:0'`

### Scope & Definitions

- Transfer: One successful cross-domain message/transfer (XDM) recorded by the indexer.
- Directionality:
  - Domain → Consensus (D→C)
  - Consensus → Domain (C→D)
- Wallet identity:
  - Count by source wallet (the address that initiated the transfer).
  - EVM addresses (domain:0) and Substrate SS58 addresses (consensus) are distinct address spaces.
  - Do NOT normalize EVM address casing; use exact equality.
- Time window:
  - Default: Consensus start block 1,740,677 (domain block 1,060,691) to Consensus end block 2,460,732 (domain block 1,561,826)
  - Optional filters via environment variables by block height (recommended: align to the trial window blocks noted above).
    Note: You can derive domain:0 bounds from consensus bounds using `yarn derive-domain-window`.

### Metrics

- Per-direction counts per source wallet:
  - D→C counts by EVM `from` wallet
  - C→D counts by consensus `from` wallet
- Combined counts per wallet (optional): aggregate D→C and C→D; maintain chain context in output.

### Filters

- Required chain filters:
  - D→C: `from_chain = 'domain:0'` AND `to_chain = 'consensus:null'`
  - C→D: `from_chain = 'consensus:null'` AND `to_chain = 'domain:0'`
- Domain:0 block window:
  - Use consensus block heights to derive domain:0 start/end heights via `domain_auto_evm_blocks.logs` entries with `engine: "RGTR"` and the consensus block hash embedded in `value`.
  - Inputs: `CONSENSUS_START_HEIGHT`, `CONSENSUS_END_HEIGHT`
  - Helper: `yarn derive-domain-window` prints `domainStartHeight` and `domainEndHeight` to use as analysis bounds.

### Query Specifications (GraphQL)

- Raw Domain → Consensus export (no aggregates):

```graphql
query ExportD2C(
  $limit: Int!
  $offset: Int!
  $where: domain_auto_evm_transfers_bool_exp
) {
  domain_auto_evm_transfers(
    where: $where
    order_by: { block_height: asc }
    limit: $limit
    offset: $offset
  ) {
    id
    from
    to
    from_chain
    to_chain
    value
    fee
    success
    block_height
    block_hash
    event_id
    extrinsic_id
    timestamp
  }
}
```

- Raw Consensus → Domain export:

```graphql
query ExportC2D(
  $limit: Int!
  $offset: Int!
  $where: consensus_transfers_bool_exp
) {
  consensus_transfers(
    where: $where
    order_by: { block_height: asc }
    limit: $limit
    offset: $offset
  ) {
    id
    from
    to
    from_chain
    to_chain
    value
    fee
    success
    block_height
    block_hash
    event_id
    extrinsic_id
    timestamp
  }
}
```

- Notes:
  - Iterate pages until fewer than `$limit` rows are returned;
  - Prefer stable ordering by `block_height` ascending for deterministic exports.

### Implementation Plan (Exports + Local Analysis)

1. Export raw D→C (from `domain_auto_evm_transfers`) and raw C→D (from `consensus_transfers`) into flat files under `exports/<timestamp>` with height-based filters.
2. Write a `manifest.json` capturing filters, bounds, paging, and checksums.
3. Perform all aggregation locally from the exported files (no remote aggregation):
   - Count per-wallet occurrences for D→C and C→D separately
   - Optionally join results for a combined leaderboard
4. Produce final JSON/CSV artifacts from local calculations.

### Output Format (example)

```json
{
  "endpoint": "https://subql.blue.taurus.subspace.network/v1/graphql",
  "filters": { "startHeight": 1740677, "endHeight": 2460732 },
  "domain_to_consensus": {
    "walletCount": 1234,
    "top": [
      { "from": "0x...", "count": 100 },
      { "from": "0x...", "count": 95 }
    ]
  },
  "consensus_to_domain": {
    "walletCount": 987,
    "top": [
      { "from": "5G...", "count": 120 },
      { "from": "5H...", "count": 77 }
    ]
  },
  "combined": {
    "top": [
      { "wallet": "0x...", "chain": "domain", "total": 150 },
      { "wallet": "5G...", "chain": "consensus", "total": 130 }
    ]
  }
}
```

### Validation

- Cross-check total counts using GraphQL aggregate queries with the same base filters (no distinct, no per-wallet split) to ensure the sum of per-wallet counts matches the aggregate.
- Spot-check a few wallets by listing a small page and verifying counts.

### Performance & Reliability

- Page raw exports (e.g., `PAGE_SIZE=1000` with `MAX_PAGES` cap); avoid online distinct/aggregate queries.
- Use modest concurrency (e.g., `CONCURRENCY=6`) when fetching export pages; ensure deterministic `order_by` and re-sort by `block_height` locally if needed.
- Implement backoff/retry on transient HTTP/Hasura errors; fail fast on schema/validation errors.

### Exports: flat-file and manifest spec

- Artifacts:

  - `d2c_transfers.*` (domain → consensus raw rows)
  - `c2d_transfers.*` (consensus → domain raw rows)
  - `counts_per_wallet.json` (optional local aggregate)

- Suggested formats:

  - NDJSON (newline-delimited JSON) for streaming-friendly large exports.
  - CSV for spreadsheet tooling; consider quoting and explicit schema docs.
  - Optional: Parquet for columnar analytics if needed (via DuckDB or similar).

- File layout and naming (example):

  - `exports/YYYYMMDD-HHMMSS/manifest.json`
  - `exports/YYYYMMDD-HHMMSS/d2c_transfers.ndjson` (domain → consensus)
  - `exports/YYYYMMDD-HHMMSS/c2d_transfers.ndjson` (consensus → domain)
  - `exports/YYYYMMDD-HHMMSS/counts_per_wallet.json` (optional aggregate)

- Manifest fields (example):

```json
{
  "exportedAt": "2025-09-05T12:34:56Z",
  "endpoint": "https://subql.blue.taurus.subspace.network/v1/graphql",
  "filters": {
    "from_chain_d2c": "domain:0",
    "to_chain_d2c": "consensus:null",
    "from_chain_c2d": "consensus:null",
    "to_chain_c2d": "domain:0",
    "startHeight": 1740677,
    "endHeight": 2460732
  },
  "pageSize": 1000,
  "maxPages": 500,
  "rowCounts": { "d2c": 123456, "c2d": 98765 },
  "artifacts": {
    "d2c": { "path": "d2c_transfers.ndjson", "sha256": "..." },
    "c2d": { "path": "c2d_transfers.ndjson", "sha256": "..." }
  }
}
```

- Planned CLI support (to be implemented):

  - `yarn export` → creates a timestamped directory under `OUTPUT_DIR` and writes raw NDJSON files and a `manifest.json`.
  - Env controls: `OUTPUT_DIR`, `EXPORT_FORMAT` (ndjson|csv), `EXPORT_GZIP` (true|false), `PAGE_SIZE`, `MAX_PAGES`, `CONSENSUS_START_HEIGHT`, `CONSENSUS_END_HEIGHT`, plus derived `domainStartHeight`/`domainEndHeight`.

- Working offline from NDJSON examples:

  - Count per wallet (Domain → Consensus) with `jq`:
    - `jq -r 'select(.from != null) | .from' d2c_transfers.ndjson | sort | uniq -c | sort -nr | head -50`
  - Filter by height range:
    - `jq 'select((.block_height|tonumber) >= 1740677 and (.block_height|tonumber) <= 2460732)' d2c_transfers.ndjson > d2c_window.ndjson`

- Data hygiene:
  - Do not commit large export artifacts; keep `exports/` in `.gitignore` and publish only aggregates or manifests as needed.
  - Consider gzip compression for large NDJSON/CSV files.

### References

- Hasura endpoint: `https://subql.blue.taurus.subspace.network/v1/graphql`
- Forum background:
  - Game of Domains: Crossing The Narrow Sea ([link](https://forum.autonomys.xyz/t/game-of-domains-crossing-the-narrow-sea/4751))
  - Game of Domains: Crossing The Narrow Sea Concludes ([link](https://forum.autonomys.xyz/t/game-of-domains-crossing-the-narrow-sea-concludes/4824))
  - XDM Correlation ([link](./xdm-correlation.md))
