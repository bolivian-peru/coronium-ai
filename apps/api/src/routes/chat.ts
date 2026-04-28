// POST /v1/chat — streaming chat endpoint.
//
// This is the SSE wire format the embed-chat skill targets. The actual
// agent runtime (Claude SDK + tool definitions) lives in coronium-backend
// (and later in coronium-bot). This endpoint is the thin authentication +
// streaming proxy.
//
// Two modes:
//   1. UPSTREAM mode (default): forwards to UPSTREAM_API_URL/chat with
//      service-token auth, streams SSE events back.
//   2. STUB mode (when CHAT_STUB=1): returns a canned response useful for
//      smoke-testing the wire format without a real agent runtime.
//
// Auth: Bearer sk_live_… (the user's API key). Same as every other v1 verb.
//
// Spend caps: applied before the request leaves this server. Cumulative tool
// spend over the session is capped at session_cap_cents.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { request as undiciRequest } from "undici";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { spendTodayCents } from "../db/spend.js";

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().max(64_000),
      }),
    )
    .min(1)
    .max(200),
  brand: z
    .object({
      name: z.string().max(80).optional(),
      logo_url: z.string().url().optional(),
      accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      system_prompt_addendum: z.string().max(2000).optional(),
    })
    .optional(),
  tenant_id: z.string().max(64).optional(),
});

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/chat",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const parsed = ChatBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message });
      }

      const account = req.account!;
      const sessionCapCents = account.session_cap_cents;
      const dailyCapCents = account.daily_cap_cents;
      const spentTodayCents = spendTodayCents(account.id);
      const remainingCents = Math.min(sessionCapCents, dailyCapCents - spentTodayCents);

      if (remainingCents <= 0) {
        return reply.code(402).send({
          code: "DAILY_CAP_EXCEEDED",
          message: `Daily cap of ${dailyCapCents}¢ reached`,
        });
      }

      // SSE headers.
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sse = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const conversationId = "cnv_" + Math.random().toString(36).slice(2, 18);
      sse("open", {
        type: "open",
        conversation_id: conversationId,
        spend_cap_remaining_cents: remainingCents,
      });

      try {
        if (process.env.CHAT_STUB === "1" || !config.UPSTREAM_API_TOKEN) {
          await streamStub(parsed.data.messages, sse, account.id);
        } else {
          await streamUpstream(parsed.data, sse, account.id, account.upstream_user_id);
        }
        sse("done", {
          type: "done",
          stop_reason: "end_turn",
          spend_cap_remaining_cents: remainingCents,
        });
      } catch (e: any) {
        logger.error({ err: e?.message, account: account.id }, "chat stream error");
        sse("error", {
          type: "error",
          code: e?.code ?? "INTERNAL",
          message: e?.message ?? "Internal error",
        });
      } finally {
        reply.raw.end();
      }
    },
  );
}

// ─── Stub mode — useful for testing the wire format end-to-end ────────────

async function streamStub(
  messages: Array<{ role: string; content: string }>,
  sse: (event: string, data: unknown) => void,
  _accountId: string,
) {
  let lastUser = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { lastUser = messages[i]!.content; break; }
  }
  const reply = (() => {
    const lower = lastUser.toLowerCase();
    if (/balance|usdc/.test(lower)) {
      return [
        ["text", "Let me check that for you. "],
        ["tool_use", { id: "tu_01", tool: "balance_get", args: {} }],
        ["tool_result", { id: "tu_01", ok: true, result: { usdc: "0.50", active_proxies: 0 } }],
        ["text", "You have $0.50 USDC and no active proxies right now."],
      ];
    }
    if (/buy|proxy|us|5g/.test(lower)) {
      return [
        ["text", "Sure, "],
        ["text", "buying you a US 5G proxy. "],
        ["tool_use", { id: "tu_01", tool: "proxy_get", args: { country: "US", type: "5g", qty: 1 } }],
        ["tool_result", { id: "tu_01", ok: true, result: { id: "px_DEMO_STUB", host: "gw-us.coronium.ai", port_http: 8443 } }],
        ["text", "Done — proxy id px_DEMO_STUB ready at gw-us.coronium.ai:8443."],
      ];
    }
    return [
      ["text", "I can buy proxies, rotate IPs, check your balance, or list tariffs. "],
      ["text", "What would you like to do?"],
    ] as const;
  })();

  for (const [type, payload] of reply as Array<[string, any]>) {
    if (type === "text") {
      // Stream text as small deltas to feel real.
      const full = String(payload);
      for (let i = 0; i < full.length; i += 8) {
        sse("text", { type: "text", delta: full.slice(i, i + 8) });
        await new Promise((r) => setTimeout(r, 25));
      }
    } else {
      sse(type, { type, ...payload });
      await new Promise((r) => setTimeout(r, 80));
    }
  }
}

// ─── Upstream mode — forwards to coronium-backend's chat endpoint ─────────

async function streamUpstream(
  body: z.infer<typeof ChatBody>,
  sse: (event: string, data: unknown) => void,
  _accountId: string,
  upstreamUserId: string | null,
) {
  if (!upstreamUserId) {
    throw mkErr("UPSTREAM_PENDING", "Account is provisional — chat unavailable until upstream user is provisioned.");
  }
  const url = config.UPSTREAM_API_URL.replace(/\/$/, "") + "/chat";
  const res = await undiciRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${config.UPSTREAM_API_TOKEN}`,
      "X-Coronium-Upstream-User-Id": upstreamUserId,
    },
    body: JSON.stringify(body),
    bodyTimeout: 60_000,
    headersTimeout: 10_000,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    throw mkErr(parsed?.code ?? `UPSTREAM_${res.statusCode}`, parsed?.message ?? `upstream returned ${res.statusCode}`);
  }

  // Pipe the upstream SSE through verbatim.
  const reader = (res.body as any)[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.next();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const evt = JSON.parse(json);
          sse(evt.type ?? "text", evt);
        } catch {
          // Forward as text if it doesn't parse.
          sse("text", { type: "text", delta: json });
        }
      }
    }
  }
}

function mkErr(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
