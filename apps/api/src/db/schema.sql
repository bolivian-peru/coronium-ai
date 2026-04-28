-- Coronium API — SQLite schema
-- Conventions:
--   - all timestamps stored as INTEGER (unix ms)
--   - all monetary amounts stored as INTEGER (cents) — never floats
--   - api_keys.key_hash is scrypt(key) — we never store the key itself

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    email           TEXT,
    created_at      INTEGER NOT NULL,
    deposit_addr    TEXT NOT NULL,
    daily_cap_cents INTEGER NOT NULL,
    session_cap_cents INTEGER NOT NULL,
    upstream_user_id TEXT,                    -- maps to cor-api-v1 user._id when known
    deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_upstream ON accounts(upstream_user_id);

CREATE TABLE IF NOT EXISTS api_keys (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    prefix          TEXT NOT NULL,            -- first 12 chars of the key, displayable
    key_hash        TEXT NOT NULL,            -- scrypt hash; lookup is by prefix then verify hash
    label           TEXT,
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER,
    revoked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);

CREATE TABLE IF NOT EXISTS spend_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    api_key_id      TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    amount_cents    INTEGER NOT NULL,         -- positive = charge, negative = refund
    reason          TEXT NOT NULL,            -- e.g. "proxy_buy:px_…", "refund:…"
    upstream_ref    TEXT,                     -- proxy id, payment id, etc.
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_account_day ON spend_ledger(account_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT,
    api_key_id      TEXT,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    status          INTEGER NOT NULL,
    code            TEXT,                     -- error code if any (stable)
    duration_ms     INTEGER,
    request_id      TEXT,
    ip              TEXT,
    user_agent      TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id);

-- Schema version. Bumped manually when migrations.ts is updated.
CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');
