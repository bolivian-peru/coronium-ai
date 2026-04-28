import { db } from "./index.js";

export interface SpendEntry {
  account_id: string;
  api_key_id: string | null;
  amount_cents: number;
  reason: string;
  upstream_ref: string | null;
  created_at: number;
}

export function recordSpend(e: SpendEntry): number {
  const r = db()
    .prepare(
      `INSERT INTO spend_ledger (account_id, api_key_id, amount_cents, reason, upstream_ref, created_at)
       VALUES (@account_id, @api_key_id, @amount_cents, @reason, @upstream_ref, @created_at)`,
    )
    .run(e);
  return Number(r.lastInsertRowid);
}

export function spendInWindowCents(accountId: string, sinceMs: number): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM spend_ledger
       WHERE account_id = ? AND created_at >= ?`,
    )
    .get(accountId, sinceMs) as { total: number };
  return row.total;
}

export function spendTodayCents(accountId: string): number {
  const startOfDay = startOfUtcDay(Date.now());
  return spendInWindowCents(accountId, startOfDay);
}

export function tenantSpendTodayCents(): number {
  const startOfDay = startOfUtcDay(Date.now());
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM spend_ledger
       WHERE created_at >= ?`,
    )
    .get(startOfDay) as { total: number };
  return row.total;
}

function startOfUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
