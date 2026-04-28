# coronium-ai

[![ci](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml)
[![npm coronium-cli](https://img.shields.io/npm/v/coronium-cli.svg?label=coronium-cli)](https://www.npmjs.com/package/coronium-cli)
[![npm coronium-mcp](https://img.shields.io/npm/v/coronium-mcp.svg?label=coronium-mcp)](https://www.npmjs.com/package/coronium-mcp)
[![npm coronium-sdk](https://img.shields.io/npm/v/coronium-sdk.svg?label=coronium-sdk)](https://www.npmjs.com/package/coronium-sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Open-source agent-native interfaces for mobile (4G/5G) proxy infrastructure.** A CLI for humans, an MCP server for AI hosts, a typed SDK for code, a production API server, and a local mock for testing. One OpenAPI spec, seven verbs, three published packages.

The reference backend is [Coronium](https://coronium.ai), but everything in this repo is provider-neutral: the OpenAPI contract is the integration boundary, and the API server in `apps/api/` is open-source. Anyone can host their own backend, embed the CLI in a customer dashboard, or join the affiliate program (see [Resellers & Integrators](#resellers--integrators) below).

---

## Two install commands

```bash
# Human developer
npm install -g coronium-cli
coronium init
coronium proxy get --country US --type 5g

# AI agent (Claude Code / Claude Desktop / Cursor / Windsurf)
claude mcp add coronium npx -y coronium-mcp
# Then set CORONIUM_API_KEY in the MCP env.
```

That's the entire pitch.

---

## Repository layout

```
coronium-ai/
├── openapi.yaml               ← the contract — frozen on v0.1.0
├── llms.txt                   ← agent self-discovery (Mintlify/Cursor convention)
├── AGENTS.md                  ← agent host instructions
├── packages/
│   ├── sdk-ts/                ← coronium-sdk    — typed TypeScript client (npm)
│   ├── cli/                   ← coronium-cli    — `coronium proxy get …` (npm)
│   └── mcp/                   ← coronium-mcp    — MCP server for Claude / Cursor / Windsurf (npm)
├── apps/
│   ├── api/                   ← coronium-api    — production API server (Fastify + SQLite)
│   └── mock-api/              ← local mock; never published
├── scripts/doctor.mjs         ← pre-publish sanity check
└── .github/workflows/ci.yml   ← typecheck + build + test + doctor + dry-run publish
```

---

## The 7 verbs

| Verb | CLI | REST | MCP tool |
|---|---|---|---|
| balance | `coronium balance` | `GET /v1/balance` | `balance_get` |
| deposit | `coronium deposit` | `POST /v1/deposit/address` | `deposit_address` |
| tariffs | `coronium tariffs` | `GET /v1/tariffs` | `tariff_list` |
| buy proxy | `coronium proxy get` | `POST /v1/proxies` | `proxy_get` |
| list | `coronium proxy list` | `GET /v1/proxies` | `proxy_list` |
| rotate | `coronium proxy rotate <id>` | `POST /v1/proxies/{id}/rotate` | `proxy_rotate` |
| replace | `coronium proxy replace <id>` | `POST /v1/proxies/{id}/replace` | `proxy_replace` |
| release | `coronium proxy release <id>` | `DELETE /v1/proxies/{id}` | `proxy_release` |

Same surface in all three. If a verb stops being needed it's deprecated in all three at once. If a verb is added, same.

---

## Local development — full end-to-end test in one terminal

```bash
# One-time
pnpm install
pnpm build

# Terminal A — boot the local mock at http://127.0.0.1:5050
pnpm dev:api

# Terminal B — point the CLI at the mock
export CORONIUM_BASE_URL=http://127.0.0.1:5050/v1
node packages/cli/dist/index.js init
node packages/cli/dist/index.js proxy get --country US --type 5g
node packages/cli/dist/index.js proxy rotate <id>
node packages/cli/dist/index.js proxy release <id>

# Or link globally
cd packages/cli && npm link
coronium balance
```

Mock state is in-memory and resets on every restart — no persistence, no real charges, no real proxies.

To test against a real backend, set `CORONIUM_BASE_URL` to that backend's URL. The reference public backend lives at `https://api.coronium.ai/v1`.

---

## Tests

```bash
pnpm test          # 32 vitest cases across SDK, CLI, MCP, mock, and the production API
pnpm test:watch    # interactive
pnpm typecheck     # tsc on every package (fails-fast on missing deps)
pnpm doctor        # pre-publish: secrets / prod IPs / leftover .tgz / dist hygiene
```

The SDK suite boots `apps/mock-api/` on a random port. The production API suite boots `apps/api/` against an in-process mock of the upstream backend. The CLI suite shells out to `dist/index.js` and checks `--help` / `--version`. The MCP suite parses the built bundle to verify all 8 tools register.

---

## Self-host the API server

`apps/api/` is a complete production API server — Fastify 5, SQLite (WAL), pino, undici, helmet, rate-limit. It implements `openapi.yaml` and forwards to your own backend over HTTPS. Three deploy paths in [`apps/api/README.md`](./apps/api/README.md):

- **Docker** — multi-stage build, non-root, healthcheck. `docker run -p 5050:5050 …`
- **PM2** — `pm2 start apps/api/ecosystem.config.cjs`
- **systemd** — hardened unit file (`NoNewPrivileges`, `ProtectSystem=strict`, …)

All three sit behind nginx (TLS via certbot). Configuration is via env vars — see `apps/api/.env.example`.

If you're running your own mobile-proxy fleet and want the CLI/MCP/SDK ecosystem on top of it: set `UPSTREAM_API_URL` to your existing API and `UPSTREAM_API_TOKEN` to a service token, and you're shipping. The 9 upstream methods you need to implement are documented in [`apps/api/src/upstream/client.ts`](./apps/api/src/upstream/client.ts).

---

## Resellers & integrators

You can build on top of this repo three ways. Pick the one that matches how much customer ownership you want.

### 1. Recommend the official backend (zero integration)

Your tutorial, doc page, blog post, or product simply tells users to:

```bash
npm install -g coronium-cli
coronium init
```

`coronium init` defaults to `https://api.coronium.ai/v1`, where the user gets a fresh account with $0.50 trial credit and a USDC deposit address. No work for you. No revenue share — but no responsibility either.

### 2. Embed the CLI in your dashboard (affiliate program)

You point users at the official backend **with attribution** so you get a revenue share on everything they spend:

- **Server-side path** — your backend mints a signed referral token and includes it on `POST /v1/account/create`. Coronium attributes the user to you forever. You bill nothing; Coronium pays you a % of net revenue monthly in USDC.
- **Wrapper-package path** — publish `@yourbrand/proxies` as a tiny wrapper around `coronium-cli` that injects your affiliate ID. Users `npm install -g @yourbrand/proxies`, run `yourbrand proxy get …`, and attribution is baked in.

The affiliate program is launching alongside this repo. Default rev share is **20% of net revenue, lifetime**, paid in USDC, $50 minimum payout, 60-day clawback on refunds. Sign up at <https://coronium.ai/partners> (live soon — until then, contact partners@coronium.io).

This is the right path if you have a customer base already (a SaaS, a community, a content channel) and want to add mobile-proxy capability without building the infra.

### 3. Run your own backend (full sovereignty)

Self-host `apps/api/` against your own modem fleet (or another wholesale provider that exposes the 9 methods in `client.ts`). You own auth, billing, customer data, branding. You publish your own `@yourbrand/cli` and `@yourbrand/mcp` (or just rebrand and republish this repo's packages — Apache-2.0 license).

This is the right path if you have a fleet to monetize, want full margin, and can absorb the operational complexity.

A wholesale partnership with Coronium is also available — you embed against `api.coronium.ai/v1` with a tenant token and resell at your own markup. Contact partners@coronium.io.

---

## Publishing the npm packages (for forks / your own brand)

```bash
npm login                                # log in as your scope owner
pnpm doctor                              # local sanity
pnpm publish:dry                         # verify tarballs
pnpm publish:alpha                       # publish on the alpha tag
```

If you're forking under your own scope, do a search-and-replace from `coronium-cli/mcp/sdk` to `@yourscope/cli/mcp/sdk` first. License is Apache-2.0 — go for it.

---

## License

[Apache-2.0](./LICENSE). See `LICENSE` in each package directory.

## Links

- **Reference backend** — <https://api.coronium.ai/v1> (OpenAPI: <https://api.coronium.ai/openapi.yaml>)
- **Marketing** — <https://coronium.ai>
- **Customer dashboard** — <https://dashboard.coronium.io>
- **Agent discovery** — <https://coronium.ai/llms.txt>, <https://coronium.ai/AGENTS.md>
- **Affiliate / reseller** — partners@coronium.io
- **Bug reports / feature requests** — [GitHub issues](https://github.com/bolivian-peru/coronium-ai/issues)
