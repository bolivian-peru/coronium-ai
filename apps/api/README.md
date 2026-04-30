# coronium-api (reference Fastify implementation — NOT the production backend)

> **Status as of 2026-04-30:** the production wallet-bound signup flow runs **directly on `https://api.coronium.io/api/v3`** — Coronium's main production API. This folder is preserved as a reference implementation for forks who want to host their own backend behind the same wire format.
>
> If you're integrating against Coronium production:
> - Base URL: `https://api.coronium.io/api/v3`
> - Signup: `POST /wallet-challenge` + `POST /wallet-signup` (SIWE)
> - The CLI (`coronium init`), MCP (`coronium-mcp`), and SDK (`coronium-sdk`) all default to that URL — no setup needed.
>
> The original gateway plan (this server forwarding to `cor-api-v1`) was collapsed: the wallet-auth routes were mounted directly on the main API instead, removing an entire deployment surface.

---

Reference Fastify server implementing [`coronium-ai/openapi.yaml`](../../openapi.yaml). Originally intended for `api.coronium.ai` deployment; now kept as a self-host template. Translates the agent-native 7-verb API into calls against an upstream Express monolith (modems, payments, ProxySmart).

## Architecture

```
   Agent / CLI / curl
         │
         │ HTTPS, Bearer sk_live_…
         ▼
   ┌─────────────┐         ┌────────────────────────────┐
   │ coronium-api│ ──HTTP──│ cor-api-v1 /api/agent      │
   │  (this app) │ token   │ (existing prod monolith,   │
   └─────┬───────┘         │  modems / payments / PS)   │
         │                 └────────────────────────────┘
         ▼
    SQLite (./data/coronium.db)
       - api_keys (scrypt-hashed)
       - accounts
       - spend_ledger (cents, time-windowed)
       - audit_log
```

The agent-native surface lives here; the system of record (modems, balances, carriers) stays in cor-api-v1. Service-to-service auth is a single bearer token (`UPSTREAM_API_TOKEN`).

## Local development

```bash
cd apps/api
cp .env.example .env
# Optionally fill UPSTREAM_API_TOKEN to talk to a real backend; otherwise
# the upstream calls will short-circuit and the app still serves account
# creation, auth, and spend caps.

pnpm install          # at the repo root
pnpm -F coronium-api dev    # tsx watch mode on PORT=5050
curl http://127.0.0.1:5050/health
```

## Tests

```bash
pnpm -F coronium-api test     # 13 e2e tests against an in-process mock of cor-api-v1
```

The mock at `test/upstream-mock.ts` implements every upstream endpoint we call. The full app boots with `:memory:` SQLite and exercises auth, spend caps, error mapping, and the rotate/release lifecycle.

## Production deploy — three options

### A. Docker (recommended for fresh boxes)

```bash
docker build -t coronium-api:0.1.0 -f apps/api/Dockerfile .
docker run -d --name coronium-api \
  -p 127.0.0.1:5050:5050 \
  -v /opt/coronium-data:/app/data \
  --env-file apps/api/.env \
  --restart unless-stopped \
  coronium-api:0.1.0
```

### B. PM2 on an existing Node host (e.g. cor-api-v1)

```bash
# On the server:
mkdir -p /opt/coronium-api && cd /opt/coronium-api
git clone https://github.com/bolivian-peru/coronium-ai.git src && cd src
pnpm install --frozen-lockfile
pnpm -F coronium-api build
cp apps/api/.env.example apps/api/.env   # then edit
pm2 start apps/api/ecosystem.config.cjs
pm2 save
```

### C. systemd (for a clean single-purpose VM)

```bash
# As root, on the server:
adduser --system --group --home /opt/coronium-api coronium
cd /opt/coronium-api && git clone https://github.com/bolivian-peru/coronium-ai.git src
chown -R coronium:coronium /opt/coronium-api

sudo -u coronium pnpm install --frozen-lockfile -C src
sudo -u coronium pnpm -F coronium-api build -C src
ln -s src/apps/api/dist /opt/coronium-api/dist
ln -s src/apps/api/.env /opt/coronium-api/.env

cp src/apps/api/coronium-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now coronium-api
journalctl -u coronium-api -f
```

### Then in front (any of the above)

```bash
# DNS: api.coronium.ai → server IP (A record)
cp src/apps/api/nginx.conf.example /etc/nginx/sites-available/api.coronium.ai
ln -s ../sites-available/api.coronium.ai /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# TLS
certbot --nginx -d api.coronium.ai
```

## Configuration

Every option is in [`.env.example`](./.env.example). Required for prod:

| Variable | Purpose |
|---|---|
| `UPSTREAM_API_URL` | URL of cor-api-v1's agent endpoint (e.g. `https://api.coronium.io/api/agent`) |
| `UPSTREAM_API_TOKEN` | Bearer token for service-to-service auth |
| `DATABASE_PATH` | SQLite file path; use `/opt/coronium-api/data/coronium.db` for prod |
| `CORS_ORIGINS` | Comma-separated allowed origins; default is the Coronium properties |

## Health endpoints

| Path | Purpose | Auth |
|---|---|---|
| `GET /health` | Liveness (always 200 if process alive) | none |
| `GET /ready` | Readiness — DB open + upstream reachable | none |
| `GET /v1/balance` | Real auth-required check | `Bearer sk_live_…` |

Wire `/ready` to your load balancer. `/health` is for `docker healthcheck` / systemd watchdogs.

## What this server does NOT do (yet)

- **Stripe / CoinGate / x402 payment ingestion** — handled upstream by cor-api-v1's existing webhook listeners. Balance is read from there.
- **Proxysmart driver calls** — handled upstream.
- **Modem provisioning** — handled upstream.
- **Email / receipts** — handled upstream.

This server is the agent-native shell. Heavy lifting stays where it already works.

## Schema migrations

The schema is in [`src/db/schema.sql`](./src/db/schema.sql) and is applied idempotently on every boot. Bumps to the schema:

1. Edit `schema.sql` (additive only — never drop columns in a release without a coordinated migration).
2. Increment the `_meta.schema_version` value in the same SQL file.
3. Future-you adds `ALTER TABLE` statements for the new version inside an `IF NOT EXISTS` guard.

## Security posture

- API keys: never stored in plaintext. scrypt hash + lookup by 12-char prefix index.
- Bearer token redacted from logs by pino's redact paths.
- helmet for sensible default headers.
- Rate-limited per-API-key (120/min default) and per-IP (60/min default).
- `trustProxy: true` so X-Forwarded-For from nginx is honored.
- Body limit 64 kB.
- systemd unit hardened (`NoNewPrivileges`, `ProtectSystem=strict`, etc.).
- TLS at the nginx layer, never on the Node process directly.

## Observability roadmap

- [ ] `/metrics` Prometheus endpoint (currently TODO).
- [ ] Structured request logs piped to Loki/Datadog.
- [ ] Audit log retention + rotation (currently grows forever).
- [ ] Per-customer charge alerting.
