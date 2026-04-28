# Wallet-bound voucher signup — auth design

> **Audience.** People extending coronium-ai, third-party integrators, and
> security reviewers. If you only want to *use* the CLI, see the README.

## TL;DR

Every Coronium account is bound to an **EVM wallet** (secp256k1 keypair, `0x…` address). Signups are gated by **single-use vouchers** distributed by Coronium / partners / affiliates. Both are required:

- **Voucher** — proves "you have permission to create an account." Bearer-revealable; safe to distribute publicly.
- **EVM keypair** — proves "you own this account, forever." Signature-revealable only; loss = lost account.

Auth uses [EIP-4361 (Sign-In with Ethereum / SIWE)](https://eips.ethereum.org/EIPS/eip-4361) with domain pinning to `api.coronium.ai`, chain ID `8453` (Base mainnet). The CLI handles all signing transparently. The agent-facing API key (`sk_live_…`) is just a credential bound to the wallet — re-issuable from a wallet signature, no email recovery needed.

## Threat model

| Attack | Defense |
|---|---|
| Mass-signup spam | Voucher inventory — Coronium controls issuance |
| Voucher theft (intercepted in delivery) | SIWE signature requirement; voucher only redeems with a paired wallet's private key |
| Database breach reveals API keys | Server stores only `wallet_address` + `scrypt(api_key)` |
| Server / insider compromise | Funds in user's own wallet (USDC on Base/Arbitrum/Optimism) — server can't move them |
| Lost API key | Wallet signs a "rotate" challenge → server issues a fresh `sk_live_…` |
| Lost wallet file but kept mnemonic | Restore wallet from BIP39 → re-sign rotate challenge |
| Lost mnemonic | Account is gone (same as a real crypto wallet — accepted tradeoff) |
| Cross-app SIWE replay | Domain pinning (`api.coronium.ai`) + chain ID (`8453`) + per-request nonce |
| Replay of consumed nonce | `redeem_challenges` table tracks consumption atomically |

## Schema

Three new tables on top of the v1 schema (see `apps/api/src/db/schema.sql`):

```
vouchers
  id (cor_v1_<32-base32>)                         PRIMARY KEY
  batch, campaign, affiliate_id                   attribution
  initial_credit_cents                            usually 50 ($0.50 trial)
  daily_cap_cents, session_cap_cents              optional per-voucher overrides
  expires_at                                      optional
  consumed_at, consumed_by_account_id             null = unused
  created_at, notes

redeem_challenges
  nonce (32-byte hex)                             PRIMARY KEY
  voucher_id                                      bound at issue time
  wallet_address (lowercased)                     bound at issue time
  expires_at                                      5-minute TTL
  consumed_at                                     atomic single-use
  created_at

accounts                                          (extended)
  + wallet_address (lowercased), wallet_chain="evm"
  + UNIQUE(wallet_chain, wallet_address) WHERE wallet_address IS NOT NULL
```

## Signup flow

```
       client (CLI / browser / sdk)                  server (apps/api)

1.    coronium init --voucher cor_v1_K7F3...
       ├── load or generate wallet                  ┌──────────────────────┐
       └── pubkey 0xABCDef…                         │  api.coronium.ai/v1  │
                                                     └──────────────────────┘
2.    POST /v1/account/redeem-challenge
        { voucher: "cor_v1_K7F3...",        ────►   look up voucher
          wallet_address: "0xABCDef…" }              check redeemable
                                                     check wallet not already used
                                                     mint nonce (32 hex)
                                                     INSERT redeem_challenges
                                            ◄────   { siwe_message, nonce, expires_at }

3.    sign siwe_message with privkey → 65-byte signature

4.    POST /v1/account/redeem
        { siwe_message, signature }        ────►    parse SIWE (siwe@2 lib)
                                                     verify domain == api.coronium.ai
                                                     verify chainId == 8453
                                                     verify signature recovers to address
                                                     atomic txn:
                                                       UPDATE redeem_challenges SET consumed_at
                                                       UPDATE vouchers SET consumed_at
                                                       INSERT accounts (wallet_address, …)
                                                       INSERT api_keys (scrypt-hashed)
                                            ◄────   { account_id, api_key (sk_live_…),
                                                       wallet_address, deposit_addresses,
                                                       balance_usd, daily_spend_cap_usd }

5.    store wallet at ~/.coronium/wallet.json (mode 0600)
       store api_key at ~/.coronium/config.toml (mode 0600)
       print mnemonic ONCE
```

The SIWE message text the user signs:

```
api.coronium.ai wants you to sign in with your Ethereum account:
0xABCDef…

Create a Coronium account by redeeming voucher cor_v1_K7F3....

URI: https://api.coronium.ai/v1/account/redeem
Version: 1
Chain ID: 8453
Nonce: <32 hex>
Issued At: 2026-04-28T20:00:00Z
Expiration Time: 2026-04-28T20:05:00Z
Resources:
- urn:coronium:voucher:cor_v1_K7F3...
```

This text is rendered as-is by MetaMask, Coinbase Wallet, Phantom (EVM mode), Rainbow, etc. Users see what they're signing.

## Recovery flow (lost API key, kept wallet)

```
1.    coronium key:rotate
       ├── load wallet from ~/.coronium/wallet.json
       └── address known
                                                    ┌──────────────────────┐
2.    POST /v1/account/key/rotate-challenge        │  api.coronium.ai/v1  │
        { wallet_address }                ────►    look up account by wallet
                                                    mint nonce
                                            ◄────   { siwe_message, nonce, expires_at }

3.    sign siwe_message

4.    POST /v1/account/key/rotate
        { siwe_message, signature }       ────►    verify SIWE
                                                    consume nonce
                                                    revoke all existing api_keys
                                                    issue fresh sk_live_…
                                            ◄────   { account_id, api_key, wallet_address }

5.    update ~/.coronium/config.toml
```

## Recovery flow (lost everything except mnemonic)

```
coronium init --restore
  → prompt for mnemonic
  → derive keypair (BIP-39 → secp256k1)
  → save wallet.json
  → run rotate-challenge / rotate flow above
```

## Key derivation

Default path is the standard EVM derivation `m/44'/60'/0'/0/0`. The same mnemonic imported into MetaMask, Phantom (EVM), Rabby, etc. yields the same address. Users can move their account between wallets freely.

## Wallet storage

```
~/.coronium/
├── wallet.json    # JSON: { address, privateKey, mnemonic?, derivation_path?, … }   chmod 0600
├── seed.txt       # 12-word mnemonic in plain text (optional)                       chmod 0400
└── config.toml    # api_key, base_url, optional email                                chmod 0600
```

`wallet.json` is shaped after MetaMask's account export — not a compatibility format per se, but easy to import. We do not encrypt the wallet at rest in v0.1; encryption-at-rest with an Argon2-derived passphrase is on the roadmap for v0.3.

## Voucher lifecycle

```
mint        →  issued      →  in challenge      →  consumed
             (DB row)         (challenge issued    (account created,
                                wallet not yet      consumed_at != NULL)
                                signed)
```

Vouchers are minted via `scripts/mint-vouchers.mjs` (operator tool) or via a partner API endpoint that's gated behind affiliate-program membership (planned, not yet built). Each voucher includes:

- `initial_credit_cents` — usually 50 ($0.50 trial). Some campaigns may grant more.
- `daily_cap_cents` / `session_cap_cents` — optional per-voucher overrides for partner deals.
- `affiliate_id` — populated when the voucher is issued through an affiliate, so the resulting account is automatically attributed.
- `expires_at` — optional. Limited-time campaigns can mint vouchers with a hard expiry.

Vouchers are bearer credentials in the sense that anyone holding the code can attempt redemption — but they can only redeem **once**, and only after pairing with a wallet they control. So a leaked voucher gives the finder $0.50 and a binding to whatever wallet they choose. That's the maximum damage.

## What is intentionally NOT in this design

- **No KYC.** Wallet ownership is the only identity signal. KYC may be required at a top reseller tier in the future, never for individual signup.
- **No email verification.** Users can attach an email tag, but it's a tag — not an auth factor and not used for recovery.
- **No password.** There's nothing to forget, nothing to phish.
- **No SMS / 2FA.** The wallet is the second factor by definition.
- **No CAPTCHA.** Vouchers are the rate limit.
- **No on-chain transaction at signup.** Signing is gas-free (EIP-191 personal_sign).

## Forward compatibility

- The schema includes `wallet_chain` (default `'evm'`) so adding Solana keypair support later is a column-value change, not a migration.
- `wallet_address` is stored lowercased to keep lookups case-insensitive; SIWE messages always use the EIP-55 checksum form.
- The unique constraint is `(wallet_chain, wallet_address)` so a single user could in theory have one EVM-bound and one Solana-bound account. Whether to allow that is a product decision.

## Operator playbook — minting vouchers

```bash
# 100 vouchers for a launch promo, $0.50 each
node scripts/mint-vouchers.mjs --count 100 --batch promo-2026-launch > vouchers-launch.txt

# 50 vouchers attributed to affiliate aff_acme01, $1.00 trial credit each
node scripts/mint-vouchers.mjs --count 50 \
  --batch acme-q2 --campaign acme --affiliate aff_acme01 \
  --credit 100 \
  > vouchers-acme.txt

# Time-limited (expires Dec 31, 2026)
node scripts/mint-vouchers.mjs --count 10 \
  --batch year-end --expires 2026-12-31 \
  > vouchers-year-end.txt
```

The `--db` flag points at the apps/api SQLite file (defaults to `apps/api/data/coronium.db`). On a deployed server it's whatever `DATABASE_PATH` env points to.

## Security review checklist

Before promoting this beyond alpha:

- [ ] Confirm `siwe@2`'s address-comparison is constant-time (or wrap it)
- [ ] Add rate-limiting on `/redeem-challenge` (per-IP, per-voucher) — currently relies on the global rate-limit
- [ ] Add observability: metric for redeem success/failure rates, voucher consumption velocity, challenge expiry rates
- [ ] Threat-model insider-mints (an operator with DB access mints vouchers and self-redeems) — mitigation is audit log + financial reconciliation, not crypto
- [ ] Encrypt `wallet.json` at rest with optional passphrase (Argon2id KDF)
- [ ] Document the voucher distribution channel security model (e.g., partners must use TLS-only fetches; vouchers in plaintext email are acceptable since theft just costs $0.50)
- [ ] Penetration test: replay attacks across the challenge/redeem boundary, malformed SIWE messages, voucher race conditions, signature malleability (EIP-191 should immune us but verify)
