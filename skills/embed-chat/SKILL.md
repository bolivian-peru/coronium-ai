---
name: embed-chat
description: Embed a Coronium AI chat agent into any web app — branded for the integrator, authed via wallet-bound API keys, streams over SSE. The chat agent has tool access to the full Coronium 7-verb API (proxy_get / rotate / replace / release / balance / tariffs / deposit) and runs spend-capped. Use this skill whenever the user wants to add a "Talk to your proxies" / "AI assistant" / "chat support" / "concierge" / "buy a proxy by chatting" experience to their site, dashboard, reseller portal, or marketplace — even if they don't explicitly say "Coronium chat."
---

# Embed Coronium AI chat in any web frontend

Coronium runs an agent runtime that turns natural-language requests into 7-verb API calls. Today it lives at `dashboard.coronium.io/cli` for our own customers. This skill packages it as an **embeddable component** for resellers, partners, and self-hosters — drop a React component or an iframe into your site, and your users chat with a Coronium-backed agent that can buy, rotate, and release proxies for them.

## When this triggers

Use this skill when the user is:

- Building a reseller dashboard and wants to add an AI chat to it
- Asking how to "let users buy proxies by talking" / "embed the Coronium AI"
- Wiring a partner portal where the partner's customers manage proxies through chat
- Adding an "AI concierge" / "support chat" to a Coronium-related product
- Replacing a dashboard form-driven flow with a conversational one
- Building a whitelabel marketplace that sells Coronium proxies through a chat UX

## What you get

A chat surface that:
- Takes natural language ("buy me a US 5G proxy", "rotate the German one", "what's my balance?")
- Calls the right Coronium API tools, with arguments inferred from context
- Streams Claude's responses to the user via SSE
- Renders tool-call activity inline ("✓ bought px_01HX… for $0.02/hr")
- Enforces session spend caps server-side (chat can't spend more than the user's `session_cap_cents`)
- Logs every conversation + tool call to the audit trail
- Carries reseller branding (logo, name, accent color, optional system-prompt augmentation)

## Architecture

```
┌────────────────────────────────────────┐         ┌──────────────────────────────────┐
│  Reseller frontend (your site)         │         │  api.coronium.io/api/v3              │
│                                        │         │                                  │
│  <CoroniumChat                         │         │                                  │
│     apiKey="sk_live_..."               │         │                                  │
│     theme={{ accent: '#…' }}           │         │                                  │
│     brandName="Acme Proxies"           │         │                                  │
│   />                                   │         │                                  │
│                                        │         │                                  │
│  user types message ──────────────────►│  POST /v1/chat                            │
│                                        │  Authorization: Bearer sk_live_…           │
│                                        │  body: { messages, tenant_id?, brand? }    │
│                                        │                                            │
│                                        │  ◄────  text/event-stream of:              │
│                                        │           data: {"type":"text",…}          │
│                                        │           data: {"type":"tool_use",…}      │
│                                        │           data: {"type":"tool_result",…}   │
│                                        │           data: {"type":"done",…}          │
│  rendered as message bubbles +         │                                            │
│  tool-call indicators                  │         (Claude SDK + 7 verb tools         │
└────────────────────────────────────────┘          internally call the same          │
                                                    REST verbs the SDK/CLI/MCP do)    │
                                                  └──────────────────────────────────┘
```

Auth: the integrator's user already has a Coronium API key (typically minted via `embed-signup` or directly via CLI). The chat endpoint accepts `Authorization: Bearer sk_live_…` like all other v1 endpoints. **Keep the key in your application's session, not in localStorage** — see `references/security.md`.

## Three integration patterns

| Pattern | When | See |
|---|---|---|
| **React component** | Most modern frontends — Next.js, Vite, Remix | `references/react.md` |
| **Iframe** | Static sites, no-build environments, fast PoC | `references/iframe.md` |
| **Vanilla HTML + ESM** | Drop into any page, no framework | `references/vanilla-html.md` |

A working standalone HTML lives at [`assets/demo.html`](assets/demo.html) — open it, paste a sk_live_ key, chat works.

## Reseller branding

Three knobs:

- **Visual** — pass CSS custom properties (or a `theme` prop in React) to override accent, background, font, border-radius. The component renders semantic HTML; restyle with your CSS.
- **Identity** — `brandName` and `brandLogoUrl` props show in the chat header. Server side, the system prompt gets a one-line addendum ("You are an agent for Acme Proxies, reselling Coronium mobile proxies.") so Claude addresses the user appropriately.
- **Hide-Coronium-badge tier** — by default the chat shows a small "Powered by Coronium" badge in the footer. Paid resellers can hide it via a `hide_badge` flag bound to their tenant on the server. Free tier always shows the badge — that's how Coronium markets through reseller channels.

## What the agent CAN do (the 7 verbs + balance + deposit)

The chat agent has access to these tools via Claude's tool use:

- `balance_get` — show user's USDC balance + spend caps
- `deposit_address` — give the user a USDC deposit address (Base by default)
- `tariff_list` — list available proxy plans, optionally filtered
- `proxy_get` — buy a proxy (the most common action)
- `proxy_list` — show their active proxies
- `proxy_rotate` — rotate the IP on a specific proxy
- `proxy_replace` — swap a stuck proxy for a fresh modem
- `proxy_release` — release a proxy

It does NOT have access to:
- `account/redeem` (signup is a separate flow — `embed-signup`)
- `key/rotate` (key recovery is an explicit user action, not a chat flow)
- Anything outside the wallet's own account

## What the agent CANNOT spend

Server-side spend cap (`session_cap_cents` on the account) is enforced before EVERY tool call that could spend money (`proxy_get` primarily). Default: **$5 per chat session** (cumulative; a single `proxy_get` for `qty: 50` would exceed and be rejected). Override per-tenant if needed.

## Step-by-step guidance for an agent following this skill

1. **Identify the integrator's stack and pick the pattern** — React (`references/react.md`), iframe (`references/iframe.md`), or vanilla (`references/vanilla-html.md`).
2. **Confirm where the API key comes from** — usually from `embed-signup` (in the same session) or from a server-side mint. **Never have the user paste a key into the chat field**; that's a phishing pattern.
3. **Set up the API base URL** — default `https://api.coronium.io/api/v3`, override with prop or env for local dev.
4. **Wire the streaming response** — Server-Sent Events. EventSource works in browsers; for fetch-based streaming see `references/wire-format.md`.
5. **Render tool calls as activity badges** — show what the agent did, not just what it said. Reduces "did anything happen?" confusion.
6. **Apply branding** — read `references/react.md` § "Theming" for the prop API. CSS variables for vanilla integrators.
7. **Handle errors gracefully** — `SPEND_CAP_EXCEEDED` should show as "Hit your session limit — top up to keep going" not as a stack trace. See `references/troubleshooting.md`.
8. **Read `references/security.md` BEFORE you put any key in browser memory.** Same rules as the embed-signup skill apply with extra emphasis: chat sessions persist longer than signup flows.

## What this skill is NOT

- Not a replacement for the CLI or MCP — those are programmatic. Chat is conversational. Different audiences.
- Not a multi-tenant chatops platform — one chat per Coronium account. If you need shared team chat with admin / member roles, that's a different product.
- Not a way for the agent to access other tenants' data — every chat is scoped to the bearer key's account.
- Not a tool that bypasses spend caps — a customer who wants to spend more sets a higher cap on their account, not by chatting around the cap.

## Reference layout

```
skills/embed-chat/
├── SKILL.md (this file)
├── references/
│   ├── wire-format.md       ← /v1/chat request/response, SSE event types, error codes
│   ├── react.md             ← <CoroniumChat /> drop-in component, ~350 LOC
│   ├── iframe.md            ← chat.coronium.ai?token=…&theme=… + postMessage protocol
│   ├── vanilla-html.md      ← single-file ES-module variant
│   ├── security.md          ← key handling for chat sessions + CSP + iframe sandbox
│   └── troubleshooting.md   ← common failures by error code
└── assets/
    └── demo.html            ← polished standalone chat — paste sk_live_, talk to your proxies
```

## Status as of 2026-04-29

- Skill files: ✅ in this repo
- `POST /v1/chat` endpoint on `apps/api/`: ⚠️ in development (task #146 — Block N)
- `chat.coronium.ai` iframe host: ❌ not deployed yet
- Tenant + branding model on the server: ❌ planned (task #148 — Block P)

When the chat endpoint and tenant model ship, this skill will be marked stable. Until then, the standalone demo + React reference work against a local mock you stand up yourself.

## Versioning

This skill targets `coronium-api` schema version 2 + `chat` endpoint v1. If the chat protocol changes, this skill's `references/wire-format.md` needs an update. Check the `Coronium-Chat-Version` SSE event for runtime drift.
