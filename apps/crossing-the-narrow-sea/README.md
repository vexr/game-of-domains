# Crossing the Narrow Sea

Minimal app for analyzing the Game of Domains “Crossing the Narrow Sea” trial.

- Goal: compute per-wallet counts of cross-domain transfers (Consensus ↔ Domain:0)
- Approach: node-based capture → write to SQLite → offline match/aggregate
- Details: see `docs/requirements-node-based.md` and `docs/xdm-correlation.md`

## Quick start

1. Install deps at repo root

```
yarn install
```

2. Configure environment (example)

```
# RPC endpoints (comma-separated allowed for failover)
CONSENSUS_RPC_URL=wss://rpc-0.taurus.autonomys.xyz/ws
DOMAIN_RPC_URL=wss://rpc-0.domain-0.autonomys.xyz/ws

# Trial window
CONSENSUS_START_HEIGHT=1740677
CONSENSUS_END_HEIGHT=2460732
DOMAIN_START_HEIGHT=1060691
DOMAIN_END_HEIGHT=1561826

# Optional
OUTPUT_DIR=exports
LOG_EVERY=1000
RPC_BACKOFF_MS=1000
RPC_MAX_BACKOFF_MS=10000
```

3. Run capture scripts

```
# From repo root
yarn workspace crossing-the-narrow-sea capture:consensus
yarn workspace crossing-the-narrow-sea capture:domain
```

4. Offline processing

```
yarn workspace crossing-the-narrow-sea match
yarn workspace crossing-the-narrow-sea counts
```

## Scripts

- `capture:consensus` — scan consensus blocks and persist evidence to SQLite
- `capture:domain` — scan domain blocks and persist evidence to SQLite
- `match` — offline join by `(channel_id, nonce)` to produce confirmed transfers
- `counts` — aggregate per-wallet counts by direction from matched transfers
