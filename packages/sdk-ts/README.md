# coronium-sdk

Typed TypeScript client for the [Coronium](https://www.coronium.io) mobile proxy API, `https://api.coronium.io/api/v3`. Node 20 or later, no runtime dependencies.

```bash
npm install coronium-sdk
```

```ts
import { Coronium, connectionUrls } from "coronium-sdk";

const coronium = new Coronium({ token: process.env.CORONIUM_API_TOKEN });

const account = await coronium.account.get();
console.log(`Account credit: $${account.accountCredit}`);

for (const proxy of await coronium.proxies.list()) {
  console.log(proxy.name, connectionUrls(proxy).socks5);
}
```

Create the token in the dashboard: dashboard.coronium.io, Account, API Access. The public catalog (`catalog.countries`, `catalog.tariffs`, `catalog.availableTariffs`, `catalog.stock`) works without a token.

## Upgrading from 0.x

0.x targeted an API that was never shipped: 8 of its 9 methods called routes that do not exist on `api.coronium.io` and returned an HTML page as the result. 1.0 is a rewrite; there is no compatible upgrade path, and nothing from 0.x worked to begin with.

## Client options

```ts
new Coronium({
  token,                    // optional for the public catalog
  baseUrl,                  // default https://api.coronium.io/api/v3 (https only, http allowed on localhost)
  allowSpending: false,     // must be true for spending.buy / spending.renew
  timeoutMs: 30_000,        // ordinary calls
  actionTimeoutMs: 180_000, // rotate, replace, test
  purchaseTimeoutMs: 180_000,
  fetch,                    // custom fetch for tests
});
```

## Methods

Every method maps to one real `/api/v3` route, listed in `ROUTES`.

**account**
- `get()`: identity, `accountCredit` (USD), `btc.balance`, `usdt.balance`.
- `cryptoBalances()`: BTC, USDT (TRC-20) and account-credit balances with deposit addresses. The first call creates the deposit wallets.
- `payment(paymentId)`: status of a payment, for example after a 202 purchase.

**catalog**
- `countries()`: countries with carriers and regions.
- `tariffs()`: every plan, including ones with no stock.
- `availableTariffs({ countryCode?, carrierId?, carrierName? })`: plans in stock, filtered client-side (the API ignores filters).
- `stock({ countryCode?, carrierId? })`: stock counts by country, carrier and region, with names resolved.
- `renewalQuote(items, coupon?)`: price a renewal of proxies you own. Read-only. Refuses a quote that leaves a proxy out or prices different days.

**proxies**
- `list()`, `get(idOrNameOrPortId)`: your proxies, with credentials (treat as secrets).
- `rotate(id)`: returns `{ state: "done" }`, `{ state: "rotating" }` (asynchronous provider: poll, never resubmit) or `{ state: "unchanged" }` (the carrier kept the IP; retry after the cooldown).
- `rotationStatus(id)`, `waitForRotation(id, { timeoutMs, intervalMs })`.
- `rotateByToken(token)`: the public rotation link. It is a GET that rotates on every fetch, so never paste it where link previews run.
- `replace(id)`: swap for another modem. Irreversible: new host, new credentials, default quota 2 per 24 hours.
- `openvpn(id, { proto? })`: profile text. Some providers issue a new certificate per call or allow one download.
- `test(id)`: the API's connectivity check, as `{ ok, extIp, error }`.
- `setWhitelist(id, ips)`: Coronium Node proxies only.

**tickets**: `list()`, `get(id)`, `create({ subject, message, category?, relatedProxies? })`, `reply(id, message)`, `archive(id)` (hides, does not close). Staff-only fields are stripped from every response.

**webhook**: `get()`, `set(httpsUrl)`, `delete()`, `rotateSecret()` (secret shown once), `test()`. Setting a webhook also turns on automatic replacement of dead proxies. Verify deliveries with `verifyWebhookSignature(rawBody, header, secret)`.

**wallet**: the HTTP half of voucher sign-up and key rotation for wallet-bound accounts: `challenge`, `signup`, `rotateChallenge`, `rotate`. You sign the SIWE message yourself (the CLI uses viem); the SDK has no wallet dependencies.

## Spending (charges money)

`spending.buy` and `spending.renew` **charge real money**. They are disabled unless the client is created with `allowSpending: true`, and each call needs `expectedTotalUsd`, the total the user approved.

```ts
const coronium = new Coronium({ token, allowSpending: true });

const quote = await coronium.spending.quoteBuy(tariffId, 1);        // read-only
// ...show quote.totalUsd to the user and get an explicit yes...
const receipt = await coronium.spending.buy({
  tariffId,
  quantity: 1,
  funding: "account_credit",      // or "btc"; there is no default
  expectedTotalUsd: quote.totalUsd,
});
```

What the SDK does for you:
- Re-reads the live price and stock right before sending. A total above `expectedTotalUsd` throws `price_changed` and nothing is sent. A lower price is accepted.
- Sends `max_total_usd` with the order so the API can enforce the cap once it supports it. Until then, the check is client-side and a price change in the seconds between check and charge is still possible.
- Sends an `Idempotency-Key` (generated, or yours). Identical concurrent calls in one process share one request; reusing a key for a different order throws `idempotency_conflict`.
- A buy sends only `tariff_id` and `modemCount`; a renewal sends only `modems`, never both.
- Coupons do not lower the check: the API can charge full price when a coupon is used up, so approve the undiscounted total.

Read the receipt:
- `status: "delivered"`: 200 with every ordered proxy.
- `status: "unverified"`: 200 but fewer proxies than ordered. **Do not buy again**; check `account.payment` and `proxies.list`.
- `status: "processing"`: 202. Poll `account.payment(receipt.paymentId)`.

## Errors

Every failure is a `CoroniumError` with `status`, `code` (as sent by the API, usually lowercase snake case), `message`, `requestId`, `retryAfterSeconds` and `outcome`:

- `rejected`: nothing changed.
- `unknown`: a write may have happened (5xx, timeout, network error, or a 2xx without confirmation). Check state before retrying.
- `refunded_not_charged`: the purchase failed and the API refunded it in the same response.

Use `error.isRateLimited` (HTTP 429) rather than matching codes; the API rewrites some rate-limit codes. The SDK never retries a request.

Codes the SDK adds itself: `route_not_found` (the API redirected, which means the route does not exist on that server), `invalid_response` (HTML, empty or malformed body), `not_authenticated`, `spending_disabled`, `price_changed`, `insufficient_stock`, `tariff_unavailable`, `incomplete_renewal_quote`, `idempotency_conflict`, `proxy_not_found`, `invalid_argument`, `timeout`, `network_error`.

## Support

hello@coronium.io

## License

Apache-2.0
