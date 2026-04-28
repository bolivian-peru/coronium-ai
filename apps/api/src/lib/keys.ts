// API key utilities. Format: `sk_live_<40 char base62>`. We store only a
// scrypt hash; lookup is by the first 12 chars of the random portion (the
// `prefix`), then constant-time hash verify.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "sk_live_";
const KEY_RANDOM_LEN = 40;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_OUTPUT_BYTES = 32;
const SALT_BYTES = 16;

export function generateKey(): { full: string; prefix: string; hash: string } {
  // Cryptographically random; uniform across the alphabet.
  const buf = randomBytes(KEY_RANDOM_LEN);
  let body = "";
  for (let i = 0; i < KEY_RANDOM_LEN; i++) body += ALPHABET[buf[i]! % ALPHABET.length];
  const full = KEY_PREFIX + body;
  const prefix = body.slice(0, 12); // index column — DB lookup
  const hash = hashKey(full);
  return { full, prefix, hash };
}

export function hashKey(key: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(key, salt, SCRYPT_OUTPUT_BYTES, SCRYPT_PARAMS);
  return `scrypt$${SALT_BYTES}$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyKey(key: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return false;
  const N = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  const salt = Buffer.from(parts[5]!, "base64");
  const expected = Buffer.from(parts[6]!, "base64");
  const derived = scryptSync(key, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function extractPrefix(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  return key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 12);
}
