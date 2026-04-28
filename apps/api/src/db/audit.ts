import { db } from "./index.js";

export interface AuditEntry {
  account_id: string | null;
  api_key_id: string | null;
  method: string;
  path: string;
  status: number;
  code: string | null;
  duration_ms: number;
  request_id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export function recordAudit(e: AuditEntry): void {
  db()
    .prepare(
      `INSERT INTO audit_log (account_id, api_key_id, method, path, status, code, duration_ms, request_id, ip, user_agent, created_at)
       VALUES (@account_id, @api_key_id, @method, @path, @status, @code, @duration_ms, @request_id, @ip, @user_agent, @created_at)`,
    )
    .run(e);
}
