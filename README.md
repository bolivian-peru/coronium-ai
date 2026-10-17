# coronium-ai

[![ci](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml)
[![npm coronium-sdk](https://img.shields.io/npm/v/coronium-sdk.svg?label=coronium-sdk)](https://www.npmjs.com/package/coronium-sdk)
[![npm coronium-cli](https://img.shields.io/npm/v/coronium-cli.svg?label=coronium-cli)](https://www.npmjs.com/package/coronium-cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A typed TypeScript SDK and a command-line tool for the [Coronium](https://www.coronium.io) mobile proxy API (`https://api.coronium.io/api/v3`): dedicated 4G/5G proxies on real carrier SIMs.

- **[`coronium-sdk`](./packages/sdk-ts)** 1.0: one typed client for account, catalog, proxies, tickets, webhook and (opt-in) purchases.
- **[`coronium-cli`](./packages/cli)** 1.0: the `coronium` command, built on the SDK, plus wallet-bound voucher sign-up.

## Looking for the MCP server?

Use **[`coronium-proxy-mcp`](https://github.com/coroniumio/coronium-proxy-mcp)** (`npx -y coronium-proxy-mcp`). It is the maintained Coronium MCP server.

`coronium-mcp` from this repo is **deprecated**. Version 0.2.0 and earlier called API routes that never existed on `api.coronium.io` and could report false results to an agent. Its source has been removed here; see [packages/mcp/README.md](./packages/mcp/README.md).

## Upgrading from 0.x

`coronium-sdk` and `coronium-cli` 0.x were written against an API design that was never shipped. Against the real API, most of their methods returned an HTML page as if it were data, and some CLI commands printed success when nothing happened. **There is nothing to migrate: 0.x did not work.** Version 1.0 is a rewrite against the real `/api/v3` contract. See [CHANGELOG.md](./CHANGELOG.md).

## Quick start

```bash
npm install -g coronium-cli
export CORONIUM_API_TOKEN=...          # dashboard.coronium.io, Account, API Access
coronium tariffs --country US          # plans in stock, no token needed
coronium proxy list                    # your proxies with HTTP and SOCKS5 URLs
coronium proxy rotate <id> --wait      # new IP from the carrier
```

```ts
import { Coronium } from "coronium-sdk";

const coronium = new Coronium({ token: process.env.CORONIUM_API_TOKEN });
const [proxy] = await coronium.proxies.list();
const result = await coronium.proxies.rotate(proxy._id);
// result.state is "done", "rotating" (poll, do not resubmit) or "unchanged"
```

## Spending is off by default

Buying and renewing charge real money, so both packages keep them switched off until you opt in:

- SDK: `new Coronium({ token, allowSpending: true })`, and every `spending.buy` or `spending.renew` call needs `expectedTotalUsd`, the total the user approved. A fresh quote above it is refused with `price_changed` before anything is sent.
- CLI: `coronium spending on` (or `CORONIUM_ALLOW_SPENDING=1`), and every `buy` or `renew` prints the price and still needs `--max-total <usd>` and `--yes`.

Cards are not supported by either package. Purchases use account credit or the BTC wallet.

## How 1.0 stays in sync with the API

- **Route fixture.** [`packages/sdk-ts/test/fixtures/v3-routes.json`](./packages/sdk-ts/test/fixtures/v3-routes.json) lists every public `/api/v3` route (method, path, auth, request and response field names). A test fails if any SDK call targets a route that is not in it.
- **Loopback fixture server.** Behaviour tests for the SDK and CLI run against a local replica that answers the way production does, including the redirect-to-HTML that production sends for unknown routes.
- **Strict transport.** No redirects are followed, a non-JSON 2xx is an error, mutations are never retried, the token is sent only as a Bearer header, and a failed purchase tells you whether the outcome is unknown or refunded.

## Development

```bash
pnpm install
pnpm build
pnpm test        # SDK and CLI suites (plus the legacy apps/api suite)
pnpm run doctor      # pre-publish checks: dist present, no secrets, no internal identifiers
```

Point the CLI at a local server with `CORONIUM_BASE_URL=http://127.0.0.1:<port>/api/v3`. Plain HTTP is accepted only on localhost.

## Other folders

- `skills/`: Claude skills for embedding wallet sign-up and chat in a website.
- `apps/api`, `apps/mock-api`, `apps/web`: the reference server, mock and site for the earlier 0.x design. They are not used by the 1.0 packages and are kept for reference only.

## Releasing

See [RELEASE.md](./RELEASE.md). Publishing is done by a maintainer, never by CI on a push.

## Support

Questions, partnerships and security reports: hello@coronium.io. Bugs and feature requests: [GitHub issues](https://github.com/bolivian-peru/coronium-ai/issues).

## License

[Apache-2.0](./LICENSE).
