# Troubleshooting — common signup failures

Branch on the `code` field, never the `message`. The `message` may change in future releases; codes are stable.

## During challenge issuance (`POST /redeem-challenge`)

| Code | What's happening | What to tell the user |
|---|---|---|
| `INVALID_REQUEST` | Body schema failed Zod parse — usually a malformed wallet address (not 0x + 40 hex) | "That doesn't look like a valid wallet address. Did you paste the right thing?" |
| `VOUCHER_NOT_FOUND` | Voucher code doesn't exist | "Voucher not recognized. Check for typos. Get a new one at coronium.ai/free." |
| `VOUCHER_CONSUMED` | Someone (possibly you) already redeemed this voucher | "This voucher's already been redeemed. If that was you and you lost your account, use 'restore from wallet' instead." |
| `VOUCHER_EXPIRED` | Past `expires_at` | "This voucher expired on \[date]. Get a fresh one." |
| `WALLET_ALREADY_REGISTERED` | This wallet has an existing Coronium account; new signup blocked | "This wallet's already linked to an account. To get a fresh API key, use 'rotate' instead of 'redeem'." Show a button that goes to your `key/rotate-challenge` flow. |

## During redemption (`POST /redeem`)

| Code | What's happening | Most likely cause | Fix |
|---|---|---|---|
| `INVALID_REQUEST` | Signature isn't 0x + 130 hex chars | Buggy signing path or `eth_sign` instead of `personal_sign` | Use `personal_sign` (EIP-191), not `eth_sign` (EIP-712 / typed-data). With viem, that's `account.signMessage({ message })`. |
| `SIWE_PARSE_ERROR` | Message can't be parsed as EIP-4361 | Client edited the message before signing — added/stripped whitespace, normalized the address case, etc. | **Sign the message verbatim.** Treat it as opaque bytes. Don't reformat. |
| `SIWE_DOMAIN_MISMATCH` | Domain in message ≠ `api.coronium.ai` | Client constructed its own SIWE message instead of using the one from `redeem-challenge` | Don't construct messages yourself — always use the challenge's `siwe_message`. |
| `SIWE_URI_MISMATCH` | URI ≠ `https://api.coronium.ai/v1/account/redeem` | Same as above | Same as above |
| `SIWE_CHAIN_MISMATCH` | Chain ID in message ≠ 8453 (Base) | Same as above | Same as above |
| `SIWE_INVALID_SIGNATURE` | Signature doesn't recover to the wallet address in the message | Wallet that signed isn't the one the challenge was issued to (e.g., user switched wallets in MetaMask between challenge and signature) | Re-issue a challenge for the now-active wallet. |
| `VOUCHER_MISSING` | SIWE message has no voucher resource line | Crafted message didn't include the `urn:coronium:voucher:…` Resources entry | Use the verbatim challenge — don't reconstruct. |
| `CHALLENGE_UNKNOWN` | Nonce in the message wasn't issued by us | Tampered message or an old saved message from a prior session | Re-call `redeem-challenge`. |
| `CHALLENGE_VOUCHER_MISMATCH` | Nonce was issued for a different voucher than the one in the message | The message resources line was edited | Use the verbatim challenge. |
| `CHALLENGE_ADDRESS_MISMATCH` | Nonce was issued for a different wallet | User signed with wallet B but the challenge was for wallet A | Re-issue challenge with the actual wallet. |
| `CHALLENGE_USED` | This nonce was already consumed | The user clicked Redeem twice; OR more than 5 minutes passed since the challenge | Re-call `redeem-challenge`. Educate the UI: don't double-submit. |
| `INTERNAL` | Unexpected server error | Something broke server-side (bug, db error, upstream-unavailable) | Surface a friendly "something went wrong" with a `Retry` button. Log the request_id from the response. |

## During key rotation (`/key/rotate-challenge` + `/key/rotate`)

Same family of codes as above, plus:

| Code | What's happening |
|---|---|
| `WALLET_NOT_REGISTERED` | This wallet has no Coronium account. Maybe the user typo'd the address; or signed up with a different wallet they don't realize. |
| `CHALLENGE_PURPOSE_MISMATCH` | Used a `redeem`-purpose challenge for `rotate`, or vice versa. Each endpoint has its own challenge type. |

## Network / browser-level errors

These come from `fetch` / wallet APIs, not the Coronium server:

| Symptom | Likely cause | Fix |
|---|---|---|
| `NO_INJECTED_WALLET` | `window.ethereum` is undefined | User has no MetaMask. Show fallback to "generate a wallet" mode. |
| User rejected request | They clicked Cancel in the wallet popup | Show neutral message "Signing cancelled. Try again." Don't re-prompt automatically. |
| `Failed to fetch` / CORS | API origin not in your CORS allowlist, OR the user is offline | Confirm `apiBase` is reachable. The deployed API has CORS for coronium.ai + dashboard.coronium.io by default; partner sites need to be added or use an iframe served from one of those origins. |
| `network::ERR_CERT_AUTHORITY_INVALID` | TLS issue on the API | Verify api.coronium.ai is correctly TLS-terminated. |
| Signature is `0x...95` length 132 | viem returns 65 bytes (130 hex), but some wallets return EIP-712 typed-data signatures (132+) | Force `personal_sign` / `eth_signMessage`. Don't use `signTypedData`. |

## Debug recipe

When a redemption fails and you can't tell why, dump the four pieces:

```js
console.log("voucher:", voucher);
console.log("address:", address);
console.log("siwe_message:\n" + siwe_message);
console.log("signature:", signature);
```

Then verify locally with viem:

```js
import { recoverMessageAddress } from "viem";
const recovered = await recoverMessageAddress({ message: siwe_message, signature });
console.log("recovered:", recovered, "expected:", address);
```

If `recovered !== address`, the signature is bad — wallet bug or wrong wallet. If they match but the server still says `SIWE_INVALID_SIGNATURE`, the issue is somewhere between you and the server (proxy, message mutation, character encoding).

## When all else fails

1. Test against the local mock first — `pnpm dev:api` from the coronium-ai repo gives you `http://127.0.0.1:5050` with a fresh DB. Mint a voucher with `node scripts/mint-vouchers.mjs --count 1 --batch debug`.
2. If it works against local mock but fails against `api.coronium.ai`, the issue is environmental (network, CORS, TLS, etc.).
3. If it fails against both, your client is bugged. Compare to the working examples in `react.md` and `vanilla-html.md`.
