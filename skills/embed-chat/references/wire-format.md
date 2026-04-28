# Chat wire format — `POST /v1/chat`

One streaming endpoint. Auth via Bearer API key. SSE response.

## Request

```
POST /v1/chat
Authorization: Bearer sk_live_<EXAMPLE>
Content-Type: application/json
Accept: text/event-stream

{
  "messages": [
    { "role": "user", "content": "Buy me a US 5G proxy" }
  ],
  "brand": {
    "name": "Acme Proxies",
    "logo_url": "https://acme.example.com/logo.png",
    "accent_color": "#FF6B35",
    "system_prompt_addendum": "You are speaking on behalf of Acme Proxies."
  },
  "tenant_id": "ten_acme01"          // optional; required for paid-tier hide_badge etc.
}
```

- `messages` — full conversation history, OpenAI-style. Server prepends a system prompt; client sends only user/assistant turns.
- `brand` — optional. Overrides default Coronium branding for this conversation. The server merges with tenant defaults if `tenant_id` is set.
- `tenant_id` — for resellers; opaque to the client. Bound to an HMAC secret server-side via the affiliate program.

## Response — Server-Sent Events stream

`Content-Type: text/event-stream`. One JSON object per `data:` event.

### Event types

```
event: open
data: {"type":"open","conversation_id":"cnv_…","spend_cap_remaining_cents":480}

event: text
data: {"type":"text","delta":"Sure, "}

event: text
data: {"type":"text","delta":"I'll buy you a "}

event: tool_use
data: {"type":"tool_use","tool":"proxy_get","args":{"country":"US","type":"5g","qty":1},"id":"tu_01"}

event: tool_result
data: {"type":"tool_result","id":"tu_01","ok":true,"result":{"id":"px_01HX…","host":"gw-us.coronium.ai","port_http":8443,"username":"...","password":"...","ip":"…"}}

event: text
data: {"type":"text","delta":"Done — your proxy is ready. "}

event: text
data: {"type":"text","delta":"Connection details copied below."}

event: done
data: {"type":"done","stop_reason":"end_turn","spend_cap_remaining_cents":478,"total_tokens":523}
```

For each `tool_use` you get exactly one corresponding `tool_result` with the same `id`. If the tool fails (stock-out, spend-cap, carrier no-op), `ok` is false and `result` carries the error code.

### Error event (terminal)

```
event: error
data: {"type":"error","code":"SPEND_CAP_EXCEEDED","message":"Session cap of $5 reached. Top up at coronium.ai/dashboard to continue."}
```

Stable codes (branch on these, never on `message`):

| Code | When |
|---|---|
| `INVALID_KEY` | Bearer token unknown or revoked |
| `MISSING_KEY` | No `Authorization` header |
| `INVALID_REQUEST` | Malformed body |
| `RATE_LIMITED` | Too many requests for this key (default 30/min) |
| `SPEND_CAP_EXCEEDED` | Cumulative session spend would exceed `session_cap_cents` |
| `DAILY_CAP_EXCEEDED` | Daily cap hit; user must wait until UTC midnight |
| `TENANT_INVALID` | `tenant_id` doesn't exist or signature missing |
| `MODEL_TIMEOUT` | Claude SDK call timed out (typically network) |
| `INTERNAL` | Unexpected server error |

## Cancellation

Close the EventSource on the client. The server detects the dropped connection and stops Claude's stream within 1 RTT. Tool calls already in-flight complete (don't double-spend).

## Conversation history persistence

The server does **not** persist conversation history. The client is responsible for sending the full `messages` array on every request. This is identical to how OpenAI / Anthropic chat completion APIs work. Persisting history is the integrator's responsibility (typically `sessionStorage`).

## CORS

- Default allowlist: `coronium.ai`, `dashboard.coronium.io`, `chat.coronium.ai`
- Reseller domains: added via the tenant model. Reseller registers their origin in their tenant config; server returns `Access-Control-Allow-Origin: <their-origin>` for matched requests.
- Wildcard origins are **not** supported — every reseller's origin must be allowlisted explicitly.

## Rate limits

- Per API key: 30 requests/minute (one chat conversation typically uses 1-3 requests if streamed)
- Per IP: 60 requests/minute (set on API gateway)
- Per tenant: aggregate per minute (configurable per tenant)

## Tools the agent has

These map 1:1 to the OpenAPI verbs. The chat agent receives results as JSON and surfaces them to the user in natural language. The integrator UI should render `tool_use` events as activity badges so the user can see what's happening.

| Tool | Maps to |
|---|---|
| `balance_get` | `GET /v1/balance` |
| `deposit_address` | `POST /v1/deposit/address` |
| `tariff_list` | `GET /v1/tariffs` |
| `proxy_list` | `GET /v1/proxies` |
| `proxy_get` | `POST /v1/proxies` (the spendy one — capped) |
| `proxy_rotate` | `POST /v1/proxies/{id}/rotate` |
| `proxy_replace` | `POST /v1/proxies/{id}/replace` |
| `proxy_release` | `DELETE /v1/proxies/{id}` |

## curl recipe (for debugging)

```bash
curl -N -sS -X POST https://api.coronium.ai/v1/chat \
  -H "Authorization: Bearer $CORONIUM_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":"What is my balance?"}]}'
```

`-N` keeps curl from buffering. You'll see SSE events stream as they arrive.
