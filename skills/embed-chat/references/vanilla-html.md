# Vanilla HTML — single-file chat embed

For static sites and no-build environments. Pure ES modules, no React, no bundler.

A polished version lives at [`../assets/demo.html`](../assets/demo.html). Minimal version below — paste into any HTML page.

## Minimal example

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Coronium chat</title></head>
<body>
<div id="messages"></div>
<form id="form">
  <input id="draft" placeholder="Buy me a US 5G proxy…" autofocus />
  <button type="submit">Send</button>
</form>

<script type="module">
  const API = window.CORONIUM_API_BASE ?? "https://api.coronium.ai/v1";
  const KEY = window.CORONIUM_API_KEY;        // ← set this in a parent script
  if (!KEY) throw new Error("Set window.CORONIUM_API_KEY before loading the chat");

  const messages = [];
  const $msgs = document.getElementById("messages");
  const $draft = document.getElementById("draft");

  document.getElementById("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = $draft.value.trim();
    if (!content) return;
    $draft.value = "";
    messages.push({ role: "user", content });
    render();

    const assistant = { role: "assistant", content: "", toolCalls: [] };
    messages.push(assistant);
    render();

    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        messages: messages.slice(0, -1),       // don't include the empty assistant turn
      }),
    });

    if (!res.ok || !res.body) {
      assistant.content = `Error ${res.status}`;
      render();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const evt = JSON.parse(line.slice(5).trim());
          handleEvent(evt, assistant);
        }
        render();
      }
    }
  });

  function handleEvent(evt, assistant) {
    switch (evt.type) {
      case "text":
        assistant.content += evt.delta;
        break;
      case "tool_use":
        assistant.toolCalls.push({ id: evt.id, tool: evt.tool });
        break;
      case "tool_result": {
        const tc = assistant.toolCalls.find((t) => t.id === evt.id);
        if (tc) tc.ok = evt.ok;
        break;
      }
      case "error":
        assistant.content += `\n\n[error: ${evt.code}] ${evt.message}`;
        break;
    }
  }

  function render() {
    $msgs.innerHTML = messages.map(m => {
      const tools = (m.toolCalls ?? []).map(t =>
        `<div class="tool">${t.ok === undefined ? "⏳" : t.ok ? "✓" : "✗"} ${t.tool}</div>`
      ).join("");
      return `<div class="msg ${m.role}">${escape(m.content)}</div>${tools}`;
    }).join("");
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
</script>

<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  #messages { display: flex; flex-direction: column; gap: 8px; min-height: 400px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; }
  .msg { padding: 8px 12px; border-radius: 12px; max-width: 80%; white-space: pre-wrap; }
  .msg.user { background: #FF6B35; color: white; align-self: flex-end; }
  .msg.assistant { background: #f3f4f6; align-self: flex-start; }
  .tool { font-size: 12px; color: #6b7280; padding: 2px 8px; }
  form { display: flex; gap: 8px; margin-top: 12px; }
  #draft { flex: 1; padding: 8px 12px; border-radius: 6px; border: 1px solid #d1d5db; }
  button { padding: 8px 16px; background: #FF6B35; color: white; border: none; border-radius: 6px; cursor: pointer; }
</style>
</body>
</html>
```

## Where to set the API key

```html
<script>
  // Bootstrap from your backend, or hardcode for testing only.
  // window.CORONIUM_API_KEY = "sk_live_…";
</script>

<!-- Or via postMessage from a parent frame. See references/iframe.md. -->
```

In production, your backend serves a per-session bootstrap token (see `security.md` § "The bootstrap-token pattern"). Don't bake long-lived keys into static HTML.

## Override API base for local dev

```html
<script>window.CORONIUM_API_BASE = "http://127.0.0.1:5050/v1";</script>
```

## What this skips

- No markdown / code-block rendering — bring your own (`marked`, `markdown-it`)
- No conversation persistence — bring your own
- No auto-scroll — add `$msgs.scrollTo(0, $msgs.scrollHeight)` in `render()`
- No retry on network drop — bring your own
