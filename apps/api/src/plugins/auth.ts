// Bearer-token auth plugin. Decorates the request with `account` + `apiKey`
// when a valid `sk_live_` token is presented. Routes opt in by adding a
// `preHandler: [fastify.authenticate]` hook (or by calling `requireAuth()`).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { findKeyByValue, touchLastUsed, type ApiKeyRow } from "../db/api-keys.js";
import { getAccount, type AccountRow } from "../db/accounts.js";

declare module "fastify" {
  interface FastifyRequest {
    account?: AccountRow;
    apiKey?: ApiKeyRow;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ code: "MISSING_KEY", message: "Authorization: Bearer sk_live_… required" });
    }
    const key = header.slice(7).trim();
    const apiKey = findKeyByValue(key);
    if (!apiKey) {
      return reply.code(401).send({ code: "INVALID_KEY", message: "Unknown or revoked API key" });
    }
    const account = getAccount(apiKey.account_id);
    if (!account) {
      return reply.code(401).send({ code: "INVALID_KEY", message: "Account not found" });
    }
    req.apiKey = apiKey;
    req.account = account;
    touchLastUsed(apiKey.id, Date.now());
  });
});
