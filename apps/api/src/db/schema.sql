-- Coronium API — SQLite schema
-- Conventions:
--   - all timestamps stored as INTEGER (unix ms)
--   - all monetary amounts stored as INTEGER (cents) — never floats
--   - api_keys.key_hash is scrypt(key) — we never store the key itself
--   - wallet_address is the user's EVM address (0x + 40 hex), lowercased

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
    wallet_address  TEXT,                     -- 0x… EVM address (lowercased), unique
    wallet_chain    TEXT NOT NULL DEFAULT 'evm',  -- 'evm' for v0.1; 'sol' reserved for later
    deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_upstream ON accounts(upstream_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_wallet
    ON accounts(wallet_chain, wallet_address) WHERE wallet_address IS NOT NULL;

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

-- Vouchers: signup credentials minted in batches by Coronium staff and
-- distributed via marketing/affiliate/partner channels. Each voucher
-- redeems for exactly one account. Bound to the wallet that signs the
-- redeem challenge — voucher theft alone is insufficient.
CREATE TABLE IF NOT EXISTS vouchers (
    id              TEXT PRIMARY KEY,         -- "cor_v1_<32-base32-chars>"
    batch           TEXT NOT NULL,            -- e.g. "promo-2026-launch"
    campaign        TEXT,                     -- e.g. "affiliate-acme", marketing tracking
    affiliate_id   TEXT,                     -- nullable; non-null = attribution to that affiliate
    initial_credit_cents INTEGER NOT NULL DEFAULT 50,
    daily_cap_cents INTEGER,                  -- per-key daily cap override (NULL = use default)
    session_cap_cents INTEGER,                -- session cap override (NULL = use default)
    expires_at      INTEGER,                  -- nullable; never-expire if NULL
    consumed_at     INTEGER,                  -- NULL = unused
    consumed_by_account_id TEXT REFERENCES accounts(id),
    created_at      INTEGER NOT NULL,
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_vouchers_batch ON vouchers(batch);
CREATE INDEX IF NOT EXISTS idx_vouchers_consumed ON vouchers(consumed_at);
CREATE INDEX IF NOT EXISTS idx_vouchers_affiliate ON vouchers(affiliate_id);

-- Anti-replay nonces issued to /redeem-challenge. Each nonce is a one-shot
-- token that a client must include in the SIWE message they sign. Server
-- verifies the message contains the issued nonce, then marks consumed.
CREATE TABLE IF NOT EXISTS redeem_challenges (
    nonce           TEXT PRIMARY KEY,         -- 32-byte hex (server-generated)
    voucher_id      TEXT NOT NULL,            -- voucher this challenge is bound to
    wallet_address  TEXT NOT NULL,            -- the address client said they'd sign with
    expires_at      INTEGER NOT NULL,         -- 5 min default
    consumed_at     INTEGER,                  -- NULL = unused
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_challenges_expires ON redeem_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_challenges_voucher ON redeem_challenges(voucher_id);

-- Schema version. Bumped manually when this file changes.
CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO _meta (key, value) VALUES ('schema_version', '2')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
