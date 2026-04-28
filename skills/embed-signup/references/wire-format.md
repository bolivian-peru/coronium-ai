# Wire format — Coronium signup endpoints

Three endpoints. All `application/json` in/out. No bearer token required for `redeem-challenge` or `redeem` — they're the unauthenticated entry path. The fourth (`/balance` and the proxy verbs) all require `Authorization: Bearer sk_live_…` after redemption.

> **Source of truth:** [`coronium-ai/openapi.yaml`](../../../openapi.yaml). When in doubt, that file wins.

## 1. POST /v1/account/redeem-challenge

Issues a one-shot SIWE message bound to (voucher, wallet, nonce). Server stores the challenge with a 5-minute TTL.

### Request

```json
{
  "voucher": "cor_v1_K7F3abcdefABCDEFGhijkl0987654321",
  "wallet_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f2BD12"
}
```

- `voucher` — must be a non-consumed, non-expired voucher minted by Coronium (or a partner). Format `cor_v1_<32 chars>`. Server-validated.
- `wallet_address` — any valid EVM address. Server normalizes via `getAddress()` (EIP-55 checksum); accepts mixed-case, lowercase, or correctly-checksummed input.

### Response — 200

```json
{
  "siwe_message": "api.coronium.ai wants you to sign in with your Ethereum account:\n0x742d35Cc6634C0532925a3b844Bc9e7595f2BD12\n\nCreate a Coronium account by redeeming voucher cor_v1_K7F3abcdef….\n\nURI: https://api.coronium.ai/v1/account/redeem\nVersion: 1\nChain ID: 8453\nNonce: 9ab3de1f4c5b67890123456789abcdef\nIssued At: 2026-04-28T20:00:00.000Z\nExpiration Time: 2026-04-28T20:05:00.000Z\nResources:\n- urn:coronium:voucher:cor_v1_K7F3abcdef…",
  "nonce": "9ab3de1f4c5b67890123456789abcdef",
  "expires_at": "2026-04-28T20:05:00.000Z"
}
```

**Critical:** the client must sign the `siwe_message` **verbatim**, byte-for-byte. Do not reformat, reflow, normalise whitespace, or trim it. The server hashes the exact string for verification.

### Response — error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed body or invalid wallet address |
| 404 | `VOUCHER_NOT_FOUND` | Voucher doesn't exist in the DB |
| 409 | `VOUCHER_CONSUMED` | Voucher already redeemed by another wallet |
| 409 | `VOUCHER_EXPIRED` | Voucher's `expires_at` has passed |
| 409 | `WALLET_ALREADY_REGISTERED` | This wallet already has a Coronium account; tell the user to use `key:rotate` instead |

## 2. POST /v1/account/redeem

Verifies the SIWE signature, atomically consumes the voucher + challenge, mints the account + API key.

### Request

```json
{
  "siwe_message": "api.coronium.ai wants you to sign in…",
  "signature": "0xabcdef0123456789…  (65 bytes, 130 hex chars)"
}
```

- `signature` — the result of EIP-191 `personal_sign` over `siwe_message`. Format: `0x` + 130 hex chars. Both `viem.account.signMessage({ message })` (browser-native or Node) and MetaMask's `personal_sign` produce this.

### Response — 201

```json
{
  "account_id": "acc_01HXK4R2N4Z5T8B9G0",
  "api_key": "sk_live_<EXAMPLE_40_CHARS>",
  "wallet_address": "0x742d35cc6634c0532925a3b844bc9e7595f2bd12",
  "wallet_chain": "evm",
  "deposit_addresses": {
    "evm_native": "0x742d35cc6634c0532925a3b844bc9e7595f2bd12",
    "usdc_base":  "0x742d35cc6634c0532925a3b844bc9e7595f2bd12"
  },
  "balance_usd": 0.5,
  "daily_spend_cap_usd": 50
}
```

- `wallet_address` is **lowercased** in the response (canonical DB form). Mixed-case input is normalized.
- `api_key` is **shown ONCE**. Store it immediately. There is no way to retrieve it later — you have to rotate via `/v1/account/key/rotate-challenge` + `/rotate` (which requires re-signing with the wallet).
- `deposit_addresses.evm_native` is the user's own wallet address — they can receive USDC on Base, Arbitrum, Optimism, Ethereum mainnet, or Polygon to it.

### Response — error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed signature (not 130 hex chars) or missing fields |
| 400 | `SIWE_PARSE_ERROR` | The message is not a valid EIP-4361 string |
| 400 | `SIWE_DOMAIN_MISMATCH` | Domain isn't `api.coronium.ai` (cross-app replay attempt) |
| 400 | `SIWE_URI_MISMATCH` | URI isn't `https://api.coronium.ai/v1/account/redeem` |
| 400 | `SIWE_CHAIN_MISMATCH` | Chain ID isn't 8453 (Base mainnet) |
| 400 | `SIWE_INVALID_SIGNATURE` | Signature doesn't recover to the address in the message |
| 400 | `VOUCHER_MISSING` | SIWE message has no `urn:coronium:voucher:…` resource line |
| 400 | `CHALLENGE_UNKNOWN` | The nonce in the message wasn't issued by us |
| 400 | `CHALLENGE_VOUCHER_MISMATCH` | The nonce was issued for a different voucher |
| 400 | `CHALLENGE_ADDRESS_MISMATCH` | The nonce was issued for a different wallet |
| 409 | `CHALLENGE_USED` | Nonce already consumed (or expired) |
| 409 | `VOUCHER_CONSUMED` | Voucher consumed between the two calls (race) |
| 500 | `INTERNAL` | Unexpected server error — surface gracefully |

## 3. POST /v1/account/key/rotate-challenge + /v1/account/key/rotate

Exact same shape as `redeem-challenge` / `redeem`, but for rotating an existing account's API key. Used when a user lost their `sk_live_…` but still has the wallet.

`rotate-challenge` body: `{ "wallet_address": "0x…" }` — no voucher.

The signed message uses `purpose: rotate` and a synthetic resource URN of the form `urn:coronium:voucher:rotate-<account_id>`. Don't send this to first-time signups — it'll fail with `WALLET_NOT_REGISTERED`.

## Affiliate attribution

Vouchers can carry an `affiliate_id` at mint time:

```bash
node scripts/mint-vouchers.mjs --count 50 \
  --batch q2-acme-launch \
  --campaign acme-launch \
  --affiliate aff_acme01 \
  --credit 100 \
  --db /opt/coronium-api/data/coronium.db
```

Any account redeemed with one of those vouchers is automatically attributed to `aff_acme01` in the `attributions` table (when the affiliate program ships — Tier 1 design lives in the private monorepo's PRODUCTION_READINESS doc). The browser doesn't need to know about this; it's transparent.

If the affiliate program adds an additional **header-based** attribution path (e.g., `X-Coronium-Affiliate: <hmac-token>`), this skill will be updated.

## curl examples

End-to-end signup with a hand-rolled wallet via Foundry's `cast`:

```bash
# 1. Generate a wallet
PK=$(cast wallet new --json | jq -r '.[0].private_key')
ADDR=$(cast wallet address --private-key "$PK" | tr 'A-F' 'a-f')

# 2. Get challenge
CHALLENGE=$(curl -sS -X POST https://api.coronium.ai/v1/account/redeem-challenge \
  -H 'Content-Type: application/json' \
  -d "{\"voucher\":\"cor_v1_…\",\"wallet_address\":\"$ADDR\"}")

MSG=$(echo "$CHALLENGE" | jq -r .siwe_message)

# 3. Sign EIP-191 personal_sign
SIG=$(cast wallet sign --private-key "$PK" "$MSG")

# 4. Redeem
curl -sS -X POST https://api.coronium.ai/v1/account/redeem \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg msg "$MSG" --arg sig "$SIG" '{siwe_message:$msg,signature:$sig}')"
```

Replace `https://api.coronium.ai/v1` with `http://127.0.0.1:5050/v1` to test against a locally-running `apps/api/`.
