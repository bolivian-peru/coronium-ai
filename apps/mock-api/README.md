# coronium-mock-api

Tiny Express mock server implementing `coronium-ai/openapi.yaml`. **Not** the production API. For local CLI / MCP / SDK testing only.

```bash
pnpm dev:api
# → listening on http://127.0.0.1:5050
# → CORONIUM_BASE_URL=http://127.0.0.1:5050/v1
```

Then in another shell:

```bash
export CORONIUM_BASE_URL=http://127.0.0.1:5050/v1
coronium init                                   # mints a fake key, $0.50 trial credit
coronium proxy get --country US --type 5g       # mints a fake proxy
coronium proxy rotate <id>                      # ~5% chance of CARRIER_NO_OP for testing
coronium proxy release <id>
```

State is in-memory and resets on every restart. Stock-out is simulated by carrier capacity; rotation has a small randomized failure rate so error paths get exercised.

## What it does NOT do

- No real charges. No real proxies. No real carriers.
- No persistence. No database.
- No webhook integrations. No payment provider integrations.
- No HMAC validation, no x402.

## Adding a verb

1. Add it to `openapi.yaml`.
2. Add a handler in `src/index.ts`.
3. Add a fixture / state field in `src/state.ts` if needed.
4. Update the SDK + CLI + MCP to call it.
