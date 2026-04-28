import { db } from "./index.js";

export interface VoucherRow {
  id: string;
  batch: string;
  campaign: string | null;
  affiliate_id: string | null;
  initial_credit_cents: number;
  daily_cap_cents: number | null;
  session_cap_cents: number | null;
  expires_at: number | null;
  consumed_at: number | null;
  consumed_by_account_id: string | null;
  created_at: number;
  notes: string | null;
}

export function getVoucher(id: string): VoucherRow | undefined {
  return db().prepare("SELECT * FROM vouchers WHERE id = ?").get(id) as VoucherRow | undefined;
}

export function isRedeemable(v: VoucherRow, now = Date.now()): { ok: true } | { ok: false; code: string; message: string } {
  if (v.consumed_at !== null) return { ok: false, code: "VOUCHER_CONSUMED", message: "Voucher already redeemed" };
  if (v.expires_at !== null && v.expires_at < now) {
    return { ok: false, code: "VOUCHER_EXPIRED", message: "Voucher expired" };
  }
  return { ok: true };
}

/**
 * Atomically: verify still redeemable, mark consumed, return updated row.
 * Throws on race (someone else redeemed while we were processing).
 */
export function consumeVoucher(id: string, accountId: string, now: number): VoucherRow {
  const result = db()
    .prepare(
      `UPDATE vouchers
       SET consumed_at = ?, consumed_by_account_id = ?
       WHERE id = ?
         AND consumed_at IS NULL
         AND (expires_at IS NULL OR expires_at >= ?)`,
    )
    .run(now, accountId, id, now);
  if (result.changes === 0) {
    const v = getVoucher(id);
    if (!v) throw new Error(`Voucher ${id} not found`);
    throw new Error(
      v.consumed_at !== null
        ? `Voucher ${id} already consumed`
        : `Voucher ${id} expired`,
    );
  }
  return getVoucher(id)!;
}

export function insertVoucher(row: VoucherRow): void {
  db()
    .prepare(
      `INSERT INTO vouchers
       (id, batch, campaign, affiliate_id, initial_credit_cents, daily_cap_cents, session_cap_cents, expires_at, consumed_at, consumed_by_account_id, created_at, notes)
       VALUES
       (@id, @batch, @campaign, @affiliate_id, @initial_credit_cents, @daily_cap_cents, @session_cap_cents, @expires_at, @consumed_at, @consumed_by_account_id, @created_at, @notes)`,
    )
    .run(row);
}
