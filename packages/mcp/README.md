# @coronium/mcp

Model Context Protocol server for [Coronium](https://coronium.ai) — buy and manage mobile (4G/5G) proxies from Claude Code, Claude Desktop, Cursor, Windsurf, or any MCP host.

## Install (the agent-host way)

### Claude Code

```bash
claude mcp add coronium npx -y @coronium/mcp
# Then export CORONIUM_API_KEY in your shell, or set `env` on the MCP entry.
```

### Claude Desktop / Cursor / Windsurf (manual)

Add to your MCP config (`~/.claude.json`, `~/.cursor/mcp.json`, etc.):

```jsonc
{
  "mcpServers": {
    "coronium": {
      "command": "npx",
      "args": ["-y", "@coronium/mcp"],
      "env": {
        "CORONIUM_API_KEY": "sk_live_..."
      }
    }
  }
}
```

Restart your host. The agent will auto-discover all 7 tools.

## Tools exposed

| Tool | Use it for |
|---|---|
| `balance_get` | Show USDC balance, burn rate, spend caps |
| `deposit_address` | Get a USDC deposit address (Base / Tron / Ethereum) |
| `tariff_list` | List proxy plans by country / carrier / 4g/5g |
| `proxy_get` | **Hero verb** — buy a proxy. Stock-validated before charge. |
| `proxy_list` | List active proxies |
| `proxy_rotate` | Rotate IP. Verified — never reports a no-op as success. |
| `proxy_replace` | Atomically swap a stuck proxy for a fresh modem (same country/carrier) |
| `proxy_release` | Release a proxy |

## Get an API key

```bash
npm install -g @coronium/cli
coronium init       # creates the account, stores the key locally
```

Or `POST https://api.coronium.ai/v1/account/create` directly — it returns a `sk_live_…` key, a USDC deposit address on Base, and $0.50 trial credit. There is no email verification.

## Spend caps

Server-enforced. Defaults: $50/day per key, $5/session, $500/day per tenant.

To set a tighter session cap from the MCP, add to the env:

```jsonc
"env": {
  "CORONIUM_API_KEY": "sk_live_...",
  "CORONIUM_COST_CAP_CENTS": "100"
}
```

This caps every tool call at $1.00.

## Reference

- AGENTS.md: <https://coronium.ai/AGENTS.md>
- API spec: <https://api.coronium.ai/openapi.yaml>
- Source: <https://github.com/bolivian-peru/coronium-ai/tree/main/packages/mcp>

## License

Apache-2.0
