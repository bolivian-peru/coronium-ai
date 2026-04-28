// Coronium API — production server. Implements coronium-ai/openapi.yaml
// against the cor-api-v1 backend (existing modems / payments / proxysmart).
//
// Boot order:
//   1. Parse + validate env (config.ts) — fail loudly if anything's wrong
//   2. Open SQLite, run schema migrations
//   3. Build the Fastify app, register middleware + routes
//   4. Listen
//   5. Wire SIGINT / SIGTERM → graceful shutdown
//
// Health endpoints (no auth):
//   GET /health  — liveness; always 200 if the process can answer
//   GET /ready   — readiness; 200 only when DB is open + upstream reachable

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { db, closeDb } from "./db/index.js";
import { recordAudit } from "./db/audit.js";
import { authPlugin } from "./plugins/auth.js";
import { accountRoutes } from "./routes/account.js";
import { balanceRoutes } from "./routes/balance.js";
import { depositRoutes } from "./routes/deposit.js";
import { tariffsRoutes } from "./routes/tariffs.js";
import { proxyRoutes } from "./routes/proxies.js";
import { upstream, UpstreamError } from "./upstream/client.js";

export async function buildApp() {
  // Initialise DB before Fastify, so "ready" can confirm both.
  db();

  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) =>
      (req.headers["x-request-id"] as string) ||
      "req_" + Math.random().toString(36).slice(2, 14),
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(sensible);
  await app.register(helmet, {
    contentSecurityPolicy: false, // we serve JSON, not HTML
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: false,
  });
  await app.register(rateLimit, {
    global: false, // opt-in per route
    max: config.RATE_LIMIT_PER_IP_PER_MIN,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });
  await app.register(authPlugin);

  // ─── Health / Ready ─────────────────────────────────────────────────
  app.get("/health", async () => ({ ok: true, name: "coronium-api", version: "0.1.0" }));

  app.get("/ready", async (req, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      db().prepare("SELECT 1").get();
      checks.db = true;
    } catch {
      checks.db = false;
    }
    if (config.UPSTREAM_API_TOKEN) {
      try {
        // Cheap check — just validate creds via tariffs.
        await upstream.listTariffs({});
        checks.upstream = true;
      } catch (e) {
        checks.upstream = e instanceof UpstreamError && e.status >= 400 && e.status < 500;
      }
    } else {
      checks.upstream = false;
    }
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  // ─── v1 routes ──────────────────────────────────────────────────────
  app.register(
    async (api) => {
      // Per-key rate-limit applied via the auth-aware key generator.
      await api.register(rateLimit, {
        max: config.RATE_LIMIT_PER_KEY_PER_MIN,
        timeWindow: "1 minute",
        keyGenerator: (req) => req.apiKey?.id ?? req.ip,
      });
      await api.register(accountRoutes);
      await api.register(balanceRoutes);
      await api.register(depositRoutes);
      await api.register(tariffsRoutes);
      await api.register(proxyRoutes);
    },
    { prefix: "/v1" },
  );

  // ─── Audit hook ─────────────────────────────────────────────────────
  app.addHook("onResponse", async (req, reply) => {
    try {
      recordAudit({
        account_id: req.account?.id ?? null,
        api_key_id: req.apiKey?.id ?? null,
        method: req.method,
        path: req.routeOptions?.url ?? req.url,
        status: reply.statusCode,
        code: null,
        duration_ms: Math.round(reply.elapsedTime),
        request_id: String(req.id),
        ip: req.ip ?? null,
        user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
        created_at: Date.now(),
      });
    } catch (e) {
      req.log.warn({ err: e }, "audit insert failed");
    }
  });

  // ─── Error handler ──────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UpstreamError) {
      return reply.code(err.status >= 500 ? 502 : err.status).send({
        code: err.code,
        message: err.message,
      });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ code: "INTERNAL", message: "Internal error" });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ code: "NOT_FOUND", message: "No such route" });
  });

  return app;
}

// ─── Boot ──────────────────────────────────────────────────────────────

async function main() {
  const app = await buildApp();

  const closeGracefully = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      closeDb();
      process.exit(0);
    } catch (e) {
      logger.error({ err: e }, "shutdown error");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => closeGracefully("SIGINT"));
  process.on("SIGTERM", () => closeGracefully("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.fatal({ err }, "unhandledRejection");
    process.exit(1);
  });

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, host: config.HOST, env: config.NODE_ENV }, "coronium-api listening");
  } catch (e) {
    logger.fatal({ err: e }, "failed to listen");
    process.exit(1);
  }
}

// Don't auto-boot in tests.
if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
