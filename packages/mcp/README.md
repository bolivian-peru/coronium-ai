# coronium-mcp

[![npm](https://img.shields.io/npm/v/coronium-mcp.svg?label=coronium-mcp)](https://www.npmjs.com/package/coronium-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> Model Context Protocol server for [Coronium](https://coronium.ai). Buy and manage mobile (4G/5G) proxies from Claude Code, Claude Desktop, Cursor, Windsurf, or any MCP host.

## Quickstart

### Claude Code

```bash
claude mcp add coronium -- npx -y coronium-mcp
# Then export CORONIUM_API_KEY in the same shell, or add it to the MCP env.
```

### Claude Desktop / Cursor / Windsurf / any MCP host (manual)

Add this to your MCP config (`~/.claude.json`, `~/.cursor/mcp.json`, etc.):

```jsonc
{
  "mcpServers": {
    "coronium": {
      "command": "npx",
      "args": ["-y", "coronium-mcp"],
      "env": {
        "CORONIUM_API_KEY": "eyJhbGc…"
      }
    }
  }
}
```

Restart your MCP host. The agent auto-discovers the eight tools below — no further setup.

## Get an API key

You need a Coronium API key (`eyJhbGc…`) before the MCP can do anything useful. Get one in 60 seconds:

```bash
# 1. Get a free voucher
open https://coronium.ai/free

# 2. Install the CLI
npm install -g coronium-cli

# 3. Sign up — generates an EVM wallet locally, signs SIWE, stores the API key
coronium init --voucher cor_v1_…

# 4. Copy the key into your MCP env
cat ~/.coronium/config.toml | grep api_key
```

Or hit `POST https://api.coronium.io/api/v3/account/redeem-challenge` directly — the CLI just wraps that flow. See the [agent signup skill](https://github.com/bolivian-peru/coronium-ai/blob/main/skills/embed-signup/SKILL.md) for the wire format.

## Tools exposed (8)

| Tool | Use it for |
|---|---|
| `balance_get` | Show USDC balance + spend caps |
| `deposit_address` | USDC deposit address (Base / Tron / Ethereum) |
| `tariff_list` | List proxy plans by country / carrier / 4g\|5g |
| `proxy_get` | **Hero verb** — buy a proxy. Stock-validated before charge. Returns full credentials. |
| `proxy_list` | List active proxies |
| `proxy_rotate` | Rotate IP. Verified externally — never reports a no-op as success. |
| `proxy_replace` | Atomically swap a stuck proxy for a fresh modem (same country/carrier) |
| `proxy_release` | Release a proxy |

The agent calls these as standard MCP tools. Inputs are Zod-validated server-side and JSON-schema-described to the host.

## Spend caps

Server-enforced. Defaults: $50/day per key, $5/session, $500/day per tenant.

Tighten the per-session cap from your MCP env:

```jsonc
"env": {
  "CORONIUM_API_KEY": "eyJhbGc…",
  "CORONIUM_COST_CAP_CENTS": "100"
}
```

That caps every tool call at $1.00 — useful when an autonomous loop has access to `proxy_get`.

## Configuration

| Variable | Purpose |
|---|---|
| `CORONIUM_API_KEY` | Bearer token (required) |
| `CORONIUM_BASE_URL` | API base URL. Defaults to `https://api.coronium.io/api/v3`. Override for self-hosted / staging. |
| `CORONIUM_COST_CAP_CENTS` | Per-call spend cap in cents. Defaults to the account's session cap. |

## Error semantics

Tool calls that fail return a structured error to the agent with a stable `code` field. Common codes:

- `STOCK_OUT` — out of inventory; the response includes `suggestions` (alternative country/carrier with stock)
- `CARRIER_NO_OP` — carrier didn't release the IP after retries; `proxy_replace` instead of looping `proxy_rotate`
- `SPEND_CAP_EXCEEDED` — the tool call would exceed `session_cap_cents` or `daily_cap_cents`
- `INSUFFICIENT_BALANCE` — top up via `deposit_address`
- `INVALID_KEY` — key revoked or unknown

Agents should branch on `code`, not `message`.

## Reference

- Coronium homepage: <https://coronium.ai>
- Get a free voucher: <https://coronium.ai/free>
- API spec: <https://dashboard.coronium.io/api-docs/>
- Source: <https://github.com/bolivian-peru/coronium-ai/tree/main/packages/mcp>
- Companion packages:
  - [`coronium-cli`](https://www.npmjs.com/package/coronium-cli) — same surface, from your shell
  - [`coronium-sdk`](https://www.npmjs.com/package/coronium-sdk) — typed TypeScript client

## License

Apache-2.0
