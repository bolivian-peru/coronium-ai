import { db } from "./index.js";

export interface ChallengeRow {
  nonce: string;
  voucher_id: string;
  wallet_address: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export function insertChallenge(row: ChallengeRow): void {
  db()
    .prepare(
      `INSERT INTO redeem_challenges (nonce, voucher_id, wallet_address, expires_at, consumed_at, created_at)
       VALUES (@nonce, @voucher_id, @wallet_address, @expires_at, @consumed_at, @created_at)`,
    )
    .run(row);
}

export function getChallenge(nonce: string): ChallengeRow | undefined {
  return db().prepare("SELECT * FROM redeem_challenges WHERE nonce = ?").get(nonce) as ChallengeRow | undefined;
}

/**
 * Atomically consume a nonce. Returns true on first consumption, false if
 * already consumed or expired. Race-safe.
 */
export function consumeChallenge(nonce: string, now: number): boolean {
  const r = db()
    .prepare(
      `UPDATE redeem_challenges
       SET consumed_at = ?
       WHERE nonce = ? AND consumed_at IS NULL AND expires_at >= ?`,
    )
    .run(now, nonce, now);
  return r.changes === 1;
}

export function pruneExpiredChallenges(now: number): number {
  const r = db()
    .prepare(`DELETE FROM redeem_challenges WHERE expires_at < ? AND consumed_at IS NULL`)
    .run(now - 24 * 3600 * 1000); // keep expired-but-not-consumed for 24h for debugging
  return r.changes;
}
