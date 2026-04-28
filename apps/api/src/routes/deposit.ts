import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { upstream } from "../upstream/client.js";

const Body = z.object({
  chain: z.enum(["base", "tron", "ethereum"]).default("base"),
  amount_usd: z.number().positive().optional(),
});

export async function depositRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/deposit/address",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message });
      }
      if (!req.account!.upstream_user_id) {
        return reply.code(503).send({
          code: "UPSTREAM_PENDING",
          message: "Account is provisional — deposit address not yet available. Try again shortly.",
        });
      }
      const r = await upstream.getDepositAddress({
        upstream_user_id: req.account!.upstream_user_id,
        chain: parsed.data.chain,
        amount_usd: parsed.data.amount_usd,
      });
      return reply.send(r);
    },
  );
}
