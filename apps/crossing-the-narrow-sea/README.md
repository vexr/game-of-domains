# Crossing the Narrow Sea

Minimal app for analyzing the Game of Domains “Crossing the Narrow Sea” trial.

- Goal: compute per-wallet counts of cross-domain transfers (Consensus ↔ Domain:0)
- Approach: offline-first — export raw transfers to flat files, then aggregate locally
- Details: see `docs/requirements.md` and `docs/xdm-correlation.md`

## Quick start

1. Install deps at repo root

```
yarn install
```

2. Configure environment

```
cp .env.example .env
```

3. (Optional) Derive Domain:0 bounds from consensus heights

```
yarn workspace crossing-the-narrow-sea derive-domain-window
```

4. Run scripts

```
# Start main script (from repo root)
yarn workspace crossing-the-narrow-sea start

# Explore schema
yarn workspace crossing-the-narrow-sea introspect
```

## Scripts

- `start` — main analysis entrypoint
- `derive-domain-window` — map consensus start/end heights to Domain:0 via RGTR logs
- `introspect` — lightweight GraphQL schema explorer
