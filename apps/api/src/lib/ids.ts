// ULID-ish ID generator. Crockford base32, 26 chars, time-ordered.
// We keep it dependency-free; `ulid` would also work fine.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function genId(prefix: string): string {
  const time = Date.now();
  let timeStr = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeStr = ALPHABET[t % 32]! + timeStr;
    t = Math.floor(t / 32);
  }
  const buf = randomBytes(10);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += ALPHABET[buf[i % 10]! % 32];
  }
  return `${prefix}_${timeStr}${randStr}`;
}

export function ethDepositAddress(): string {
  // Placeholder until we wire to the real wallet-issuance service.
  // The real implementation calls the existing crypto wallet API.
  const buf = randomBytes(20);
  return "0x" + buf.toString("hex");
}
