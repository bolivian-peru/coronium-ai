# coronium-cli

The `coronium` command for [Coronium](https://www.coronium.io) dedicated 4G/5G mobile proxies. Built on [`coronium-sdk`](https://www.npmjs.com/package/coronium-sdk) and the real `https://api.coronium.io/api/v3` API. Node 20 or later.

```bash
npm install -g coronium-cli
# or without installing: npx -y coronium-cli tariffs --country US
```

## Upgrading from 0.x

0.x commands other than `init` and `key:rotate` called routes that do not exist and could print success when nothing happened (for example `proxy rotate`). 1.0 is a rewrite. The renamed commands:

- `proxy get` (buy) is now `coronium buy --tariff <id> ...`. Running `proxy get` prints this hint and exits 2.
- `proxy release` is gone. Cancelling a proxy is done in the dashboard for now.
- `deposit` is now `coronium balance --crypto`.
- `CORONIUM_API_KEY` still works; `CORONIUM_API_TOKEN` is the new name.

## Sign in

```bash
export CORONIUM_API_TOKEN=...            # dashboard.coronium.io, Account, API Access
# or store it (verified, saved to ~/.coronium/config.toml with mode 0600):
coronium login --token <token>
coronium status
```

Wallet-bound accounts (voucher sign-up) keep working:

```bash
coronium init --voucher cor_v1_...      # creates a local EVM wallet, signs a SIWE challenge
coronium key:rotate                      # new token signed with the same wallet
coronium init --restore                  # import a wallet and get a new token
coronium wallet:encrypt                  # encrypt ~/.coronium/wallet.json at rest
```

`key:rotate` issues a new token but does not revoke earlier ones.

## Commands

Add `--json` to any command for machine-readable output.

Catalog (no token needed):
- `coronium countries`
- `coronium tariffs [--country US] [--carrier verizon]`: plans in stock with prices.
- `coronium stock [--country GB] [--carrier-id <id>]`: stock by country, carrier and region.
- `coronium quote buy --tariff <id> --count 2`

Account:
- `coronium balance [--crypto]`: account credit, BTC and USDT. `--crypto` lists deposit addresses and creates the deposit wallets on first use.
- `coronium payment <id>`
- `coronium quote renew <id>:<days> ...`: price a renewal, read-only.

Proxies (`<id>` can be the proxy id, its name or its port id):
- `coronium proxy list`: HTTP and SOCKS5 URLs, exit IP, expiry.
- `coronium proxy show <id>`
- `coronium proxy rotate <id> [--wait]`: prints `rotating` for asynchronous providers; never a false success.
- `coronium proxy rotation-status <id>`
- `coronium proxy replace <id> --yes`: new host and credentials, uses one of 2 replacements per 24 hours.
- `coronium proxy openvpn <id> [--tcp] [--out file.ovpn]`
- `coronium proxy test <id>`
- `coronium proxy whitelist <id> [ips...] --yes`: Coronium Node proxies only.

Support tickets:
- `coronium tickets list [--status open]`
- `coronium tickets show <id>`
- `coronium tickets create --subject "..." --message "..."`
- `coronium tickets reply <id> "<text>"`
- `coronium tickets archive <id>`: hides the ticket, does not close it.

Webhook:
- `coronium webhook show`
- `coronium webhook set <https-url> --yes`
- `coronium webhook delete --yes`
- `coronium webhook rotate-secret --yes`: the new secret is shown once.
- `coronium webhook test`

Setting a webhook also turns on automatic replacement of dead proxies, which changes their host and credentials.

## Buying and renewing (charges money)

Spending is **off by default**. Every spending command shows the price first and then refuses unless all three are present:

1. spending is on: `coronium spending on` (or `CORONIUM_ALLOW_SPENDING=1`);
2. `--max-total <usd>`: the most you approve for this order;
3. `--yes`.

```bash
coronium tariffs --country US
coronium buy --tariff <id> --count 1 --funding account_credit --max-total 49 --yes
coronium renew <proxy id>:30 --funding btc --max-total 139 --yes
coronium spending off
```

`--funding` is required: `account_credit` (USD credit) or `btc` (BTC wallet at the live rate). Cards are not supported. If the live total is above `--max-total`, the order is refused with `price_changed` and nothing is charged. Every order prints its idempotency key; pass it back with `--key` only to reconcile the same order.

## Exit codes

- `0` success
- `1` rejected by the API, or a check failed (rotation unchanged, connectivity test failed, webhook not delivered)
- `2` usage: missing flag, no token, spending off, missing `--yes`
- `3` outcome unknown: an order or change may have gone through. Check `coronium proxy list` or `coronium payment <id>` before retrying. Also used when a purchase is still processing or delivered fewer proxies than ordered.
- `4` the order failed and was refunded, nothing charged

## Configuration

- `CORONIUM_API_TOKEN` (or `CORONIUM_API_KEY`): API token. Overrides the stored one.
- `CORONIUM_BASE_URL`: default `https://api.coronium.io/api/v3`. Must be https, except `http://localhost` for testing.
- `CORONIUM_ALLOW_SPENDING=1`: allow `buy` and `renew` for this shell.
- `CORONIUM_NON_INTERACTIVE=1`, `CORONIUM_VOUCHER`, `CORONIUM_WALLET_MNEMONIC`, `CORONIUM_WALLET_PRIVATE_KEY`, `CORONIUM_WALLET_PASSPHRASE`: headless wallet flows.

Files live in `~/.coronium/` (`config.toml`, `wallet.json`, `seed.txt`), all owner-only.

## Support

hello@coronium.io

## License

Apache-2.0
