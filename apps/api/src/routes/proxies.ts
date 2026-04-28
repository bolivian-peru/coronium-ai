import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { upstream, UpstreamError } from "../upstream/client.js";
import { enforceSpendCaps } from "../plugins/spend-cap.js";
import { recordSpend } from "../db/spend.js";

const BuyBody = z.object({
  country: z.string().length(2),
  type: z.enum(["4g", "5g"]).default("5g"),
  carrier: z.string().optional(),
  qty: z.number().int().min(1).max(50).default(1),
  ttl: z.string().optional(),
  rotation: z.string().optional(),
  sticky: z.boolean().optional(),
  os: z.string().optional(),
});

export async function proxyRoutes(fastify: FastifyInstance) {
  // GET /v1/proxies — list active
  fastify.get(
    "/proxies",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      if (!req.account!.upstream_user_id) return reply.send([]);
      const list = await upstream.listProxies(req.account!.upstream_user_id);
      return reply.send(list);
    },
  );

  // POST /v1/proxies — buy (the hero verb)
  fastify.post(
    "/proxies",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const parsed = BuyBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message });
      }
      const input = parsed.data;

      // Estimate hourly burn for cap check.
      const hourlyCents = 2 * input.qty;
      const ok = await enforceSpendCaps(req, reply, { estimated_cents: hourlyCents });
      if (!ok) return;

      if (!req.account!.upstream_user_id) {
        return reply.code(503).send({
          code: "UPSTREAM_PENDING",
          message: "Account is provisional — try again shortly.",
        });
      }

      try {
        const proxies = await upstream.buyProxy({
          upstream_user_id: req.account!.upstream_user_id,
          country: input.country.toUpperCase(),
          type: input.type,
          carrier: input.carrier,
          qty: input.qty,
          ttl: input.ttl,
          rotation: input.rotation,
          sticky: input.sticky,
          os: input.os,
        });

        // Record the 60-second-minimum charge in our ledger. The actual
        // hourly accounting is done by upstream — we just track here for
        // the cap window.
        const minCents = Math.max(1, Math.round((2 / 3600) * 60 * input.qty));
        for (const p of proxies) {
          recordSpend({
            account_id: req.account!.id,
            api_key_id: req.apiKey!.id,
            amount_cents: minCents,
            reason: `proxy_buy:${p.id}`,
            upstream_ref: p.id,
            created_at: Date.now(),
          });
        }
        return reply.code(201).send(proxies);
      } catch (e) {
        if (e instanceof UpstreamError && e.code === "STOCK_OUT") {
          return reply.code(409).send(e.body);
        }
        throw e;
      }
    },
  );

  // DELETE /v1/proxies/:id
  fastify.delete<{ Params: { id: string } }>(
    "/proxies/:id",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      if (!req.account!.upstream_user_id) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Proxy not found" });
      }
      try {
        await upstream.releaseProxy(req.account!.upstream_user_id, req.params.id);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 404) {
          return reply.code(404).send(e.body);
        }
        throw e;
      }
    },
  );

  // POST /v1/proxies/:id/rotate
  fastify.post<{ Params: { id: string } }>(
    "/proxies/:id/rotate",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      if (!req.account!.upstream_user_id) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Proxy not found" });
      }
      try {
        const r = await upstream.rotateProxy(req.account!.upstream_user_id, req.params.id);
        return reply.send(r);
      } catch (e) {
        if (e instanceof UpstreamError && (e.code === "CARRIER_NO_OP" || e.status === 409)) {
          return reply.code(409).send(e.body);
        }
        if (e instanceof UpstreamError && e.status === 404) {
          return reply.code(404).send(e.body);
        }
        throw e;
      }
    },
  );

  // POST /v1/proxies/:id/replace
  fastify.post<{ Params: { id: string } }>(
    "/proxies/:id/replace",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      if (!req.account!.upstream_user_id) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Proxy not found" });
      }
      try {
        const fresh = await upstream.replaceProxy(req.account!.upstream_user_id, req.params.id);
        return reply.send(fresh);
      } catch (e) {
        if (e instanceof UpstreamError && (e.status === 409 || e.status === 404)) {
          return reply.code(e.status).send(e.body);
        }
        throw e;
      }
    },
  );
}
