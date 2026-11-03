# coronium-mcp (deprecated)

**Use [`coronium-proxy-mcp`](https://github.com/coroniumio/coronium-proxy-mcp) instead:**

```bash
claude mcp add coronium -- npx -y coronium-proxy-mcp@2.4.2
```

Or connect the hosted server, nothing to install: `https://api.coronium.io/mcp` (OAuth sign-in, never spends) or `https://api.coronium.io/mcp/buyer` (can buy once you allow purchases).

`coronium-mcp` 0.2.0 and earlier targeted an API design that was never shipped. Against `https://api.coronium.io/api/v3`, six of its seven authenticated tools returned an HTML page that an agent could read as a successful result, including purchases and rotations that never happened. It will not receive further releases, and its source has been removed from this repository (it remains in git history).

`coronium-proxy-mcp` covers everything `coronium-mcp` did and more (proxies, rotation, catalog, renewals, tickets, webhook, and, with spending turned on and your approval, buying, renewing and moving USDT or BTC into account credit; `coronium_create_account` opens an account with no browser), and it fails loudly instead of returning false results.

For code, use [`coronium-sdk`](../sdk-ts) 1.0. For the shell, use [`coronium-cli`](../cli) 1.0.
