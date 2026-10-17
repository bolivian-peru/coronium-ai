# AGENTS.md - Coronium

Instructions for AI coding agents working in this repository, and for agents that use Coronium mobile proxies.

## Using Coronium from an agent

- **MCP hosts** (Claude Code, Claude Desktop, Cursor, Windsurf): use `coronium-proxy-mcp`, not `coronium-mcp` (deprecated).
  `claude mcp add coronium -- npx -y coronium-proxy-mcp`, with `CORONIUM_API_TOKEN` in the server env.
- **Code**: `npm install coronium-sdk`, then `new Coronium({ token })`.
- **Shell**: `npm install -g coronium-cli`, then `coronium proxy list`.
- **REST**: `https://api.coronium.io/api/v3`, `Authorization: Bearer <token>`.

The token comes from dashboard.coronium.io (Account, API Access). Never ask a user to paste it into a chat.

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
