# game-of-domains

Monorepo for analyses and tooling around Autonomys “Game of Domains” contests.

## Repo structure

```
game-of-domains/
  apps/
    crossing-the-narrow-sea/        # App for the "Crossing the Narrow Sea" contest
      src/                          # TS scripts (GraphQL export, helpers)
      docs/                         # Requirements and correlation notes
      .env.example                  # Endpoint and analysis settings
  package.json                      # Yarn workspaces config and root scripts
```

## Goals (current app)

- Compute Crossing the Narrow Sea Results

## Quick start

1. Install

```
yarn install
```

2. Configure the app

```
cp apps/crossing-the-narrow-sea/.env.example apps/crossing-the-narrow-sea/.env
```

3. (Optional) Derive Domain:0 bounds from consensus heights

```
yarn workspace crossing-the-narrow-sea derive-domain-window
```

4. Run the app or scripts

```
# From repo root
yarn start
# or directly
yarn workspace crossing-the-narrow-sea start
```

## Useful scripts

- Root
  - `yarn typecheck` → typechecks all workspaces
- App (`crossing-the-narrow-sea`)
  - `start` → main analysis entrypoint
  - `derive-domain-window` → maps consensus start/end heights to Domain:0 heights via RGTR logs
  - `introspect` → light schema explorer for the Hasura endpoint
