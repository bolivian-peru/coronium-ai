# Security — what to do (and not do) with the wallet in browser

The wallet-bound model is *only* secure if the private key is treated like one. Browser environments are hostile by default — anything you put in `localStorage` is reachable by every script that loads on your page. Read this before persisting anything.

## The honest hierarchy of storage choices

From safest to most-dangerous:

1. **Don't persist at all.** Generate the wallet, finish the signup flow, prompt the user to download `wallet.json` + record the mnemonic, **discard from memory** when the user navigates away. Re-prompt for re-import on subsequent visits. — *Best for first-time signup.*
2. **Persist only the API key, not the wallet.** The `sk_live_…` key has bounded blast radius (per-day spend cap). If it leaks, rotate it via `key:rotate` (which requires the wallet — which the user re-imports). — *Best for the typical "user already has wallet, just signing back in" pattern.*
3. **Persist the wallet, encrypted with a passphrase.** Use Argon2id (via `argon2-browser` or similar) to derive a key from a user-typed passphrase, then AES-GCM-encrypt the wallet JSON. Store ciphertext in `IndexedDB` (NOT localStorage — IDB has stricter origin isolation in practice). On reload, prompt for passphrase to decrypt. — *Acceptable for users who explicitly opt in to "stay signed in."*
4. **Persist the wallet plaintext.** **Don't.** Any XSS, any rogue browser extension, any third-party script your site loads (analytics, chat widgets, error trackers) can read it. Never an option in production.

## Concrete advice for the React component

The `CoroniumSignup` component in `react.md` deliberately does NOT persist anything. Pattern for the integrator: handle persistence in `onSuccess`, owning the storage decision explicitly. Example for option 2 (persist only API key):

```tsx
<CoroniumSignup
  onSuccess={(r) => {
    sessionStorage.setItem("coronium_api_key", r.api_key);  // session-scoped, cleared on tab close
    // sessionStorage is still XSS-readable but not persisted across tabs/restarts.
    // For long-lived sessions, send the key to your own backend and use a
    // first-party HTTP-only cookie scoped to your domain.
  }}
/>
```

## Why `sessionStorage` is "less bad" than `localStorage`

Both are XSS-readable. The difference: `sessionStorage` is gone the moment the tab closes. So an attacker who runs an XSS payload that reads `sessionStorage` only gets data that's actively in use. `localStorage` includes data from a year ago.

For Coronium specifically, `sessionStorage` is the right default because the API key is rotatable — the cost of compromise is bounded.

## Why you should never `localStorage.setItem("coronium_wallet_privkey", …)`

If you do this and your site loads any of:
- A third-party analytics script (Sentry, Datadog, GA, Mixpanel)
- A live-chat widget (Intercom, Drift, Crisp)
- A user-generated-content embed (a blog comment, an iframe)
- An npm dependency that pulls in another npm dependency

…then any of those have read access to that key. There are real precedents of supply-chain attacks on npm packages reading wallet keys from `localStorage` (Solana wallet drains in 2024, MetaMask phishing extensions in 2023). **The browser is not a secure execution environment for raw keys.**

## CSP — set a strict Content Security Policy

If you control the site, add a CSP header that restricts script sources:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://esm.sh https://api.coronium.ai;
  connect-src 'self' https://api.coronium.ai;
  img-src 'self' data:;
  style-src 'self' 'unsafe-inline';
  frame-ancestors 'none';
```

Adjust `script-src` to match your actual ESM CDN. CSP doesn't prevent XSS but limits where data can be exfiltrated to. Coupled with a careful storage strategy, it's a meaningful defense.

## Subresource Integrity (SRI) for CDN imports

If you load viem from `esm.sh`, add SRI to pin the exact build:

```html
<script type="module" integrity="sha384-..." crossorigin="anonymous"
  src="https://esm.sh/viem@2.21.55/accounts"></script>
```

Note: `esm.sh` doesn't easily produce SRI hashes for ESM imports. A safer pattern: bundle viem yourself and serve it from your own origin.

## Iframe-embedding considerations

If you embed the signup flow in an `<iframe>` from another origin (e.g., a partner embeds `coronium.ai/signup` on their own dashboard):

- **The iframe origin owns the wallet.** Cross-origin scripts in the parent can't read the iframe's storage.
- **Use `postMessage` to pass the result up to the parent.** Validate the origin on both sides.
- **Set `frame-ancestors`** to allowlist exactly which parents can embed.

```js
// Inside the iframe, after redemption:
window.parent.postMessage(
  { type: "coronium:signup-success", account_id, api_key /* careful — see below */ },
  "https://approved-parent.example.com",
);
```

Sending the API key cross-origin via `postMessage` is itself a sensitive choice. Better: send only the `account_id` and `wallet_address`, and let the parent re-verify the user with a wallet signature on their own backend.

## Don't ask the user for their seed phrase to log in

Some sites do this. It's a pattern that conditions users to paste their phrase into ANY site that asks. Once they're conditioned, a phishing site can drain their actual wallet. **Never** ask for the seed phrase to "log in" — only as part of a deliberate "import wallet" action that the user explicitly initiated.

The Coronium signup flow does this correctly: seed phrase is shown once at generation, never asked back. Sign-back-in uses `personal_sign` with the active wallet (MetaMask popup) — no phrase typing.

## Threat model summary

| Threat | Mitigation in this skill |
|---|---|
| XSS reading localStorage | Don't persist privkey; sessionStorage for API key only |
| Rogue browser extension | The wallet is generated fresh in browser — extension can read it during the brief moment it's in JS memory. Mitigation: use MetaMask path instead, where the privkey lives in the extension's protected storage. |
| Phishing site copying the form | EIP-4361 includes the domain in the message — wallet UIs render this. The user sees what they're signing. |
| Replay attack | Server enforces 5-min TTL + one-shot nonces |
| MITM on the API | TLS everywhere; no http:// fallback; HSTS on api.coronium.ai |
| Voucher theft | Theft only valuable if combined with a wallet — voucher alone is worth $0.50 of credit |
| Compromised CDN serving viem | SRI hashes (when supported) or bundle viem yourself |

If your application has a stricter threat model than this skill assumes (e.g., you're handling enterprise admin accounts), use only the MetaMask path — never generate keys in browser memory.
