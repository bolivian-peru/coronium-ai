import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { genId } from "../lib/ids.js";
import { generateKey } from "../lib/keys.js";
import { insertAccount } from "../db/accounts.js";
import { insertApiKey } from "../db/api-keys.js";
import { upstream, UpstreamError } from "../upstream/client.js";
import { logger } from "../logger.js";

const CreateBody = z.object({
  email: z.string().email().optional(),
});

export async function accountRoutes(fastify: FastifyInstance) {
  // POST /v1/account/create — unauthenticated. Issues a key + deposit address.
  fastify.post("/account/create", async (req, reply) => {
    const body = CreateBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: body.error.issues[0]?.message });
    }

    const now = Date.now();
    const accountId = genId("acc");

    // Mint upstream user (so this account maps to a real cor-api-v1 record
    // for proxy/payment ops). Falls back gracefully if upstream is offline:
    // we still issue the local account, mark upstream_user_id NULL, and
    // background-reconcile later.
    let upstreamUser: Awaited<ReturnType<typeof upstream.createUser>> | undefined;
    try {
      upstreamUser = await upstream.createUser({ email: body.data.email });
    } catch (e) {
      if (e instanceof UpstreamError && e.code === "UPSTREAM_NOT_CONFIGURED") {
        logger.warn("UPSTREAM_API_TOKEN not set — issuing account_id without upstream user");
      } else {
        logger.error({ err: e }, "upstream createUser failed; continuing");
      }
    }

    const depositAddr = upstreamUser?.deposit_address_usdc_base ?? "0xpending";

    insertAccount({
      id: accountId,
      email: body.data.email ?? null,
      created_at: now,
      deposit_addr: depositAddr,
      daily_cap_cents: Math.round(config.DEFAULT_DAILY_CAP_USD * 100),
      session_cap_cents: Math.round(config.DEFAULT_SESSION_CAP_USD * 100),
      upstream_user_id: upstreamUser?.id ?? null,
      deleted_at: null,
    });

    const { full, prefix, hash } = generateKey();
    insertApiKey({
      id: genId("key"),
      account_id: accountId,
      prefix,
      key_hash: hash,
      label: "default",
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    });

    return reply.code(201).send({
      account_id: accountId,
      api_key: full,
      deposit_address_usdc_base: depositAddr,
      balance_usd: config.TRIAL_CREDIT_USD,
      daily_spend_cap_usd: config.DEFAULT_DAILY_CAP_USD,
    });
  });
}
