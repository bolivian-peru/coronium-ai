import { db } from "./index.js";

export interface AccountRow {
  id: string;
  email: string | null;
  created_at: number;
  deposit_addr: string;
  daily_cap_cents: number;
  session_cap_cents: number;
  upstream_user_id: string | null;
  deleted_at: number | null;
}

export function insertAccount(row: AccountRow): void {
  db()
    .prepare(
      `INSERT INTO accounts (id, email, created_at, deposit_addr, daily_cap_cents, session_cap_cents, upstream_user_id, deleted_at)
       VALUES (@id, @email, @created_at, @deposit_addr, @daily_cap_cents, @session_cap_cents, @upstream_user_id, @deleted_at)`,
    )
    .run(row);
}

export function getAccount(id: string): AccountRow | undefined {
  return db()
    .prepare("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL")
    .get(id) as AccountRow | undefined;
}

export function getAccountByEmail(email: string): AccountRow | undefined {
  return db()
    .prepare("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL")
    .get(email) as AccountRow | undefined;
}
