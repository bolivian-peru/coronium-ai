# coronium-cli

[![npm](https://img.shields.io/npm/v/coronium-cli.svg?label=coronium-cli)](https://www.npmjs.com/package/coronium-cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> Mobile 4G/5G proxies from your shell. Pay-per-hour USDC. No password, no email verification — every account is bound to an EVM wallet you control.

```bash
npm install -g coronium-cli
coronium init --voucher cor_v1_…
coronium proxy get --country US --type 5g
```

---

## Table of contents

- [Install](#install)
- [60-second quickstart](#60-second-quickstart)
- [How accounts work](#how-accounts-work)
- [Commands](#commands)
- [Configuration](#configuration)
- [Encrypted wallet at rest](#encrypted-wallet-at-rest)
- [Recovery — lost key, lost wallet, lost mnemonic](#recovery--lost-key-lost-wallet-lost-mnemonic)
- [Headless mode (CI, servers, AI agents)](#headless-mode-ci-servers-ai-agents)
- [JSON output for scripts and agents](#json-output-for-scripts-and-agents)
- [Troubleshooting](#troubleshooting)
- [Where things live on disk](#where-things-live-on-disk)
- [Updating, uninstalling](#updating-uninstalling)
- [Links](#links)

---

## Install

### Global install (recommended)

```bash
npm install -g coronium-cli
coronium --version
# 0.2.0
```

Requires Node.js 20 or newer. Works on macOS, Linux, and Windows.

### Run without installing

```bash
npx -y coronium-cli init --voucher cor_v1_…
```

Useful for one-off use, CI runners, or trying the tool before committing.

### Verify the install

```bash
coronium --help        # lists every command + flag
coronium status        # is the backend reachable? key valid? wallet present?
```

---

## 60-second quickstart

You need a voucher (`cor_v1_…`) to sign up. Get one free at <https://coronium.ai/free>.

```bash
# 1. Create an account — generates a wallet locally, signs SIWE, stores API key
coronium init --voucher cor_v1_K7F3abcdef…

# 2. Check what you have
coronium balance
# USDC            $0.50
# active proxies  0
# today's spend   $0.00 / $50.00 daily cap

# 3. Buy a proxy
coronium proxy get --country US --type 5g
# ✓ px_01HXK4R…
#   country  US (US-East)
#   carrier  T-Mobile · 5g
#   ip       57.31.11.238
#   http     http://u_db969:hl86ons@gw-us.coronium.ai:8443
#   socks5   socks5://u_db969:hl86ons@gw-us.coronium.ai:5443
#   expires  2026-04-30T02:27:45.079Z

# 4. Rotate the IP (verified externally — no false positives)
coronium proxy rotate px_01HXK4R…
# ✓ px_01HXK4R…: 57.31.11.238 → 158.197.55.110 (1842 ms)

# 5. Release when done (charged through end-of-current-hour)
coronium proxy release px_01HXK4R…
# ✓ Released px_01HXK4R…
```

---

## How accounts work

Coronium uses a **wallet-bound, voucher-gated** signup model. Two credentials, neither sufficient alone:

- A **voucher** (`cor_v1_<32 chars>`) — single-use, gates signup. Distributed by Coronium and partners. Bearer-revealable but useless on its own (a stolen voucher just gets the thief $0.50 of trial credit and a binding to whatever wallet they choose).
- An **EVM wallet** — your immutable account identity. The CLI generates a fresh wallet for you on first run (BIP-39, default derivation `m/44'/60'/0'/0/0`). The same mnemonic works in MetaMask, Rabby, Coinbase Wallet, and every other EVM wallet. The wallet doubles as your USDC deposit address — send USDC on Base / Arbitrum / Optimism / Ethereum directly to it to top up.

The third credential — the `eyJhbGc…` API key — is just an **operational token**. You can rotate it any time by signing a SIWE challenge with the wallet (`coronium key:rotate`).

### Recovery hierarchy (most-likely → least-likely loss)

| What you lose | Recoverable? | Command |
|---|---|---|
| `eyJhbGc…` API key | **Yes** | `coronium key:rotate` (signs with current wallet) |
| `~/.coronium/wallet.json` (but kept the mnemonic) | **Yes** | `coronium init --restore` (rebuild from 12 words) |
| Wallet AND mnemonic | **No** | Same deal as any crypto wallet — write down the seed phrase |

This is why `coronium init` shows your 24-word seed phrase **once** and saves it to `~/.coronium/seed.txt` (mode `0400`, owner-readable only). You can also encrypt it at rest — see [Encrypted wallet at rest](#encrypted-wallet-at-rest) below.

### Why EVM (and not Solana / Bitcoin)?

EVM addresses work across the entire Ethereum / Base / Arbitrum / Optimism / Polygon ecosystem with a single keypair. Sign-In with Ethereum (EIP-4361) is a real auth standard with native UI in MetaMask. USDC on Base is fast (~2s finality) and cheap (~$0.01 per transfer).

The same BIP-39 24-word mnemonic format used here is supported by every mainstream EVM wallet — MetaMask, Rabby, Coinbase Wallet, Trust, Frame. Import your mnemonic into any of them and you have the same Coronium account.

---

## Commands

```text
coronium [--json]
├── init          create or restore an account
├── key:rotate    issue a fresh API key by signing with your wallet
├── status        diagnose: backend reachable? key valid? wallet present?
├── balance       USDC balance + spend caps
├── deposit       USDC deposit address (Base / Tron / Ethereum)
├── tariffs       list available proxy plans
├── wallet:encrypt   encrypt wallet.json with a passphrase (AES-256-GCM)
├── wallet:decrypt   decrypt a previously-encrypted wallet
└── proxy
    ├── get        buy one or more proxies
    ├── list       show your active proxies
    ├── rotate     rotate the IP on a proxy (verified externally)
    ├── replace    swap a stuck proxy for a fresh one (same country/carrier)
    └── release    release a proxy
```

### `coronium init` — create or restore an account

```bash
coronium init --voucher cor_v1_K7F3abcdef…
```

**What happens, step by step:**

1. Reads `--voucher` from CLI flag, or `CORONIUM_VOUCHER` env, or prompts.
2. Generates an EVM wallet locally (or imports an existing mnemonic / private key — see flags below).
3. Asks the API for a SIWE challenge bound to (voucher, your wallet address, fresh nonce).
4. Signs the challenge with your wallet's private key (gas-free, EIP-191 personal_sign).
5. Posts the signature back to the API. Server verifies, atomically consumes the voucher, mints your account, returns an `eyJhbGc…` key.
6. Saves wallet to `~/.coronium/wallet.json` (mode `0600`), seed to `~/.coronium/seed.txt` (mode `0400`), API key to `~/.coronium/config.toml` (mode `0600`).
7. Prints the seed phrase **once**, prominently. Save it.

**Flags:**

| Flag | Effect |
|---|---|
| `--voucher <code>` | Voucher to redeem. Also reads `CORONIUM_VOUCHER` env. |
| `--restore` | Skip voucher path. Restore an existing account by signing a key-rotation challenge. |
| `--no-prompt` | Headless mode. Fail loudly instead of prompting. See [Headless mode](#headless-mode-ci-servers-ai-agents). |
| `--print-mnemonic` | Emit the new mnemonic in stdout (or in `--json` output). Default: only saved to `seed.txt`. |
| `--wallet-from <new\|mnemonic\|privkey>` | Override the wallet source (skips the interactive picker). |
| `--email <addr>` | Optional email tag (no verification, just metadata). |
| `--api-key <key>` | Bypass everything: just store an existing key. |

### `coronium init --restore` — recover an existing account

When you have your wallet (or the mnemonic) but lost the API key:

```bash
# If your wallet.json is still on this machine — just signs with it
coronium init --restore

# If your wallet.json is gone but you have the mnemonic
coronium init --restore   # interactive: pick "Mnemonic phrase", paste 12-24 words

# Headless equivalent
CORONIUM_NON_INTERACTIVE=1 \
  CORONIUM_WALLET_MNEMONIC="abandon idea drift…" \
  coronium init --restore --json
```

The CLI signs a `key:rotate` SIWE challenge with your wallet, the server matches the wallet to your account, and you get a fresh `eyJhbGc…`.

### `coronium key:rotate` — refresh the API key

Useful if the key leaked, was committed to a repo by accident, or you just want a clean state:

```bash
coronium key:rotate
# ✓ New API key issued. Old keys revoked.
#   api key  eyJhbGc…NEW…
```

Server-side, all your previous keys are revoked atomically. The new key is bound to the same wallet.

### `coronium status` — diagnostic

```bash
coronium status
# Coronium status
#
#   base url        https://api.coronium.io/api/v3
#   backend         ✓ ok (87ms)
#   api key         ✓ configured
#   auth            ✓ valid
#   wallet          ✓ 0x742d35cc6634c0532925a3b844bc9e7595f2bd12
#   mnemonic file   ✓ stored

coronium status --json
# {
#   "config": { "base_url": "...", "api_key": "eyJhbGc…(set)", ... },
#   "backend": { "health": "ok", "latency_ms": 87 },
#   "auth": { "ok": true }
# }
```

When something's broken, `status` tells you exactly what and suggests the fix.

### `coronium balance`

```bash
coronium balance
# USDC            $4.98
# hours at burn   249.0
# active proxies  1
# today's spend   $0.02 / $50.00 daily cap
# session cap     $5.00
```

`hours at burn` is `balance ÷ (active_proxies × $0.02/hr)` — how long your current load runs before you're empty.

### `coronium deposit`

```bash
coronium deposit
# ✓ Deposit address (base)
#   0xAbC123…1234
#   expires  2026-04-30T18:30:00.000Z

coronium deposit --chain tron
coronium deposit --chain base --amount 25       # pre-creates an invoice
```

For EVM chains (`base`, `ethereum`), the deposit address is your own wallet — you can verify on-chain that funds went where they should.

### `coronium tariffs`

```bash
coronium tariffs --country US --type 5g
# US · T-Mobile · 5g  $0.48/24h  in stock  trf_us_tmobile_5g
# US · Verizon · 4g   $0.48/24h  in stock  trf_us_verizon_4g
```

### `coronium proxy get` — the hero verb

```bash
# Cheapest country, system picks the carrier
coronium proxy get --country US --type 5g

# Specific carrier
coronium proxy get --country US --type 5g --carrier tmobile

# Bulk
coronium proxy get --country DE --type 4g --qty 5

# Auto-rotating every 10 min, sticky for 8 hours
coronium proxy get --country US --type 5g --rotation 10m --ttl 8h --sticky

# Cap this single call at 100¢ ($1) regardless of account default
coronium proxy get --country DE --qty 50 --cost-cap-cents 100
```

If out of stock for what you asked, you get a friendly error with alternatives:

```text
error[STOCK_OUT] That country/carrier combination is out of stock right now.
  Available alternatives:
    • US / T-Mobile (12 in stock)
    • GB / Three (8 in stock)
  Re-run with --country us.
```

### `coronium proxy list` / `rotate <id>` / `replace <id>` / `release <id>`

```bash
coronium proxy list
# px_01HXK4R…  US · T-Mobile · 5g  ip=57.31.11.238  expires=2026-04-30T02:27:45Z

coronium proxy rotate px_01HXK4R…
# ✓ px_01HXK4R…: 57.31.11.238 → 158.197.55.110 (1842 ms)

coronium proxy replace px_01HXK4R…   # if rotate gives CARRIER_NO_OP
# ✓ Replaced. New proxy:
#   px_01HXK5S… …

coronium proxy release px_01HXK4R…
# ✓ Released px_01HXK4R…
```

`rotate` is **verified** — Coronium confirms the new IP changed by hitting an external endpoint after the rotation. A `200` response means the IP actually changed; a `409 CARRIER_NO_OP` means the carrier didn't release the IP after retries (try `replace` instead).

---

## Configuration

The CLI reads config in this priority order (highest first):

1. **CLI flags** — `--voucher cor_v1_…` overrides everything else
2. **Environment variables** — `CORONIUM_API_KEY`, `CORONIUM_BASE_URL`, etc.
3. **`~/.coronium/config.toml`** — written by `coronium init`

### Environment variables

| Variable | Purpose |
|---|---|
| `CORONIUM_API_KEY` | Bearer token. Overrides the one in `config.toml`. Useful for CI / containers. |
| `CORONIUM_BASE_URL` | API base URL. Defaults to `https://api.coronium.io/api/v3`. Override for local dev / staging. |
| `CORONIUM_VOUCHER` | Default voucher for `init`. Same as `--voucher`. |
| `CORONIUM_WALLET_MNEMONIC` | For headless `init --restore` from a mnemonic. |
| `CORONIUM_WALLET_PRIVATE_KEY` | For headless `init --restore` from a private key. |
| `CORONIUM_WALLET_PASSPHRASE` | For unlocking an encrypted wallet without an interactive prompt. |
| `CORONIUM_NON_INTERACTIVE` | Set to `1` to enable headless mode (equivalent to `--no-prompt` on every command). |

### Files on disk

| Path | Mode | Contents |
|---|---|---|
| `~/.coronium/config.toml` | `0600` | API key, base URL, optional email tag |
| `~/.coronium/wallet.json` | `0600` | EVM wallet (privkey + mnemonic) — **plaintext OR encrypted** |
| `~/.coronium/seed.txt` | `0400` | Mnemonic phrase (only when wallet.json is plaintext; deleted on encrypt) |

---

## Encrypted wallet at rest

By default, `wallet.json` is plaintext (mode `0600`). That's fine for personal laptops where only your user can read your home directory. For shared servers, multi-user boxes, or any context where another principal could read your filesystem, encrypt the wallet:

```bash
coronium wallet:encrypt
# Encrypting wallet at /home/you/.coronium/wallet.json
# Passphrase ≥ 8 chars. We can't recover this for you — write it down.
# ? New passphrase: ********
# ? Confirm passphrase: ********
# ✓ Wallet encrypted at /home/you/.coronium/wallet.json
#   seed.txt removed — the mnemonic now lives only in the encrypted wallet.
```

**What encryption gives you:** AES-256-GCM authenticated encryption with a scrypt-derived key (N=131072, ~256 MB peak, ~200 ms derive). Tampering or wrong passphrase = decryption fails atomically with `WrongPassphraseError`. The same security primitives Bitcoin Core, MetaMask, and Phantom use for at-rest storage.

After encrypting, every command that needs the wallet (`key:rotate`, `init --restore`, etc.) prompts for the passphrase, or reads `CORONIUM_WALLET_PASSPHRASE` in headless mode.

To go back:

```bash
coronium wallet:decrypt
# ? Wallet passphrase: ********
# ✓ Wallet decrypted to plaintext
```

---

## Recovery — lost key, lost wallet, lost mnemonic

Three loss scenarios, three different paths:

### Lost only the API key (most common)

You still have `~/.coronium/wallet.json` on this machine.

```bash
coronium key:rotate
```

Done. Old keys revoked, new key issued, `config.toml` updated.

### Lost the wallet file (but kept the mnemonic)

```bash
coronium init --restore
# > Mnemonic phrase
# ? Recovery phrase: abandon idea drift forest banana table crown rocket idea drift forest banana
# ✓ Restored account: acc_01HXK4R…
```

The CLI re-derives the wallet from your mnemonic, signs a `key:rotate` challenge, and gets a fresh API key.

### Lost everything (no wallet, no mnemonic)

There is no recovery path. Same as a real crypto wallet — the seed phrase IS your account. This tradeoff is explicit and intentional: it means the server can't unilaterally take control of your account. Write down the mnemonic, ideally on paper, and store it offline.

---

## Headless mode (CI, servers, AI agents)

The CLI is designed to run unattended in CI, container start-up scripts, server-side processes, or as a subprocess invoked by an AI agent.

### Set it up via env vars only

```bash
export CORONIUM_VOUCHER="cor_v1_K7F3abcdef…"
export CORONIUM_NON_INTERACTIVE=1
coronium init --json --print-mnemonic
# {"account_id":"acc_…","api_key":"eyJhbGc…","wallet_address":"0x…","mnemonic":"abandon …","balance_usd":0.5,…}
```

`CORONIUM_NON_INTERACTIVE=1` is equivalent to passing `--no-prompt` on every command. The CLI will fail loudly with a clear error code (`VOUCHER_MISSING`, `MNEMONIC_MISSING`) instead of blocking on stdin.

### Restore from mnemonic in CI

```bash
export CORONIUM_NON_INTERACTIVE=1
export CORONIUM_WALLET_MNEMONIC="abandon idea drift forest banana table crown rocket …"
coronium init --restore --json
```

### Encrypted wallet on a server

Mount the encrypted `wallet.json` (e.g., from a secret manager) and inject the passphrase at runtime:

```bash
export CORONIUM_NON_INTERACTIVE=1
export CORONIUM_WALLET_PASSPHRASE="$(vault kv get -field=passphrase secret/coronium)"
coronium key:rotate --json
```

### Calling from an AI agent (Claude / GPT / etc.)

Each command supports `--json`, so an agent can invoke and parse without scraping pretty output:

```javascript
import { execFile } from "node:child_process";

const out = await new Promise((resolve, reject) => {
  execFile("coronium", ["proxy", "get", "--country", "US", "--type", "5g", "--json"], (err, stdout) => {
    if (err) return reject(err);
    resolve(JSON.parse(stdout));
  });
});

// out is an array of Proxy objects with id, host, ports, username, password, ip, …
```

For long-running agents, prefer the **MCP server** (`coronium-mcp`) or the **typed SDK** (`coronium-sdk`) over subprocess invocation — they're a better fit for tool-use loops.

---

## JSON output for scripts and agents

Every command supports `--json`. Pretty output goes to stderr; JSON goes to stdout. So you can pipe:

```bash
coronium proxy list --json | jq '.[] | select(.country == "US")'
coronium proxy get --country DE --json > my-proxy.json
```

Errors in JSON mode emit a structured envelope on stdout:

```bash
coronium balance --json   # without an API key
# {"error":{"code":"MISSING_KEY","summary":"No API key is set.","hints":["Get a voucher at …"]}}
```

Stable error codes (always check `error.code`, not `error.summary`):

`MISSING_KEY`, `INVALID_KEY`, `VOUCHER_NOT_FOUND`, `VOUCHER_CONSUMED`, `VOUCHER_EXPIRED`, `WALLET_ALREADY_REGISTERED`, `WALLET_NOT_REGISTERED`, `STOCK_OUT`, `INSUFFICIENT_BALANCE`, `CARRIER_NO_OP`, `SPEND_CAP_EXCEEDED`, `DAILY_CAP_EXCEEDED`, `RATE_LIMITED`.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| `error[MISSING_KEY] No API key is set.` | Run `coronium init --voucher …` (free vouchers at <https://coronium.ai/free>) or set `CORONIUM_API_KEY`. |
| `error[INVALID_KEY] Your API key isn't valid…` | Run `coronium key:rotate` if you have your wallet, or `coronium init --restore` from your seed phrase. |
| `error[VOUCHER_CONSUMED] This voucher's already been used.` | Get a new voucher, or run `coronium init --restore` if you've signed up before with this wallet. |
| `error[WALLET_ALREADY_REGISTERED]` | Your wallet already has an account. Run `coronium key:rotate` instead of `init`. |
| `error[STOCK_OUT]` | Use the suggested alternatives the error prints. Check `coronium tariffs` to see what's available. |
| `error[CARRIER_NO_OP]` | The carrier didn't release the IP. Try `coronium proxy replace <id>` instead of `rotate`. |
| `error[SPEND_CAP_EXCEEDED]` | Top up balance (`coronium deposit`) or override per-call with `--cost-cap-cents N`. |
| Network errors / timeouts | The CLI retries idempotent calls automatically (3 retries, 200ms→3.2s backoff). Persistent failure means the backend is unreachable; check `coronium status`. |
| `coronium init` blocks on a prompt in CI | Set `CORONIUM_NON_INTERACTIVE=1` and supply `CORONIUM_VOUCHER`. |

---

## Where things live on disk

```
~/.coronium/
├── config.toml      mode 0600  api_key, base_url, optional email
├── wallet.json      mode 0600  EVM wallet — plaintext OR AES-256-GCM encrypted
└── seed.txt         mode 0400  mnemonic (deleted when wallet is encrypted)
```

Move these between machines to take your account with you. The wallet file is the load-bearing one — `config.toml` can be regenerated by re-running `coronium init --restore` against any fresh machine that has the wallet (or its mnemonic).

---

## Updating, uninstalling

```bash
# Update to the latest stable (currently 0.2.0)
npm install -g coronium-cli@latest

# Note: the `alpha` / `beta` dist-tags are OLDER pre-release builds
# (0.1.0-alpha.4 / 0.2.0-beta.1) — `@latest` is the current release.

# Uninstall (your wallet and config remain in ~/.coronium/)
npm uninstall -g coronium-cli

# Hard reset (also removes wallet + config — IRREVERSIBLE)
npm uninstall -g coronium-cli && rm -rf ~/.coronium
```

The CLI checks the API's `Coronium-Api-Version` header on every call; you'll see a one-line warning when the server is ahead of your installed CLI.

---

## Links

- **Web**: <https://coronium.ai>
- **Get a free voucher**: <https://coronium.ai/free>
- **Public dashboard**: <https://dashboard.coronium.io>
- **API spec (OpenAPI)**: <https://dashboard.coronium.io/api-docs/>
- **Source**: <https://github.com/bolivian-peru/coronium-ai/tree/main/packages/cli>
- **Issues**: <https://github.com/bolivian-peru/coronium-ai/issues>
- **Companion packages**:
  - [`coronium-mcp`](https://www.npmjs.com/package/coronium-mcp) — MCP server for Claude / Cursor / Windsurf
  - [`coronium-sdk`](https://www.npmjs.com/package/coronium-sdk) — typed TypeScript client

## License

Apache-2.0. See `LICENSE` in the package.
