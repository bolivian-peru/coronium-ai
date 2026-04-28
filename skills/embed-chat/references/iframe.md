# Iframe embed — `chat.coronium.ai`

Lowest-effort integration path. Coronium hosts a fully-styled chat at `chat.coronium.ai`; you embed it as an iframe.

## Drop-in HTML

```html
<iframe
  src="https://chat.coronium.ai?theme=dark&accent=%23FF6B35&brand=Acme%20Proxies"
  width="100%"
  height="600"
  frameborder="0"
  allow="clipboard-write"
  style="border-radius: 12px; border: 1px solid #e5e7eb;"
></iframe>
```

That's it for a generic chat. To pre-authenticate the user (so they don't have to paste an API key), you need a short bootstrap message via `postMessage` — see below.

## Pre-authentication via postMessage

Best pattern: your backend mints a short-lived (5-min) bootstrap token tied to the user's API key. Your frontend passes it to the iframe; the iframe exchanges it for a session.

```html
<iframe id="cor-chat" src="https://chat.coronium.ai?ready=postmessage" …></iframe>

<script>
  const iframe = document.getElementById("cor-chat");
  iframe.addEventListener("load", () => {
    iframe.contentWindow.postMessage(
      {
        type: "coronium:bootstrap",
        version: 1,
        // Either pass the API key directly (acceptable iff you trust the iframe origin)…
        api_key: "sk_live_…",
        // …or a short-lived token your backend got via /v1/auth/iframe-token
        // bootstrap_token: "btk_…",
      },
      "https://chat.coronium.ai",     // ALWAYS specify the origin — never "*"
    );
  });

  // Listen for status events from the iframe.
  window.addEventListener("message", (e) => {
    if (e.origin !== "https://chat.coronium.ai") return;     // origin check is critical
    if (e.data.type === "coronium:ready") {
      console.log("Chat is authenticated and ready");
    }
    if (e.data.type === "coronium:tool_result") {
      console.log("Agent did:", e.data.tool, e.data.result);
    }
    if (e.data.type === "coronium:error") {
      console.error("Chat error:", e.data.code, e.data.message);
    }
  });
</script>
```

## Query-string options

| Param | Default | Purpose |
|---|---|---|
| `theme` | `light` | `light` \| `dark` \| `auto` |
| `accent` | `%23FF6B35` | URL-encoded hex color |
| `brand` | (empty) | URL-encoded brand name shown in header |
| `logo` | (empty) | URL of brand logo (must be HTTPS, <50 KB) |
| `ready` | `auto` | `auto` (use API key from URL — INSECURE) \| `postmessage` (wait for postMessage bootstrap — RECOMMENDED) |
| `hide_badge` | `0` | Set to `1` only if your tenant is paid-tier (server validates) |

## Sandbox attributes

For maximum isolation, sandbox the iframe and grant only what's needed:

```html
<iframe
  src="https://chat.coronium.ai?ready=postmessage"
  sandbox="allow-scripts allow-same-origin allow-popups"
  allow="clipboard-write"
></iframe>
```

`allow-same-origin` is needed for the iframe's own origin code to function. `allow-scripts` is mandatory for the React app inside. Don't add `allow-top-navigation` — it lets the iframe break out of your page.

## What `chat.coronium.ai` IS NOT

- Not generally available yet. The iframe host is task #146 (Block N — backend) + #147 (Block O — embed). Until shipped, embed via `references/react.md` or build from `references/vanilla-html.md`.
- Not a replacement for proper auth — bootstrap tokens are your friend; raw API keys in URLs leak through Referer headers and proxy logs.
- Not multi-tenant chat — one user per iframe, scoped to the bearer key.

## Dimensions / responsiveness

The chat content sizes to its container. Recommended minimums:
- **Width**: 320px (mobile bubbles work) — 480px+ preferred
- **Height**: 480px — 640px is the sweet spot

## CSP for the parent page

If your site has a CSP, add:

```
frame-src https://chat.coronium.ai;
connect-src https://api.coronium.ai;
```

The iframe itself sets a strict CSP server-side. You don't need to relax `script-src` to embed.
