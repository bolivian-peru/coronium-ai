# AGENTS.md — Coronium

> Instructions for AI coding agents (Claude Code, Cursor, Windsurf, etc.) and
> for AI agents that need mobile proxies as part of their work.

## TL;DR

You can buy a mobile (4G/5G) proxy through the same API the human dashboard
uses — at `https://api.coronium.io/api/v3`. Use the MCP server, the typed
TypeScript SDK, the CLI, or raw REST.

```bash
# Best path for AI hosts (Claude Code, Claude Desktop, Cursor, Windsurf):
claude mcp add coronium -- npx -y coronium-mcp
# Then set CORONIUM_API_KEY in the MCP env (after running `coronium init`).
```

## Setup checklist

1. **Get a voucher.** Vouchers are single-use codes that grant a wallet-bound
   account when redeemed. The free tier is currently distributed by hand —
   open a [GitHub issue](https://github.com/bolivian-peru/coronium-ai/issues)
   tagged `voucher-request` or wait for the public `/free` form.
2. **Run `coronium init --voucher cor_v1_…`.** The CLI generates a fresh EVM
   wallet locally, signs a SIWE message, and exchanges it (along with the
   voucher) for an API token. The token is your entire identity.
3. **Store the key.** It's saved at `~/.coronium/config.toml`. Optionally
   encrypt the wallet with `coronium wallet:encrypt`.
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

Same surface in the CLI (`coronium proxy …`) and in MCP tools (`proxy_get`,
`proxy_rotate`, etc.).

## Hard rules for agents

1. **Stock-out is normal.** A failed `proxies.buy` often means no inventory in
   the requested country. Try a different country or carrier rather than
   looping the same call.
2. **A rotate `200` means "accepted," not "done."** Confirm the egress IP
   actually changed before relying on it (route real traffic, or re-list the
   proxy and compare the IP) — a carrier sticky window (~290s on many farms)
   can make a rotate a no-op even when accepted. The backend auto-clears stuck
   "pending" rotations within 5 minutes; on a clear failure, `replace` rather
   than looping `rotate`.
3. **Release what you buy.** Idle proxies cost money. When you're done, call
   `proxies.release(id)`.
4. **Read errors fully.** The backend returns `{ error: "…" }` on most
   failures with a clear human-readable message. Surface it to the user
   rather than retrying blindly.

## Mental model & operating principles

A Coronium proxy is a *real SIM in a real device* on a carrier CGNAT pool —
finite, stateful, physical, shared with real humans. That physics, plus a
[code-simplifier](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md)
disposition, is the whole operating manual:

- **Smallest sufficient action** — don't rotate when sticky works; `rotate`
  before `replace` before buy-new. Escalate only when the cheaper rung fails.
- **Read reality before acting** — `tariffs.list` / `proxies.list` are ground
  truth; query, don't assume.
- **Verify effects** — see rule 2 above; a `200` is "accepted," not "done."
- **No speculative loops** — irreversible/paid actions deserve confirmation.

The canonical, fuller treatment (mental model, decision rules, recipes, error
shapes) is the customer-side skill — same physics, same discipline:
<https://dashboard.coronium.io/SKILL.md>.

**Source of truth** (docs drift; the system does not): MCP `tools/list` →
OpenAPI at `/api-docs/` → live `/tariffs/available` + `/account/proxies` →
this file. When they disagree, the system wins.

**Make it yours.** The 7 verbs are deliberately minimal so you can compose
your own higher-level routines on top. The recipes and the verb set are a
floor, not a ceiling — only the safety/cost rules and the network's physics
(rate limits, finite stock, sticky windows) are fixed. Build what fits your task.

## Auth model — what's actually under the hood

This is a wallet-bound auth model, not OAuth and not a session cookie. The
account is a `(wallet_address, voucher)` pair, the API key is a JWT minted
during signup, and only the holder of the wallet's private key can rotate
the API key.

- **Signup**: `POST /wallet-challenge {wallet_address, voucher}` →
  `POST /wallet-signup {wallet_address, voucher, message, signature}` →
  returns `{api_token, user_id, balance_usd}`.
- **Rotate API key**: `POST /wallet-key/rotate-challenge` (authed) →
  `POST /wallet-key/rotate {message, signature}` → new `api_token`.

The CLI (`coronium init`, `coronium key:rotate`) wraps both flows.

## Local development

If you cloned this repo:

- `pnpm install` at the repo root
- `pnpm dev:api` — boot the local Fastify mock at http://127.0.0.1:5050
  (this is a reference implementation, not the production backend)
- `pnpm -F coronium-cli dev` — run the CLI from source
- `pnpm -F coronium-mcp dev` — run the MCP server in stdio mode
- `pnpm -F coronium-sdk build` — emit the typed client into `dist/`

`apps/api/` is preserved as a Fastify reference implementation; production
runs against `https://api.coronium.io/api/v3` directly.

## What not to build

- Don't add OAuth, webhooks, GraphQL, or gRPC. We rejected all of them.
- Don't reference invoices, billing history, or account-cancellation as
  things the API does. Those go through the dashboard.

## Links

- Source: <https://github.com/bolivian-peru/coronium-ai>
- Production API: <https://api.coronium.io/api/v3>
- OpenAPI (Swagger UI): <https://dashboard.coronium.io/api-docs/>
- Marketing: <https://coronium.ai>
- Customer dashboard: <https://dashboard.coronium.io>
- Support: open a [GitHub issue](https://github.com/bolivian-peru/coronium-ai/issues)
