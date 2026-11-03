# AGENTS.md - Coronium

Instructions for AI coding agents working in this repository, and for agents that use Coronium mobile proxies.

## Using Coronium from an agent

- **MCP hosts** (Claude Code, Claude Desktop, Cursor, Windsurf): use `coronium-proxy-mcp`, not `coronium-mcp` (deprecated).
  `claude mcp add coronium -- npx -y coronium-proxy-mcp@2.4.2`, with `CORONIUM_API_TOKEN` in the server env. Hosted, nothing to install: `https://api.coronium.io/mcp` (OAuth sign-in, 22 tools, never spends) or `https://api.coronium.io/mcp/buyer` (15 tools, 20 when purchases are allowed).
- **Code**: `npm install coronium-sdk`, then `new Coronium({ token })`.
- **Shell**: `npm install -g coronium-cli`, then `coronium proxy list`.
- **REST**: `https://api.coronium.io/api/v3`, `Authorization: Bearer <token>`.

The token comes from dashboard.coronium.io (Account, API Access). Never ask a user to paste it into a chat.

No account yet? An agent can create one without a browser: `coronium_create_account` in `coronium-proxy-mcp` (started with no token and `CORONIUM_TOOL_PROFILE=buyer`), or `POST https://api.coronium.io/api/v3/signup` `{login, password, name, purpose?}`, `POST /api/v3/get-token` `{login, password}`, then `GET https://api.coronium.io/api/v1/account/api-token` with that session token as Bearer, which returns the 365-day token. The account starts empty.

Funding: account credit is added in the dashboard. A confirmed USDT (TRC-20) or BTC deposit to the addresses from `GET /api/v3/account/crypto-balance` moves into account credit with `POST /api/v3/account/balance/convert` (preview with `dry_run: true`; the real move needs an `Idempotency-Key`) or `coronium_convert_crypto_to_credit`. The SDK and CLI 1.0 have no method for it.

## Rules for agents

1. **Pending is not failure.** A rotation in state `rotating` is still running. Poll `rotationStatus`; never resubmit it and never replace a proxy because a rotation is pending.
2. **Never retry a write automatically.** On `outcome: "unknown"` (CLI exit code 3), check `proxies.list` or `account.payment` first.
3. **Respect rate limits.** On HTTP 429, wait `retryAfterSeconds`.
4. **Spending needs a person.** Buying and renewing are off by default. Only call `spending.buy` or `spending.renew` (or `coronium buy` / `coronium renew`) after the user approved the exact total, and pass that total as `expectedTotalUsd` / `--max-total`.
5. **Replacing is irreversible.** It gives the proxy a new host and new credentials and uses one of 2 replacements per 24 hours. Ask first.
6. **Some reads have side effects.** `account.cryptoBalances()` creates deposit wallets; `proxies.openvpn()` can issue a new certificate; the public rotation link rotates on every GET, so never paste it where link previews run.
7. **Credentials are secrets.** Proxy logins, OpenVPN profiles and webhook secrets go to the owner only.

## Working in this repository

- `packages/sdk-ts`: `coronium-sdk`. All HTTP goes through `src/transport.ts`; every route is declared in `src/routes.ts`.
- `packages/cli`: `coronium-cli`, built on the SDK. Wallet signing (viem) lives only here.
- `packages/sdk-ts/test/fixtures/v3-routes.json`: the public route list. A new SDK method must target a route in this file or the route test fails.
- Code style: named functions, explicit return types, no nested ternaries, comments that explain why.
- Copy style: short dashes only.
- Run `pnpm build && pnpm test && pnpm run doctor` before every commit.

## Support

hello@coronium.io
