# coronium-sdk

[![npm](https://img.shields.io/npm/v/coronium-sdk.svg?label=coronium-sdk)](https://www.npmjs.com/package/coronium-sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> Typed TypeScript client for the [Coronium](https://coronium.ai) mobile 4G/5G proxy API. Browser- and Node-compatible. Built-in retry on transient failures.

```bash
npm install coronium-sdk
```

## Quickstart

```ts
import { Coronium } from "coronium-sdk";

const c = new Coronium({ apiKey: process.env.CORONIUM_API_KEY! });

// Buy a US 5G mobile proxy
const [proxy] = await c.proxies.buy({ country: "US", type: "5g" });
console.log(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port_http}`);

// Rotate the IP — verified externally, no false positives
await c.proxies.rotate(proxy.id);

// Release when done
await c.proxies.release(proxy.id);
```

Don't have an API key yet? Get a free voucher at <https://coronium.ai/free> and run `npm install -g coronium-cli && coronium init --voucher cor_v1_…` — that mints the key and stores it locally.

## API surface

The seven verbs, plus account creation:

```ts
c.account.create({ email? })             // POST /account/create — sign up, returns API key
c.balance.get()                           // GET  /balance
c.deposit.address({ chain? })             // POST /deposit/address (base | tron | ethereum)
c.tariffs.list({ country?, type? })       // GET  /tariffs
c.proxies.list()                          // GET  /proxies
c.proxies.buy(req, { costCapCents? })     // POST /proxies — the hero verb
c.proxies.release(id)                     // DELETE /proxies/{id}
c.proxies.rotate(id)                      // POST /proxies/{id}/rotate
c.proxies.replace(id)                     // POST /proxies/{id}/replace
```

Every method returns a fully-typed Promise. See `dist/types.d.ts` for the full schema.

## Error handling

All non-2xx responses throw a `CoroniumError` with a stable `code` field — branch on `code`, never on `message`. Stock-outs throw the more specific `CoroniumStockOutError` which exposes `suggestions` (alternative country/carrier in stock).

```ts
import { CoroniumError, CoroniumStockOutError } from "coronium-sdk";

try {
  const [proxy] = await c.proxies.buy({ country: "US", carrier: "tmobile" });
} catch (e) {
  if (e instanceof CoroniumStockOutError) {
    console.log("Out of stock. Try one of:", e.suggestions);
    // → [{ country: "GB", carrier: "Three", in_stock: 8 }, ...]
  } else if (e instanceof CoroniumError && e.code === "INSUFFICIENT_BALANCE") {
    console.log("Top up needed.");
  } else {
    throw e;
  }
}
```

Stable codes: `MISSING_KEY`, `INVALID_KEY`, `STOCK_OUT`, `INSUFFICIENT_BALANCE`, `SPEND_CAP_EXCEEDED`, `DAILY_CAP_EXCEEDED`, `CARRIER_NO_OP`, `RATE_LIMITED`, `VOUCHER_*`, `WALLET_*`. See the [OpenAPI spec](https://dashboard.coronium.io/api-docs/) for the full list.

## Spend caps

Server-enforced. Pass a one-shot cap on a single buy:

```ts
await c.proxies.buy(
  { country: "DE", qty: 5 },
  { costCapCents: 100 }, // $1.00 max — server returns SPEND_CAP_EXCEEDED if exceeded
);
```

Or set a default at construction time:

```ts
const c = new Coronium({ apiKey, costCapCents: 500 }); // $5 max per call
```

## Retries (built-in)

The SDK retries transient failures automatically — only on idempotent verbs. Network errors (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`) and HTTP `502`/`503`/`504` trigger up to 3 retries with exponential backoff (200 ms → 800 ms → 3200 ms) plus ±15% jitter.

| Method | Retried? |
|---|---|
| `balance.get()`, `tariffs.list()`, `proxies.list()` | ✅ — pure reads |
| `proxies.release()` | ✅ — second DELETE just 404s |
| `proxies.rotate()` | ✅ — rotating twice is fine |
| `account.create()` | ✅ — server-side idempotent on retry |
| `deposit.address()` | ✅ — returns existing address |
| `proxies.buy()` | ❌ — would double-charge |
| `proxies.replace()` | ❌ — creates a new proxy each call |

You don't need to do anything to enable this. If you'd rather control retries yourself, wrap calls in your own retry loop.

## Configuration

```ts
const c = new Coronium({
  apiKey: "eyJhbGc…",                            // required
  baseUrl: "https://api.coronium.io/api/v3",          // default; override for staging / local mock
  costCapCents: 500,                              // optional global per-call cap
  userAgent: "my-scraper/1.0",                    // shows up in API logs
  timeoutMs: 30_000,                              // per-attempt timeout
  fetch: customFetch,                             // optional; defaults to globalThis.fetch
});
```

`baseUrl` accepts the public API (`https://api.coronium.io/api/v3`), a self-hosted instance, or a local development mock (e.g., `http://127.0.0.1:5050/v1` running [coronium-ai/apps/mock-api](https://github.com/bolivian-peru/coronium-ai/tree/main/apps/mock-api)).

## Browser usage

Works in modern browsers without polyfills. Bundle with Vite, Webpack, or any other ES-module-aware tool:

```ts
import { Coronium } from "coronium-sdk";
const c = new Coronium({ apiKey: window.__CORONIUM_KEY__ });
const balance = await c.balance.get();
```

> **Storage warning:** never put `eyJhbGc…` keys in `localStorage` long-term. They're bearer credentials. Prefer first-party HTTP-only cookies or short-lived bootstrap tokens. See the [embed-signup security guide](https://github.com/bolivian-peru/coronium-ai/blob/main/skills/embed-signup/references/security.md).

## Reference

- API spec: <https://dashboard.coronium.io/api-docs/>
- Coronium homepage: <https://coronium.ai>
- Source: <https://github.com/bolivian-peru/coronium-ai/tree/main/packages/sdk-ts>
- Companion packages:
  - [`coronium-cli`](https://www.npmjs.com/package/coronium-cli) — same surface, from your shell
  - [`coronium-mcp`](https://www.npmjs.com/package/coronium-mcp) — MCP server for Claude / Cursor / Windsurf

## License

Apache-2.0
