# gainium-mcp (`gainium-mcp`)

## 📚 Platform knowledge base

A curated, auto-updated AI-agent knowledge base for the **whole Gainium platform** lives in the
private repo **`gainium-0-knowledge`** (`github.com/aressanch/gainium-0-knowledge`).
Local checkouts — Mac: `~/Git/Gainium Local/0-knowledge` · VPS: `/root/git/0-knowledge`.

Consult it before non-trivial work: `ARCHITECTURE.md` (service graph + danger boundaries),
`subsystems/<area>.md` (how each area works & breaks), `bug-patterns/`, `runbooks/`,
`domain/glossary.md`. Query 3.7k historical bugs by symptom:
`python3 <kb>/_raw/scripts/bugs.py find "<terms>"`. It is auto-enriched daily from agent session digests.

MCP server exposing Gainium bots/deals/balances to AI assistants. Transports: **stdio** (default) or HTTP
(`:3000`). Map: [`../0-knowledge/ARCHITECTURE.md`](../0-knowledge/ARCHITECTURE.md).

## Run / test
- Install · build `yarn build` · dev `yarn dev` · start `yarn start` · test `yarn test` · PM2 `yarn pm:start`

## Coupling — depends on the PUBLIC api.gainium.io contract
- Calls **main-app public REST** via `GAINIUM_API_BASE_URL` (prod `https://api.gainium.io`, dev `:7503`),
  HMAC-SHA256 signed (`src/gainium-client.ts`): `/api/v2/bots/*`, `/api/v2/deals/*`, `/api/v2/user/*`,
  `/api/v2/screener`, `/api/curated-presets`, …
- OAuth: validates bearer tokens via **main-app `/oauth/introspect`** (`GAINIUM_INTROSPECTION_URL`,
  `src/server.ts`) expecting `{active,apiKey,apiSecret,scope,aud,restrictions}`.
- These contracts are **owned by main-app** (root Danger List §2). If a tool breaks, the fix usually belongs
  on main-app's `/api/v2` or `/oauth/introspect` — don't paper over it here.

## Rules
- Tools carry MCP safety annotations (`readOnlyHint` for GET, `destructiveHint` for writes) — keep them
  accurate; they gate what an assistant may auto-run.
