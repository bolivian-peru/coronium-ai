# coronium-cli

Mobile 4G/5G proxies from your shell. Pay-per-hour USDC. No password, no email verification.

```bash
npm install -g coronium-cli
coronium init                                     # create account, store key
coronium proxy get --country US --type 5g         # buy a proxy
coronium proxy rotate px_01HX...                  # rotate IP (verified)
coronium proxy release px_01HX...                 # release when done
```

## Commands

| Command | What it does |
|---|---|
| `coronium init` | Create an account, store the API key in `~/.coronium/config.toml` |
| `coronium balance` | Show USDC balance and spend caps |
| `coronium deposit [--chain base\|tron\|ethereum]` | Get a deposit address (with optional pre-built invoice/QR) |
| `coronium tariffs [--country US] [--type 5g]` | List available proxy plans |
| `coronium proxy get --country US [...]` | Buy a proxy (1+ at a time) |
| `coronium proxy list` | List your active proxies |
| `coronium proxy rotate <id>` | Rotate the IP on a proxy (verified — never reports a no-op as success) |
| `coronium proxy replace <id>` | Replace a stuck proxy with a fresh modem in the same country/carrier |
| `coronium proxy release <id>` | Release a proxy |

Pass `--json` to any command for machine-readable output. Useful in scripts.

## Auth

The CLI looks for an API key in this order:

1. Environment variable `CORONIUM_API_KEY`
2. `~/.coronium/config.toml` (created by `coronium init`)

To use a different API endpoint (e.g. self-hosted): set `CORONIUM_BASE_URL` or `base_url` in the config.

## Spend caps

Server-enforced. Per-call override:

```bash
coronium proxy get --country DE --qty 5 --cost-cap-cents 100   # $1.00 max
```

## Reference

- API spec: <https://api.coronium.ai/openapi.yaml>
- Source: <https://github.com/bolivian-peru/coronium-ai/tree/main/packages/cli>

## License

Apache-2.0
