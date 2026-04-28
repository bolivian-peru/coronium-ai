# Changelog

All notable changes to the `coronium-ai` packages.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 we publish under the `alpha` npm tag and may break minor versions.

## [unreleased]

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
