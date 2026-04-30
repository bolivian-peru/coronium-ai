# Vanilla HTML + viem — single-file embed

For static sites, landing pages, or anywhere you don't want a build step. Pure ES modules, viem loaded from a CDN. Drop the file on any web server (or open `assets/demo.html` from disk in a modern browser).

## The full standalone file

A polished version lives at [`../assets/demo.html`](../assets/demo.html). Minimal version below — copy-paste-able into any HTML page.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Coronium — sign up</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1rem; }
    input, button, code { font-family: ui-monospace, monospace; font-size: 14px; }
    input { width: 100%; padding: 8px; box-sizing: border-box; }
    button { padding: 8px 16px; cursor: pointer; }
    .step { display: none; }
    .step.active { display: block; }
    .alert { padding: 12px; border: 1px solid #c00; color: #900; border-radius: 4px; }
    .ok { padding: 12px; border: 1px solid #0a0; color: #060; border-radius: 4px; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
    .mn { letter-spacing: 0.5px; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Sign up to Coronium</h1>

  <section id="step-voucher" class="step active">
    <p>Paste your voucher to continue. <a href="https://coronium.ai/free">Get one</a>.</p>
    <form id="form-voucher">
      <input id="voucher" placeholder="cor_v1_…" autofocus required>
      <p style="margin-top: 12px;">
        <label><input type="radio" name="src" value="generate" checked> Generate a new wallet</label><br>
        <label><input type="radio" name="src" value="metamask"> Use MetaMask</label>
      </p>
      <button type="submit">Sign up</button>
    </form>
  </section>

  <section id="step-signing" class="step"><p>Signing — check your wallet for a prompt…</p></section>
  <section id="step-done" class="step"></section>
  <section id="step-error" class="step"></section>

  <script type="module">
    import {
      generateMnemonic,
      english,
      mnemonicToAccount,
    } from "https://esm.sh/viem@2/accounts";
    import { getAddress } from "https://esm.sh/viem@2";

    const API = window.CORONIUM_API_BASE ?? "https://api.coronium.io/api/v3";

    const $ = (id) => document.getElementById(id);
    const show = (name) => {
      for (const s of document.querySelectorAll(".step")) s.classList.remove("active");
      $(`step-${name}`).classList.add("active");
    };

    $("form-voucher").addEventListener("submit", async (e) => {
      e.preventDefault();
      const voucher = $("voucher").value.trim();
      const source = document.querySelector('input[name="src"]:checked').value;
      show("signing");
      try {
        const result = await signupFlow(voucher, source);
        renderDone(result);
      } catch (err) {
        renderError(err);
      }
    });

    async function signupFlow(voucher, source) {
      let address, signMessage, mnemonic;

      if (source === "generate") {
        mnemonic = generateMnemonic(english);
        const acc = mnemonicToAccount(mnemonic);
        address = acc.address;
        signMessage = (m) => acc.signMessage({ message: m });
      } else {
        if (!window.ethereum) throw apiError("NO_INJECTED_WALLET", "No EVM wallet detected. Install MetaMask.");
        const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
        if (!accs[0]) throw apiError("NO_INJECTED_WALLET", "No accounts returned");
        address = getAddress(accs[0]);
        signMessage = (m) =>
          window.ethereum.request({ method: "personal_sign", params: [m, address] });
      }

      const c = await fetchJson(`${API}/account/redeem-challenge`, "POST", {
        voucher,
        wallet_address: address,
      });
      const sig = await signMessage(c.siwe_message);
      const r = await fetchJson(`${API}/account/redeem`, "POST", {
        siwe_message: c.siwe_message,
        signature: sig,
      });
      return { ...r, mnemonic };
    }

    async function fetchJson(url, method, body) {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      if (!res.ok) {
        throw apiError(parsed?.code ?? `HTTP_${res.status}`, parsed?.message ?? res.statusText);
      }
      return parsed;
    }

    function apiError(code, message) {
      const e = new Error(message);
      e.code = code;
      return e;
    }

    function renderDone(r) {
      const html = `
        <div class="ok">
          <h2>You're in.</h2>
          <p>Account: <code>${r.account_id}</code></p>
          <p>Wallet: <code>${r.wallet_address}</code></p>
          <h3>API key (shown once)</h3>
          <p>Save this. Coronium cannot retrieve it later.</p>
          <pre>${r.api_key}</pre>
          ${
            r.mnemonic
              ? `
          <h3>Recovery phrase (shown once)</h3>
          <p>24 words. Save them — they are your account.</p>
          <pre class="mn">${r.mnemonic}</pre>
          <button id="dl">Download wallet.json</button>`
              : ""
          }
          <p>Trial credit: <strong>$${r.balance_usd.toFixed(2)}</strong>. Daily cap: <strong>$${r.daily_spend_cap_usd.toFixed(2)}</strong>.</p>
          <p>Send USDC on Base / Arbitrum / Optimism to your wallet to top up.</p>
        </div>`;
      $("step-done").innerHTML = html;
      show("done");
      const btn = $("dl");
      if (btn && r.mnemonic) {
        btn.addEventListener("click", () => {
          const blob = new Blob(
            [JSON.stringify({ address: r.wallet_address, mnemonic: r.mnemonic }, null, 2)],
            { type: "application/json" },
          );
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "coronium-wallet.json";
          a.click();
          URL.revokeObjectURL(url);
        });
      }
    }

    function renderError(err) {
      $("step-error").innerHTML = `
        <div class="alert">
          <h3>Couldn't sign you up</h3>
          <p><strong>${err.code ?? "UNKNOWN"}</strong>: ${err.message}</p>
          <button onclick="location.reload()">Try again</button>
        </div>`;
      show("error");
    }
  </script>
</body>
</html>
```

## Override the API base URL

Useful for local development against a running `apps/api/` mock or self-hosted backend:

```html
<script>window.CORONIUM_API_BASE = "http://127.0.0.1:5050/v1";</script>
<!-- ... module script below ... -->
```

## How to embed in an existing page

Wrap everything except `<!doctype>` and `<head>` styles in a `<section>` or `<div>`. The script tag is `type="module"` so it works alongside other scripts. The CDN import path can be swapped for any ESM-supporting CDN — `esm.sh`, `unpkg.com/viem@2?module`, `jsdelivr.net/npm/viem@2/+esm`.

## Pre-filling the voucher from a URL parameter

Drop this near the top of the script:

```js
const url = new URL(window.location.href);
const refVoucher = url.searchParams.get("ref");
if (refVoucher) {
  $("voucher").value = refVoucher;
}
```

Now `https://your-site.example.com/signup?ref=cor_v1_…` lands the user on a pre-filled form. Useful for affiliate/referral links.

## Browser support

- ES modules: every browser since 2018
- `crypto.getRandomValues`: ditto
- Top-level await: not used in the script above, so older Safari is fine
- Tested in Chrome 120+, Firefox 120+, Safari 17+, Edge 120+

## What this skips

- No CSS framework — bring your own. Drop the `<style>` block, replace `class="alert ok"` with your own, done.
- No analytics — bring your own.
- No complex error retry — refreshing is the simplest recovery (wastes one nonce; user gets a fresh challenge).
- No OAuth-style redirect flow — this is a single-page interaction. If you need to redirect after success, do it in `renderDone`.
