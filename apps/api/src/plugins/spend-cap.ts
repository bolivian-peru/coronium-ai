// Spend-cap enforcement. Reads X-Cost-Cap-Cents header for per-call
// override; falls back to the account's session cap. Also checks the
// account's daily cap and the global tenant cap.

import type { FastifyReply, FastifyRequest } from "fastify";
import { spendTodayCents, tenantSpendTodayCents } from "../db/spend.js";
import { config } from "../config.js";

export interface SpendCheck {
  estimated_cents: number;
}

export async function enforceSpendCaps(
  req: FastifyRequest,
  reply: FastifyReply,
  check: SpendCheck,
): Promise<boolean> {
  if (!req.account) {
    reply.code(401).send({ code: "UNAUTH", message: "Auth required" });
    return false;
  }

  // Per-call cap (header).
  const headerCap = parseHeaderCap(req.headers["x-cost-cap-cents"]);
  if (headerCap !== undefined && check.estimated_cents > headerCap) {
    reply.code(402).send({
      code: "SPEND_CAP_EXCEEDED",
      message: `Estimated ${check.estimated_cents}¢ exceeds X-Cost-Cap-Cents header limit ${headerCap}¢`,
    });
    return false;
  }

  // Per-session cap (account default).
  if (check.estimated_cents > req.account.session_cap_cents) {
    reply.code(402).send({
      code: "SPEND_CAP_EXCEEDED",
      message: `Estimated ${check.estimated_cents}¢ exceeds session cap ${req.account.session_cap_cents}¢`,
    });
    return false;
  }

  // Per-account daily cap.
  const todayAccount = spendTodayCents(req.account.id);
  if (todayAccount + check.estimated_cents > req.account.daily_cap_cents) {
    reply.code(402).send({
      code: "SPEND_CAP_EXCEEDED",
      message: `Daily cap ${req.account.daily_cap_cents}¢ would be exceeded (${todayAccount}¢ already spent today)`,
    });
    return false;
  }

  // Tenant-wide ceiling.
  const tenantCapCents = config.TENANT_DAILY_CAP_USD * 100;
  const todayTenant = tenantSpendTodayCents();
  if (todayTenant + check.estimated_cents > tenantCapCents) {
    reply.code(503).send({
      code: "TENANT_CAP_EXCEEDED",
      message: `Tenant-wide daily cap reached. Try again tomorrow.`,
    });
    return false;
  }

  return true;
}

function parseHeaderCap(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
