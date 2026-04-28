# Troubleshooting — chat embed

Branch on `code`, never on `message`. Codes are stable; messages may change.

## During the first request

| Code | Symptom | Most likely cause | Fix |
|---|---|---|---|
| `MISSING_KEY` | 401 immediately | No `Authorization` header | Pass `apiKey` prop / send `Authorization: Bearer sk_live_…` |
| `INVALID_KEY` | 401 with key present | Key revoked or never existed | User needs to re-init or rotate (key:rotate from CLI) |
| `INVALID_REQUEST` | 400 | Body schema failed | Check `messages` is an array of `{role, content}`, content is a string |
| `RATE_LIMITED` | 429 | Too many requests in a minute | Back off. Default 30/min per key. |
| Network error / `Failed to fetch` | No SSE arrives | CORS not allowlisted for your origin | Have your tenant_id added to CORS allowlist (server-side config) |
| `text/event-stream` not honored | `res.body` is null | Some proxies (Cloudflare on free tier with buffer-on) buffer SSE | Set `Cache-Control: no-cache` and `X-Accel-Buffering: no` headers; or disable proxy buffering |

## During an active stream

| Event | What happened | What to do |
|---|---|---|
| `error` event with `SPEND_CAP_EXCEEDED` | Session cap hit | Show "Top up to keep going" with a link to deposit |
| `error` event with `DAILY_CAP_EXCEEDED` | Daily ceiling reached | Tell user to wait until UTC midnight or raise their cap |
| `error` event with `MODEL_TIMEOUT` | Claude SDK call timed out | Retry the same request after a brief delay |
| `error` event with `INTERNAL` | Unexpected server error | Capture the conversation_id from the `open` event for support |
| Stream just stops without `done` event | Network drop | Close the EventSource; offer "Try again" |

## Tool calls failing

The `tool_result` event with `ok: false` carries an inner `code`:

| Inner code (in tool_result) | What happened | Show user |
|---|---|---|
| `STOCK_OUT` | No proxies in requested country/carrier | "Currently out for that combination. Try a different country?" Use the suggested alternatives. |
| `INSUFFICIENT_BALANCE` | User's balance can't afford the operation | "Top up to continue. Your balance: $X" |
| `CARRIER_NO_OP` | Rotation failed — carrier didn't release IP | "Rotation didn't take. Try `replace` instead." |
| `NOT_FOUND` | Proxy id doesn't exist or isn't theirs | "I can't find that proxy. List with 'show my proxies'." |

The chat agent (Claude) usually translates these into natural language already. Your UI just needs to render the activity badge ("✗ proxy_get") and let the agent's text response carry the meaning.

## "The chat seems frozen"

Diagnose in this order:

1. **Open browser devtools Network tab** — does the POST /v1/chat request show `Status: 200` and `Type: eventstream`? If not, the request didn't even start streaming.
2. **Look at the Response tab** — are SSE events arriving? If the response is empty, the server isn't streaming back.
3. **Check the EventSource in console**: `document.querySelector('iframe').contentWindow.fetch('/v1/chat', …)` — manually verify connectivity.
4. **Try with curl**: see `wire-format.md` § "curl recipe". If curl works but the embed doesn't, it's a client-side parser bug.

## "MetaMask popped up but didn't sign"

Chat doesn't use wallet signing — that's the signup/rotate flow (`embed-signup` skill). If MetaMask is appearing during chat, you've crossed wires somewhere. Audit your component imports.

## "I'm getting CORS errors"

`Access-Control-Allow-Origin` rejection from the API:

1. Confirm your origin is in the API's allowlist. Default allowlist: `coronium.ai`, `dashboard.coronium.io`, `chat.coronium.ai`.
2. If you're a reseller with a different domain, your tenant_id needs to register your origin (task #148 — tenant model).
3. For local dev, the API allows `localhost` and `127.0.0.1` on any port.
4. Don't try to proxy the request through your own backend just to fix CORS — you'll lose SSE streaming and add latency. Get the allowlist updated instead.

## "The agent did the wrong thing"

The chat agent is Claude with tool access. If it bought a 4G proxy when the user asked for 5G, that's a reasoning error. Mitigations:

1. **Read the audit log** (in apps/api `audit_log` table) for the `request_id` in the conversation
2. **Capture conversation transcripts** via `onTurnComplete` callback for analysis
3. **Surface tool calls visibly** — `tool_use` events let users see what the agent was about to do; some integrations show a "Confirm?" button before high-cost tools (currently optional, may become standard)
4. **Tighten the system prompt** via `brand.systemPromptAddendum` — e.g., "Always confirm with the user before buying more than one proxy"

## When in doubt — local mock

The chat endpoint depends on backend infra. To debug client code in isolation:

1. Spin up a local mock that returns canned SSE events (you can write one in 50 lines of Express)
2. Point `apiBase` at it
3. Verify your component renders text deltas, tool calls, and errors correctly

A future version of this skill will include a stub `apps/mock-chat-api/` for exactly this purpose.
