---
name: embed-signup
description: Embed Coronium agent-native signup directly into any web frontend — wallet generation, voucher redemption, SIWE signing, and API key issuance, all running browser-side. Use this skill whenever the user wants to add a "sign up" / "create account" / "connect wallet" / "onboard users to Coronium" / "embed the Coronium CLI" / "let users sign up on our site" flow into a website, dashboard, reseller portal, marketplace integration, or landing page — even if they don't explicitly say "Coronium" or "SIWE."
---

# Embed Coronium signup in any web frontend

Coronium's CLI (`coronium-cli`) is Node-only — it can't run in a browser. But the *signup flow* it implements is just three HTTPS calls plus an EIP-191 signature, all of which work in the browser. This skill explains how to recreate the same flow in a frontend so users can sign up directly from your site.

## When this triggers

Use this skill when the user is:

- Building a Coronium signup page on `coronium.ai`, a reseller dashboard, a partner site, or any web app
- Asking how to "let users sign up via the browser" / "skip the CLI install" / "embed the CLI in our frontend"
- Implementing a "Connect Wallet" / "Sign in with MetaMask" flow specifically for Coronium
- Wiring an affiliate referral page that auto-attributes new accounts
- Building a whitelabel marketplace that sells Coronium proxies under another brand

## Architecture in one diagram

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  Browser (your site)    │         │  api.coronium.io/api/v3          │
│                         │         │                              │
│  1. user pastes voucher │         │                              │
│  2. choose wallet       │         │                              │
│     ├─ generate (viem)  │         │                              │
│     └─ MetaMask (EIP)   │         │                              │
│                         │         │                              │
│                         ├────────►│  POST /account/redeem-       │
│                         │         │       challenge              │
│                         │         │  { voucher, wallet_address } │
│                         │◄────────┤  { siwe_message, nonce, … }  │
│  3. sign siwe_message   │         │                              │
│     (viem.signMessage   │         │                              │
│      OR personal_sign)  │         │                              │
│                         ├────────►│  POST /account/redeem        │
│                         │         │  { siwe_message, signature } │
│                         │◄────────┤  { account_id, api_key,      │
│                         │         │    wallet_address, … }       │
│  4. show api_key (once),│         │                              │
│     offer download of   │         │                              │
│     wallet.json         │         │                              │
└─────────────────────────┘         └──────────────────────────────┘
```

Every byte that's signed and verified comes from the user's keypair — your server never sees the private key. This is the same model as MetaMask "Sign in with Ethereum" — your site is just rendering the form.

## What the user needs before starting

1. **A voucher** in the format `cor_v1_<32 chars>`. Acquired via:
   - A Coronium operator (`scripts/mint-vouchers.mjs --count N --batch …` in the deployed apps/api)
   - The forthcoming `coronium.ai/free` self-service form
   - An affiliate / partner channel
2. **A wallet** — either generated in the browser (recommended for new users) or connected via MetaMask / WalletConnect (better for users who already have an EVM wallet).
3. **The Coronium API base URL**: `https://api.coronium.io/api/v3` in production, or wherever the integrator points. Until `api.coronium.ai` is deployed, use a local mock or staging URL.

## The three HTTP calls — exact wire format

See `references/wire-format.md` for full request/response schemas + curl examples. In short:

```
POST /v1/account/redeem-challenge
  { "voucher": "cor_v1_…",
    "wallet_address": "0x…"     (EIP-55 checksum form is fine, lowercase too) }
→ 200
  { "siwe_message": "…",        (EIP-4361 message string, signed verbatim)
    "nonce": "…",
    "expires_at": "ISO-8601" }

POST /v1/account/redeem
  { "siwe_message": "…",        (the EXACT string you got in the challenge)
    "signature": "0x…"          (65-byte / 130-hex personal_sign signature) }
→ 201
  { "account_id": "acc_…",
    "api_key": "sk_live_…",     (shown ONCE — store carefully)
    "wallet_address": "0x…",    (lowercased; this is the canonical form)
    "wallet_chain": "evm",
    "deposit_addresses": { "evm_native": "0x…", "usdc_base": "0x…" },
    "balance_usd": 0.5,
    "daily_spend_cap_usd": 50 }
```

Failures use stable `code` fields — `VOUCHER_NOT_FOUND`, `VOUCHER_CONSUMED`, `WALLET_ALREADY_REGISTERED`, `SIWE_INVALID_SIGNATURE`, `CHALLENGE_USED`. Branch on `code`, not `message`.

## Implementation paths

Pick one based on the integrator's stack:

| Path | When to use | See |
|---|---|---|
| **React + viem** (npm-bundled) | Most modern frontends — Next.js, Vite, CRA | `references/react.md` |
| **Vanilla HTML + viem via ESM CDN** | Static sites, landing pages, no build step | `references/vanilla-html.md` |
| **MetaMask / WalletConnect** (any framework) | Users who already have a wallet — skip the seed-phrase moment | covered in `references/react.md` and `references/vanilla-html.md` |

A working standalone HTML file lives at `assets/demo.html` — open it in a browser and it just works.

## Step-by-step guidance for an agent following this skill

1. **Ask the integrator for their stack.** React / Vue / Svelte / vanilla / static HTML. Read the matching reference file (`references/react.md` or `references/vanilla-html.md`).
2. **Confirm the API base URL.** Default `https://api.coronium.io/api/v3`, but for local development the user might point at `http://127.0.0.1:5050/v1` (running `apps/api/`) or `http://127.0.0.1:5050/v1` against the mock. Make the base URL configurable.
3. **Decide the wallet UX.** Two patterns:
   - **Generate a fresh wallet** — best for non-crypto users; shows a 24-word mnemonic ONCE; user must save it. Use `viem.generateMnemonic + mnemonicToAccount`.
   - **Use an existing wallet via MetaMask** — for users who already have one; faster, but requires `window.ethereum`. Use `personal_sign` for the SIWE message.
   - Recommend offering BOTH and letting the user pick.
4. **Wire the three HTTP calls.** Use `fetch`. Surface errors with the stable `code`. See `references/wire-format.md`.
5. **Display the result safely.** The `api_key` is shown ONCE — make the UI copy-friendly (clipboard button) and warn the user. If a wallet was generated, also offer **download** of the JSON wallet file (so the user can re-import in the CLI or in MetaMask).
6. **Read `references/security.md` BEFORE you store anything.** TL;DR: never put a private key in `localStorage` long-term; if you must persist for the session, encrypt with a passphrase or hold in memory and force re-entry.
7. **Test against errors.** Show what happens for `VOUCHER_NOT_FOUND`, `VOUCHER_CONSUMED`, `WALLET_ALREADY_REGISTERED`. See `references/troubleshooting.md`.

## Affiliate attribution (optional)

If the integrator is a Coronium affiliate / reseller, every redemption can carry attribution. Attribution is bound to the *voucher* (vouchers are minted with an `affiliate_id`), so an affiliate just needs to mint vouchers under their ID and distribute those. See `references/wire-format.md` § "Affiliate attribution" for the operator side. There's nothing the browser needs to do beyond passing the voucher.

## What this skill is NOT

- Not a "ship the Node CLI in the browser" path — that's not technically possible without a backend execution environment (Bun-in-browser, Wasm-pty, etc.). The CLI is reference code; the *flow* is what's portable.
- Not a wallet-storage-as-a-service — this skill stops at the redemption. How the integrator persists the wallet is their call (and is covered in `references/security.md`).
- Not a Stripe/credit-card top-up flow — all funding happens via USDC deposits to the user's wallet OR through the existing `dashboard.coronium.io` Stripe checkout. Out of scope here.

## Reference layout

```
skills/embed-signup/
├── SKILL.md (this file)
├── references/
│   ├── wire-format.md      ← exact request/response shapes, curl examples, error codes
│   ├── react.md            ← React + viem component, full source, drop-in
│   ├── vanilla-html.md     ← single-file HTML demo with viem via ESM CDN
│   ├── security.md         ← wallet-storage rules, anti-XSS, what NOT to do
│   └── troubleshooting.md  ← diagnose common failures by error code
└── assets/
    └── demo.html           ← working standalone demo — open in any modern browser
```

## Versioning

This skill targets `coronium-api` schema version 2 (the current production schema as of April 2026). If the API changes, this skill needs an update — check the `Coronium-Api-Version` response header against this skill's `compatible_with` field if you add one.
