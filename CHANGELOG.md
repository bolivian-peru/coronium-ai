# Changelog

All notable changes to the `coronium-ai` packages.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 we publish under the `alpha` npm tag and may break minor versions.

## [0.2.0-beta.1] — 2026-04-30

### Changed — single backend

Wallet-bound signup, key rotation, and the 7 proxy verbs all live
directly on the production Coronium API at
**`https://api.coronium.io/api/v3`** — Coronium's main production API,
powering both the customer dashboard and agent-native flows.

- **CLI / SDK / MCP** all default to `https://api.coronium.io/api/v3`
  (was `api.coronium.ai/v1`).
- **Two new public routes** added directly to coronium-backend:
  - `POST /wallet-challenge {wallet_address, voucher}` → SIWE message
  - `POST /wallet-signup {wallet_address, voucher, message, signature}` → JWT API token
- **Two new authed routes** for key rotation:
  - `POST /wallet-key/rotate-challenge`
  - `POST /wallet-key/rotate {message, signature}` → fresh JWT
- **Voucher claim is atomic** — single `findOneAndUpdate` so two parallel
  signups can't double-spend a code.
- **Credit lands in the same `Balance` ledger** that all customers
  use, so wallet-bound users can immediately spend on `/payment/buy-modems-with-crypto-balance`.

### Why this matters

Removed an entire deployment surface: no `apps/api` PM2 process, no
`api.coronium.ai` DNS, no `UPSTREAM_API_TOKEN` rotation, no SQLite-to-Mongo
migration. The `coronium init --voucher cor_v1_…` flow works **today**
against production with no additional infra.

### Out of scope (kept for later)

- `apps/api/` Fastify code is preserved as a reference implementation and
  local-dev mock — useful for forks who want to host their own backend
  with the same wire format.
- The hosted `coronium.ai/llms.txt`, `/AGENTS.md`, and `/openapi.yaml`
  endpoints are not yet live. The canonical OpenAPI is at
  `https://dashboard.coronium.io/api-docs/` (Swagger UI).

### Verification

End-to-end test passed against `https://api.coronium.io/api/v3` from a
clean local install:

```
$ coronium init --voucher cor_v1_…
✓ Account created: 69f367c892697e245190a9fc
  wallet         0x3b217c7a514943c2f2f8d23bee18b51569acd5fa
  api key        eyJhbGc…
  trial credit   $10.00
$ coronium status
backend     ✓ ok (225ms)
auth        ✓ valid
```

## [unreleased]

### Added — wallet-bound voucher signup (EVM + SIWE)

Every account is now anchored to an EVM keypair. Signup is voucher-gated and proven via [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) (SIWE) signatures. See [`docs/AUTH_DESIGN.md`](./docs/AUTH_DESIGN.md) for the full design.

- **`apps/api/`**:
  - Two new tables (`vouchers`, `redeem_challenges`) plus `wallet_address` + `wallet_chain` columns on `accounts`. Schema version bumped to `2`.
  - Two new endpoints to replace `POST /v1/account/create`:
    - `POST /v1/account/redeem-challenge` → returns a SIWE message bound to the supplied voucher + wallet address, with a 5-minute one-shot nonce.
    - `POST /v1/account/redeem` → verifies the SIWE signature (siwe@2 + viem), atomically consumes the voucher + challenge, mints the account + API key.
  - Two new endpoints for key recovery via wallet signature:
    - `POST /v1/account/key/rotate-challenge`
    - `POST /v1/account/key/rotate` (revokes all previous keys, issues a fresh `sk_live_…`)
  - Domain pinning: messages MUST target `api.coronium.ai` on chain ID `8453` (Base mainnet) or verification rejects.
  - 17 new e2e tests covering happy path + voucher-already-consumed + wrong-wallet signature + wallet-already-registered + key-rotation lifecycle.

- **`packages/cli/`** (new):
  - Wallet generation via `viem`'s BIP39/EVM derivation (default path `m/44'/60'/0'/0/0`).
  - Wallet storage at `~/.coronium/wallet.json` (mode 0600) + optional `~/.coronium/seed.txt` (mode 0400).
  - `coronium init` flow rewritten: prompts for voucher, prompts for wallet (generate / mnemonic / privkey / existing), signs SIWE, redeems.
  - `coronium init --restore` recovers an existing account from a wallet (signs a rotate challenge).
  - New `coronium key:rotate` command — wallet signs, server issues a new API key, all previous ones revoked.

- **`scripts/mint-vouchers.mjs`** (new):
  - Operator tool for batch issuance. Supports `--count`, `--batch`, `--campaign`, `--affiliate`, `--credit`, `--daily-cap`, `--session-cap`, `--expires`, `--db`, `--dry-run`. Prints codes to stdout, summary to stderr.

### Added — production API server

- `apps/api/` — `coronium-api`, the production server implementing `openapi.yaml`.
  - **Stack**: Fastify 5 + Zod + better-sqlite3 + pino + undici. Type-safe end to end.
  - **Auth**: bearer `sk_live_…` keys, scrypt-hashed at rest, 12-char prefix index for fast lookup, constant-time verification.
  - **State**: SQLite with WAL — accounts, api_keys, spend_ledger, audit_log. Schema in `src/db/schema.sql`, idempotently applied on boot.
  - **Spend caps**: per-call (X-Cost-Cap-Cents header), per-session (account default), per-day (account), per-day (tenant ceiling). All enforced before the upstream call.
  - **Upstream integration**: HTTP client to cor-api-v1's existing agent endpoint via `UPSTREAM_API_TOKEN`. Timeouts, error mapping (STOCK_OUT / CARRIER_NO_OP passed through with stable `code` field).
  - **Hardening**: helmet, CORS allowlist, rate-limit per-key (120/min) + per-IP (60/min), trustProxy, body limit 64 kB, audit log of every request.
  - **Health**: `GET /health` (liveness) + `GET /ready` (db + upstream) for nginx / k8s / systemd.
  - **Graceful shutdown**: SIGINT / SIGTERM closes Fastify and the DB; uncaughtException / unhandledRejection are fatal.
  - **Tests**: 11 e2e tests against an in-process mock of cor-api-v1. Full hero path covered (auth → tariffs → buy → rotate → release).
  - **Deploy**: multi-stage Dockerfile, PM2 ecosystem.config.cjs, hardened systemd unit, nginx config example, three deploy paths in `apps/api/README.md`.
- `apps/mock-api/` — renamed from `apps/api/`. Local-dev mock; never published.

## [0.1.0-alpha.0] — 2026-04-28

Initial scaffold. Three packages, one OpenAPI contract, seven verbs.

### Added

- `openapi.yaml` — hand-authored OpenAPI 3.1 spec. Source of truth for every package.
- `llms.txt` and `AGENTS.md` — agent self-discovery.
- `coronium-sdk@0.1.0-alpha.0` — typed TypeScript client. Covers all 7 verbs plus `account.create`. Throws `CoroniumError` / `CoroniumStockOutError` with stable `code` fields.
- `coronium-cli@0.1.0-alpha.0` — Commander.js CLI: `init`, `balance`, `deposit`, `tariffs`, `proxy get|list|rotate|replace|release`. `--json` flag for scripts. Reads `CORONIUM_API_KEY` env or `~/.coronium/config.toml` (chmod 600).
- `coronium-mcp@0.1.0-alpha.0` — MCP server over stdio. 8 tools (the 7 verbs + `proxy_release` as a separate tool from `proxy_get`). Zod-validated input. Error mapping returns stable `code` fields to the agent.
- `@coronium/mock-api` (private workspace package) — Express mock implementing the spec. Run via `pnpm dev:api`; the SDK test suite boots it on a random port for end-to-end verification.
- Vitest test suite — 21 tests across SDK / CLI / MCP. Hero path covered end-to-end against the mock.
- `scripts/doctor.mjs` — pre-publish doctor. Catches secrets, prod IPs, leftover tarballs, missing `dist/`. Runs as part of `publish:dry` and `publish:alpha`.
- `.github/workflows/ci.yml` — typecheck + build + test + doctor + dry-run publish on every PR.

### Notes

- Pre-1.0: surfaces frozen but field details may shift after first 20 design-partner integrations.
- No `account.create` from MCP — agents shouldn't be self-creating accounts unattended.
- No webhooks, OAuth, GraphQL, or gRPC. Not planned.

### Supersedes (deprecated)

`coronium-mcp` is the canonical MCP server. Two earlier private repos are deprecated and should be archived:

- `github.com/bolivian-peru/coronium-io-mcp-server` — last touched 2025-08-19. Targets the old (pre-agent-native) signup / login / card_purchase API model. MCP SDK ^0.4.0 (pre-1.0).
- `github.com/bolivian-peru/coronium-proxy-mcp-v2` — last touched 2025-09-11. Same old API model. Adds AES-256 token-at-rest (worth revisiting in v0.2).

Neither was ever published to npm. The new 7-verb spec is incompatible with their old verbs by design.
