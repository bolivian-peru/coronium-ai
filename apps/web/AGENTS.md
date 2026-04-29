# AGENTS.md — Coronium

> Instructions for AI coding agents (Claude Code, Cursor, Windsurf, etc.) and
> for AI agents that need mobile proxies as part of their work.

## TL;DR

You can buy a mobile (4G/5G) proxy in one HTTP call. Use the MCP server, the
TypeScript SDK, the Python SDK, or raw REST — they all hit the same API.

```bash
# Best path for AI hosts (Claude Code, Claude Desktop, Cursor, Windsurf):
claude mcp add coronium npx -y coronium-mcp
# Then set CORONIUM_API_KEY in the MCP env.
```

## Setup checklist

1. **Get an API key.** `POST https://api.coronium.ai/v1/account/create` with no
   body returns a `sk_live_…` key, a USDC-on-Base deposit address, and $0.50
   trial credit. There is no email verification step.
2. **Store the key.** Put it in the env var `CORONIUM_API_KEY`. Never log it,
   never commit it. It's the entire identity.
3. **(Optional) Top up.** Send USDC on Base to the deposit address. Arrives in
   ~10 seconds. Pricing is $0.02/proxy/hour, prorated per second.
4. **Use it.** Call any of the 7 verbs (see `llms.txt`).

## The 7 verbs you actually need

```ts
import { Coronium } from "coronium-sdk";
const c = new Coronium({ apiKey: process.env.CORONIUM_API_KEY! });

await c.balance.get();
await c.deposit.address({ chain: "base" });
await c.tariffs.list({ country: "US", type: "5g" });
await c.proxies.list();
const proxy = await c.proxies.buy({ country: "US", type: "5g" });
await c.proxies.rotate(proxy.id);
await c.proxies.replace(proxy.id);
await c.proxies.release(proxy.id);
```

Same surface in Python (`coronium-sdk`), in the CLI (`coronium ...`), and in
MCP tools (`proxy_get`, `proxy_rotate`, etc.).

## Hard rules for agents

1. **Read `code`, not `message`.** Errors carry a stable `code` field. Match
   on that. Messages are human-readable and may change.
2. **Respect spend caps.** `403 SPEND_CAP_EXCEEDED` means the user / your
   session hit a cap. Don't loop. Tell the human.
3. **Stock-out is normal.** `409 STOCK_OUT` includes a `suggestion` block with
   alternative country/carrier in stock. Use it or ask.
4. **Rotate is verified.** A `200` from `/proxies/{id}/rotate` means the IP
   actually changed. A `409 CARRIER_NO_OP` means the carrier didn't release
   the IP after retries — try `replace` instead of looping rotate.
5. **Release what you buy.** Idle proxies cost $0.02/hour. When you're done,
   `DELETE /v1/proxies/{id}`. Don't forget — daily cap will save the user
   either way, but don't bank on it.
6. **Use `X-Cost-Cap-Cents` for one-off limits.** If the user says "spend at
   most $1 on this run," send `X-Cost-Cap-Cents: 100` on every call. The
   server enforces it.

## Local development

If you cloned this repo:

- `pnpm install` at the repo root
- `pnpm dev:api` — boot the local mock at http://127.0.0.1:5050
- `pnpm -F coronium-cli dev` — run the CLI from source
- `pnpm -F coronium-mcp dev` — run the MCP server in stdio mode
- `pnpm -F coronium-sdk build` — emit the typed client into `dist/`
- The OpenAPI spec at `openapi.yaml` is the source of truth. If you change a
  verb here, you change it in the API, the SDK, the CLI, and the MCP — in
  that order.

## What not to build

- Don't add a verb without first changing `openapi.yaml`.
- Don't add a parallel "agent API" — there's one API.
- Don't add OAuth, webhooks, GraphQL, or gRPC. We rejected all of them.
- Don't reference invoices, billing history, or account-cancellation as
  things the API does. Those go through the dashboard.

## Links

- Source: <https://github.com/bolivian-peru/coronium-ai>
- OpenAPI: <https://api.coronium.ai/openapi.yaml>
- llms.txt: <https://coronium.ai/llms.txt>
- Marketing: <https://coronium.ai>
- Customer dashboard: <https://dashboard.coronium.io>
- Support: support@coronium.io
