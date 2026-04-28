import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { upstream } from "../upstream/client.js";

const Query = z.object({
  country: z.string().length(2).optional(),
  carrier: z.string().optional(),
  type: z.enum(["4g", "5g"]).optional(),
});

export async function tariffsRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/tariffs",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const parsed = Query.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message });
      }
      const list = await upstream.listTariffs(parsed.data);
      return reply.send(list);
    },
  );
}
