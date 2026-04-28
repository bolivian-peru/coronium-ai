#!/usr/bin/env node
// Internal voucher minting — operator tool. Generates a batch of voucher
// codes and inserts them into the apps/api SQLite database.
//
// Examples:
//   node scripts/mint-vouchers.mjs --count 100 --batch promo-2026-launch
//   node scripts/mint-vouchers.mjs --count 50 --batch acme-q2 --campaign acme --affiliate aff_acme01 --credit 100
//   node scripts/mint-vouchers.mjs --count 10 --batch try-it --expires 2026-12-31
//
// The codes are printed one per line to stdout. Pipe to a file/spreadsheet
// for distribution. They are bearer credentials that gate signup but cannot
// be used without a paired wallet signature, so distributing publicly is
// safe — voucher theft alone gains the attacker nothing.

import { createRequire } from "node:module";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve better-sqlite3 from apps/api's node_modules — that's the only
// workspace package that depends on it and where pnpm installs it.
const require = createRequire(`${ROOT}/apps/api/`);
const Database = require("better-sqlite3");

// ─── Args ───────────────────────────────────────────────────────────────
function getArg(name, def) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  return argv[idx + 1];
}
function getFlag(name) {
  return argv.includes(`--${name}`);
}

const count = parseInt(getArg("count", "10"), 10);
const batch = getArg("batch", `manual-${new Date().toISOString().slice(0, 10)}`);
const campaign = getArg("campaign", null);
const affiliateId = getArg("affiliate", null);
const credit = parseInt(getArg("credit", "50"), 10);     // cents
const dailyCap = getArg("daily-cap", null);              // cents, optional override
const sessionCap = getArg("session-cap", null);          // cents, optional override
const expiresStr = getArg("expires", null);              // YYYY-MM-DD, optional
const dbPath = getArg("db", `${ROOT}/apps/api/data/coronium.db`);
const dryRun = getFlag("dry-run");

if (!Number.isFinite(count) || count < 1 || count > 10_000) {
  fail("--count must be 1..10000");
}

// ─── Boot DB ────────────────────────────────────────────────────────────
if (!existsSync(dbPath)) {
  if (dbPath.includes("/data/")) mkdirSync(dirname(dbPath), { recursive: true });
}
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Ensure schema exists. The api service creates it on boot; if this is the
// first run before the api booted, we apply the schema directly.
const hasVouchersTable = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vouchers'")
  .get();
if (!hasVouchersTable) {
  const schema = require("node:fs").readFileSync(`${ROOT}/apps/api/src/db/schema.sql`, "utf8");
  db.exec(schema);
}

// ─── Mint ───────────────────────────────────────────────────────────────
const expiresAtMs = expiresStr ? new Date(expiresStr + "T23:59:59Z").getTime() : null;
const nowMs = Date.now();

const insert = db.prepare(`
  INSERT INTO vouchers
    (id, batch, campaign, affiliate_id, initial_credit_cents, daily_cap_cents, session_cap_cents,
     expires_at, consumed_at, consumed_by_account_id, created_at, notes)
  VALUES
    (@id, @batch, @campaign, @affiliate_id, @initial_credit_cents, @daily_cap_cents, @session_cap_cents,
     @expires_at, NULL, NULL, @created_at, NULL)
`);

const codes = [];
const txn = db.transaction(() => {
  for (let i = 0; i < count; i++) {
    const id = "cor_v1_" + randomBytes(20).toString("base64url").slice(0, 32);
    insert.run({
      id,
      batch,
      campaign,
      affiliate_id: affiliateId,
      initial_credit_cents: credit,
      daily_cap_cents: dailyCap !== null ? parseInt(dailyCap, 10) : null,
      session_cap_cents: sessionCap !== null ? parseInt(sessionCap, 10) : null,
      expires_at: expiresAtMs,
      created_at: nowMs,
    });
    codes.push(id);
  }
});

if (dryRun) {
  console.error(`# DRY RUN — would mint ${count} vouchers in batch=${batch}`);
} else {
  txn();
  console.error(
    `# Minted ${count} vouchers · batch=${batch}` +
      (campaign ? ` · campaign=${campaign}` : "") +
      (affiliateId ? ` · affiliate=${affiliateId}` : "") +
      ` · credit=${credit}¢` +
      (expiresAtMs ? ` · expires=${expiresStr}` : "") +
      ` · db=${dbPath}`,
  );
}

for (const c of codes) console.log(c);

db.close();

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}
