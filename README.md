# coronium-ai

[![ci](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml)
[![npm coronium-cli](https://img.shields.io/npm/v/coronium-cli.svg?label=coronium-cli)](https://www.npmjs.com/package/coronium-cli)
[![npm coronium-mcp](https://img.shields.io/npm/v/coronium-mcp.svg?label=coronium-mcp)](https://www.npmjs.com/package/coronium-mcp)
[![npm coronium-sdk](https://img.shields.io/npm/v/coronium-sdk.svg?label=coronium-sdk)](https://www.npmjs.com/package/coronium-sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Open-source agent-native interfaces for mobile (4G/5G) proxy infrastructure.** A CLI for humans, an MCP server for AI hosts, a typed SDK for code, plus a local mock for testing. One OpenAPI spec, seven verbs, three published packages.

## Which Coronium MCP do I want?

Two MCP servers exist and both hit the same backend (`https://api.coronium.io/api/v3`). Pick by your starting state:

| You are… | Use | Why |
|---|---|---|
| **An AI agent** or **a new user** who wants one-command signup, no email | **`coronium-cli` + `coronium-mcp`** (this repo) | Voucher-gated, wallet-bound (SIWE) signup. 7 minimal verbs. `npx -y coronium-cli init --voucher cor_v1_…` and you have a working JWT |
| **A Coronium customer** with an existing dashboard.coronium.io email/password | [`coronium-proxy-mcp`](https://github.com/coroniumio/coronium-proxy-mcp) | 34 tools across the full lifecycle: tickets, low-balance alerts, OS fingerprinting, modem metadata, account settings, plus the 7 core verbs |

The two MCPs are intentional siblings, not duplicates — different auth model, different tool depth. Once signed in, both produce JWTs against the same API, so you can switch later if needs change.

The backend is [Coronium](https://coronium.ai), served live at `https://api.coronium.io/api/v3` — Coronium's main production API, powering both the customer dashboard and the agent-native flows in this repo. Wallet-bound + voucher-gated signup routes are wired into the same surface, so there's exactly one API, one auth shape, one set of OpenAPI types. The contract is the integration boundary, so anyone can host an alternative backend behind the same shape. Affiliate program for resellers and integrators below.

---

## Two install commands

```bash
# Human developer
npm install -g coronium-cli
coronium init --voucher cor_v1_K7F3...     # voucher-gated, wallet-bound
coronium proxy get --country US --type 5g

# AI agent (Claude Code / Claude Desktop / Cursor / Windsurf)
claude mcp add coronium -- npx -y coronium-mcp
# Then set CORONIUM_API_KEY in the MCP env.
```

`coronium init` generates a fresh EVM wallet locally, signs an [EIP-4361 (SIWE)](https://eips.ethereum.org/EIPS/eip-4361) challenge bound to your voucher, and gets back an `sk_live_…` API key. Same mnemonic works in MetaMask, Phantom (EVM mode), Rabby. Need a voucher? Get one at <https://coronium.ai/free> or via a partner. Lost the API key but kept the wallet? `coronium key:rotate` issues a new one. Lost the wallet but kept the mnemonic? `coronium init --restore`. Lost everything? Account's gone — same deal as a real crypto wallet.

See [`docs/AUTH_DESIGN.md`](./docs/AUTH_DESIGN.md) for the full design and threat model.

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

All routes are on `https://api.coronium.io/api/v3`. The REST column shows the path under that base.

| Verb | CLI | REST | MCP tool |
|---|---|---|---|
| balance | `coronium balance` | `GET /account` | `balance_get` |
| deposit | `coronium deposit` | `GET /account/crypto-balance` | `deposit_address` |
| tariffs | `coronium tariffs` | `GET /tariffs/available` | `tariff_list` |
| buy proxy | `coronium proxy get` | `POST /payment/buy-modems-with-crypto-balance` | `proxy_get` |
| list | `coronium proxy list` | `GET /account/proxies` | `proxy_list` |
| rotate | `coronium proxy rotate <id>` | `POST /modems/{id}/restart` | `proxy_rotate` |
| replace | `coronium proxy replace <id>` | `POST /modems/{id}/replace` | `proxy_replace` |
| release | `coronium proxy release <id>` | `POST /modems/{id}/cancel` | `proxy_release` |

Same surface in all three. If a verb stops being needed it's deprecated in all three at once. If a verb is added, same. The full OpenAPI is at <https://dashboard.coronium.io/api-docs/>.

### Wallet auth (the `coronium init` flow)

Two extra public routes power the agent-native onboarding — they live on the same API:

| Step | REST |
|---|---|
| 1. Get SIWE challenge | `POST /wallet-challenge {wallet_address, voucher}` |
| 2. Submit signed signup | `POST /wallet-signup {wallet_address, voucher, message, signature}` |
| 3. Rotate API key | `POST /wallet-key/rotate-challenge` then `POST /wallet-key/rotate` |

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

To test against a real backend, set `CORONIUM_BASE_URL` to that backend's URL. The reference public backend lives at `https://api.coronium.io/api/v3`.

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

`coronium init` defaults to `https://api.coronium.io/api/v3`, where the user gets a fresh account with $0.50 trial credit and a USDC deposit address. No work for you. No revenue share — but no responsibility either.

### 1.5. Embed the signup form in your own site (browser-native, no CLI install)

The CLI is Node-only, but the *signup flow* is just three HTTPS calls + an EIP-191 signature. It runs entirely in the browser via `viem`. Drop a single HTML file into your site, or use the React component, and your users sign up directly on your domain:

```html
<!-- Open skills/embed-signup/assets/demo.html in any modern browser. Works as-is. -->
```

Or for React / Next.js / Vite, copy the component from [`skills/embed-signup/references/react.md`](./skills/embed-signup/references/react.md). The full skill (with security guidance, troubleshooting, vanilla-JS variant, and exact wire format) lives at [`skills/embed-signup/SKILL.md`](./skills/embed-signup/SKILL.md). It's a Claude-format skill, so you can also drop it into a Claude Code workspace and have an agent generate the integration for you.

Use this if you want users to sign up on YOUR site (no CLI install) but still get a real Coronium account. Pairs naturally with #2 below — distribute affiliate-attributed vouchers, embed the signup form, get rev share automatically.

### 2. Embed the CLI in your dashboard (affiliate program)

You point users at the official backend **with attribution** so you get a revenue share on everything they spend:

- **Wrapper-package path** — publish `@yourbrand/proxies` as a tiny wrapper around `coronium-cli` that injects your affiliate ID. Users `npm install -g @yourbrand/proxies`, run `yourbrand proxy get …`, and attribution is baked in.
- **Server-side path** — your backend forwards signups to `https://api.coronium.io/api/v3/wallet-signup` and includes a referral identifier in the voucher metadata.

A formal affiliate program (rev-share, USDC payouts, dashboard) is on the roadmap but not live yet. For wholesale or partnership inquiries, open a [GitHub issue](https://github.com/bolivian-peru/coronium-ai/issues) and tag it `partnership`.

This is the right path if you have a customer base already (a SaaS, a community, a content channel) and want to add mobile-proxy capability without building the infra.

### 3. Run your own backend (full sovereignty)

The reference Fastify implementation in `apps/api/` (no longer used by Coronium itself) talks to a generic upstream over an HTTP client, so you can point it at any modem fleet that exposes the same handful of methods. License is Apache-2.0 — fork, rebrand, republish under your own npm scope, hook to your own DB. You own auth, billing, customer data.

This is the right path if you have a fleet to monetize, want full margin, and can absorb the operational complexity.

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

- **Production API** — <https://api.coronium.io/api/v3>
- **OpenAPI spec** — <https://dashboard.coronium.io/api-docs/> (Swagger UI, basic-auth gated)
- **Marketing site** — <https://coronium.ai>
- **Customer dashboard** — <https://dashboard.coronium.io>
- **Bug reports / feature requests** — [GitHub issues](https://github.com/bolivian-peru/coronium-ai/issues)
