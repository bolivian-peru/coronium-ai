# @coronium/sdk-ts

Typed TypeScript client for the [Coronium](https://coronium.ai) mobile 4G/5G proxy API.

```bash
npm install @coronium/sdk-ts
```

```ts
import { Coronium } from "@coronium/sdk-ts";

const c = new Coronium({ apiKey: process.env.CORONIUM_API_KEY! });

// Buy
const [proxy] = await c.proxies.buy({ country: "US", type: "5g" });
console.log(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port_http}`);

// Rotate
await c.proxies.rotate(proxy.id);

// Release
await c.proxies.release(proxy.id);
```

## API surface (the 7 verbs)

```ts
c.account.create({ email? })   // POST /account/create   — sign up, returns API key
c.balance.get()                // GET  /balance
c.deposit.address({ chain? })  // POST /deposit/address
c.tariffs.list({ country? })   // GET  /tariffs
c.proxies.list()               // GET  /proxies
c.proxies.buy(req)             // POST /proxies
c.proxies.release(id)          // DELETE /proxies/{id}
c.proxies.rotate(id)           // POST /proxies/{id}/rotate
c.proxies.replace(id)          // POST /proxies/{id}/replace
```

## Error handling

All non-2xx responses throw `CoroniumError` with a stable `code` field. Stock-outs throw the more specific `CoroniumStockOutError` which exposes `suggestions` (alternative country/carrier in stock).

```ts
import { CoroniumStockOutError } from "@coronium/sdk-ts";
try {
  await c.proxies.buy({ country: "US", carrier: "tmobile" });
} catch (e) {
  if (e instanceof CoroniumStockOutError) {
    console.log("Try one of:", e.suggestions);
  } else throw e;
}
```

## Spend caps

Pass a one-shot cap on a single buy:

```ts
await c.proxies.buy({ country: "DE", qty: 5 }, { costCapCents: 100 }); // $1.00 max
```

Or set a default at construction time:

```ts
const c = new Coronium({ apiKey, costCapCents: 500 }); // $5 max per call
```

## Reference

- OpenAPI spec: <https://api.coronium.ai/openapi.yaml>
- Agent docs: <https://coronium.ai/AGENTS.md>
- Source: <https://github.com/bolivian-peru/coronium-ai/tree/main/packages/sdk-ts>

## License

Apache-2.0
