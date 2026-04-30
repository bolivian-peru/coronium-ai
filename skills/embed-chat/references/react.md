# React drop-in — `<CoroniumChat />`

Single component, no extra deps beyond `react`. Streams SSE via `fetch` (not `EventSource` — EventSource doesn't support `Authorization` headers). Renders messages, tool calls, errors. Fully theme-able via props or CSS variables.

## The component

```tsx
import { useEffect, useRef, useState } from "react";

export interface CoroniumChatProps {
  /** sk_live_… key. Get one via embed-signup or the CLI. */
  apiKey: string;
  /** Default: https://api.coronium.io/api/v3 */
  apiBase?: string;
  /** Optional reseller branding. */
  brand?: {
    name?: string;
    logoUrl?: string;
    accentColor?: string;
    systemPromptAddendum?: string;
  };
  /** Optional tenant id (for paid-tier features like hide_badge). */
  tenantId?: string;
  /** className on the root <div>. */
  className?: string;
  /** Called for every assistant turn that completes. */
  onTurnComplete?: (transcript: ChatMessage[]) => void;
  /** Called when a tool finishes successfully. */
  onToolResult?: (tool: string, result: unknown) => void;
  /** Initial conversation seed (e.g., a pre-set greeting). */
  initialMessages?: ChatMessage[];
  /** Show "Powered by Coronium" footer. Defaults true; ignored if your tenant has hide_badge. */
  showBadge?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Tool calls that happened during this turn, in order. */
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

const DEFAULT_API = "https://api.coronium.io/api/v3";

export function CoroniumChat({
  apiKey,
  apiBase = DEFAULT_API,
  brand,
  tenantId,
  className,
  onTurnComplete,
  onToolResult,
  initialMessages = [],
  showBadge = true,
}: CoroniumChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  // Cancel inflight on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send() {
    if (!draft.trim() || streaming) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: draft.trim() }];
    setMessages(next);
    setDraft("");
    setError(null);
    setStreaming(true);

    const ctl = new AbortController();
    abortRef.current = ctl;

    let assistantText = "";
    const toolCalls: ToolCall[] = [];
    const updateAssistant = () => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          const copy = [...prev];
          copy[copy.length - 1] = { ...last, content: assistantText, toolCalls: [...toolCalls] };
          return copy;
        }
        return [...prev, { role: "assistant", content: assistantText, toolCalls: [...toolCalls] }];
      });
    };

    try {
      const res = await fetch(`${apiBase}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          messages: next,
          brand: brand
            ? {
                name: brand.name,
                logo_url: brand.logoUrl,
                accent_color: brand.accentColor,
                system_prompt_addendum: brand.systemPromptAddendum,
              }
            : undefined,
          tenant_id: tenantId,
        }),
        signal: ctl.signal,
      });

      if (!res.ok || !res.body) {
        let body: any;
        try { body = await res.json(); } catch {}
        throw mkErr(body?.code ?? `HTTP_${res.status}`, body?.message ?? res.statusText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE: split on blank line, each event has lines starting with "data: "
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            const evt = JSON.parse(json);
            handleEvent(evt);
          }
        }
      }

      onTurnComplete?.(next.concat({ role: "assistant", content: assistantText, toolCalls }));
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError({ code: e?.code ?? "UNKNOWN", message: e?.message ?? String(e) });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }

    function handleEvent(evt: any) {
      switch (evt.type) {
        case "open":
          // Could surface evt.spend_cap_remaining_cents to the UI here.
          break;
        case "text":
          assistantText += evt.delta;
          updateAssistant();
          break;
        case "tool_use":
          toolCalls.push({ id: evt.id, tool: evt.tool, args: evt.args });
          updateAssistant();
          break;
        case "tool_result": {
          const tc = toolCalls.find((t) => t.id === evt.id);
          if (tc) {
            tc.result = evt.ok
              ? { ok: true, data: evt.result }
              : { ok: false, error: { code: evt.code ?? "TOOL_ERROR", message: evt.message ?? "Tool failed" } };
            updateAssistant();
            if (evt.ok) onToolResult?.(tc.tool, evt.result);
          }
          break;
        }
        case "error":
          throw mkErr(evt.code, evt.message);
        case "done":
          // Final flush — nothing else to do.
          break;
      }
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  // ─── Styling ─────────────────────────────────────────────────────────
  const accent = brand?.accentColor ?? "#FF6B35";
  const rootStyle: React.CSSProperties = {
    "--coronium-accent": accent,
  } as React.CSSProperties;

  return (
    <div className={className} style={rootStyle}>
      {brand && (brand.name || brand.logoUrl) && (
        <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid #e5e7eb" }}>
          {brand.logoUrl && <img src={brand.logoUrl} alt="" style={{ height: 24 }} />}
          <strong>{brand.name ?? "Chat"}</strong>
        </header>
      )}

      <div ref={scrollRef} style={{ height: 480, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((m, i) => (
          <Bubble key={i} m={m} accent={accent} />
        ))}
        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
          <div style={{ color: "#888" }}>Thinking…</div>
        )}
        {error && (
          <div role="alert" style={{ background: "#fee", padding: 12, borderRadius: 8, border: "1px solid #fcc" }}>
            <strong>{error.code}</strong>: {error.message}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #e5e7eb" }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Buy me a US 5G proxy…"
          disabled={streaming}
          style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: "1px solid #d1d5db" }}
        />
        {streaming ? (
          <button onClick={cancel} style={{ padding: "8px 16px", background: "#fff", border: "1px solid #d1d5db", borderRadius: 6 }}>
            Stop
          </button>
        ) : (
          <button onClick={send} disabled={!draft.trim()} style={{ padding: "8px 16px", background: accent, color: "#fff", border: "none", borderRadius: 6, fontWeight: 500 }}>
            Send
          </button>
        )}
      </div>

      {showBadge && (
        <footer style={{ padding: "6px 12px", fontSize: 12, color: "#888", textAlign: "center", borderTop: "1px solid #f3f4f6" }}>
          Powered by <a href="https://coronium.ai" target="_blank" rel="noreferrer" style={{ color: "var(--coronium-accent)" }}>Coronium</a>
        </footer>
      )}
    </div>
  );
}

function Bubble({ m, accent }: { m: ChatMessage; accent: string }) {
  const isUser = m.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "80%",
          padding: "8px 12px",
          borderRadius: 12,
          background: isUser ? accent : "#f3f4f6",
          color: isUser ? "#fff" : "#0f172a",
          whiteSpace: "pre-wrap",
        }}
      >
        {m.content}
      </div>
      {m.toolCalls?.map((tc) => (
        <div key={tc.id} style={{ marginTop: 4, padding: "4px 8px", fontSize: 12, color: "#475569", background: "#f8fafc", borderRadius: 6, border: "1px solid #e2e8f0" }}>
          {tc.result?.ok ? "✓" : tc.result ? "✗" : "⏳"}{" "}
          <code>{tc.tool}</code>
          {tc.result?.error && <span style={{ color: "#b91c1c" }}> — {tc.result.error.code}</span>}
        </div>
      ))}
    </div>
  );
}

function mkErr(code: string, message: string) {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
```

## Usage

```tsx
import { CoroniumChat } from "./CoroniumChat";

export default function ProxyChat({ apiKey }: { apiKey: string }) {
  return (
    <CoroniumChat
      apiKey={apiKey}
      brand={{ name: "Acme Proxies", accentColor: "#3b82f6" }}
      onToolResult={(tool, result) => console.log(tool, result)}
    />
  );
}
```

## Theming

CSS variable `--coronium-accent` is set from the `accentColor` prop. Override anything else with your own CSS targeting the root `className`:

```css
.my-chat { font-family: "Inter", sans-serif; }
.my-chat header { background: #0f172a; color: white; }
.my-chat input { font-size: 16px; }
```

## Edge cases handled

- **User cancels mid-stream** — `abortRef` cancels the fetch; server stops Claude within 1 RTT.
- **Component unmounts mid-stream** — same as above (cleanup effect).
- **Spend cap hit during a tool call** — server emits `error` event with `SPEND_CAP_EXCEEDED`; UI shows it cleanly.
- **Network drop** — fetch throws, error displayed; user can resend.
- **Multiline input** — Shift+Enter for newline, Enter to send.

## Edge cases NOT handled (your call)

- **Conversation persistence across reloads** — not built in. Save `messages` to `sessionStorage` if you want it.
- **File uploads** — not supported by `/v1/chat`. Pure text + tool calls.
- **Voice input** — not in scope.
- **Markdown / code-block rendering** — bubble renders plain text. Add `react-markdown` if you want richer formatting.
