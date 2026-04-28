import type { FastifyInstance } from "fastify";
import { spendTodayCents } from "../db/spend.js";
import { upstream, UpstreamError } from "../upstream/client.js";
import { logger } from "../logger.js";

export async function balanceRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/balance",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const account = req.account!;

      let balanceUsd = 0;
      let activeProxies = 0;

      if (account.upstream_user_id) {
        try {
          const r = await upstream.getBalance(account.upstream_user_id);
          balanceUsd = r.balance_usd;
        } catch (e) {
          if (!(e instanceof UpstreamError && e.code === "UPSTREAM_NOT_CONFIGURED")) {
            logger.error({ err: e }, "balance: upstream getBalance failed");
          }
        }
        try {
          const list = await upstream.listProxies(account.upstream_user_id);
          activeProxies = list.length;
        } catch (e) {
          if (!(e instanceof UpstreamError && e.code === "UPSTREAM_NOT_CONFIGURED")) {
            logger.error({ err: e }, "balance: upstream listProxies failed");
          }
        }
      }

      const spentTodayCents = spendTodayCents(account.id);
      const burnPerHourCents = activeProxies * 2; // $0.02/proxy/hour
      const hoursAtBurn = burnPerHourCents > 0 ? (balanceUsd * 100) / burnPerHourCents : Infinity;

      return reply.send({
        usdc: balanceUsd.toFixed(2),
        hours_at_current_burn: Number.isFinite(hoursAtBurn) ? hoursAtBurn.toFixed(1) : "infinite",
        active_proxies: activeProxies,
        spend_today_usd: spentTodayCents / 100,
        daily_cap_usd: account.daily_cap_cents / 100,
        session_cap_usd: account.session_cap_cents / 100,
      });
    },
  );
}
