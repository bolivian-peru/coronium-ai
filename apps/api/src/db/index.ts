// SQLite setup. Reads schema.sql at boot, opens DB with sane PRAGMAs, exposes
// the typed Database singleton. Tests can inject `:memory:` via DATABASE_PATH.

import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

let _db: Database.Database | undefined;

export function db(): Database.Database {
  if (_db) return _db;

  const path = config.DATABASE_PATH;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("busy_timeout = 5000");

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  _db.exec(schema);

  logger.info({ path, schema_version: getMeta(_db, "schema_version") }, "db ready");

  return _db;
}

function getMeta(d: Database.Database, key: string): string | undefined {
  const row = d.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
