import { db } from "./index.js";
import { extractPrefix, verifyKey } from "../lib/keys.js";

export interface ApiKeyRow {
  id: string;
  account_id: string;
  prefix: string;
  key_hash: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function insertApiKey(row: ApiKeyRow): void {
  db()
    .prepare(
      `INSERT INTO api_keys (id, account_id, prefix, key_hash, label, created_at, last_used_at, revoked_at)
       VALUES (@id, @account_id, @prefix, @key_hash, @label, @created_at, @last_used_at, @revoked_at)`,
    )
    .run(row);
}

export function findKeyByValue(key: string): ApiKeyRow | undefined {
  const prefix = extractPrefix(key);
  if (!prefix) return undefined;

  // Look up candidates by prefix (indexed). In practice 1-2 rows max.
  const candidates = db()
    .prepare("SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL")
    .all(prefix) as ApiKeyRow[];

  for (const c of candidates) {
    if (verifyKey(key, c.key_hash)) return c;
  }
  return undefined;
}

export function touchLastUsed(apiKeyId: string, ts: number): void {
  db().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(ts, apiKeyId);
}

export function revokeKey(apiKeyId: string, ts: number): void {
  db().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(ts, apiKeyId);
}
