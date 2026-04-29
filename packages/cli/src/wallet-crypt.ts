// Encrypt/decrypt the wallet file with a passphrase. AES-256-GCM with
// scrypt-derived key. Pure Node `crypto`, no external deps.
//
// File format (versioned JSON wrapper around the encrypted blob):
//
//   {
//     "version": 1,
//     "encrypted": true,
//     "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64>" },
//     "cipher": { "name": "aes-256-gcm", "iv": "<base64>", "tag": "<base64>" },
//     "ciphertext": "<base64>"
//   }
//
// The plaintext is whatever was originally in `wallet.json` — typically a
// `StoredWallet` object including the privateKey and mnemonic.
//
// Why scrypt and not Argon2id? Node has scrypt built-in (no native binding,
// no wasm load); scrypt at N=131072 (~256 MB peak, ~200 ms derive on a
// modern laptop) is comparable in cost to Argon2id at typical params, and
// has a much simpler dependency story.

import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

export const SCRYPT_N = 131072; // 2^17 — ~256 MB peak, ~200 ms on commodity hardware
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LEN = 32; // 256-bit key for AES-256
export const SCRYPT_MAX_MEM = 256 * 1024 * 1024;
export const SALT_LEN = 16;
export const IV_LEN = 12;

export interface EncryptedFile {
  version: 1;
  encrypted: true;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase or corrupted file");
    this.name = "WrongPassphraseError";
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEM,
  });
}

export function encryptJson(plaintext: unknown, passphrase: string): EncryptedFile {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters");
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const buf = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    encrypted: true,
    kdf: { name: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: tag.toString("base64") },
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJson<T = unknown>(file: EncryptedFile, passphrase: string): T {
  if (file.version !== 1) throw new Error(`Unsupported encrypted file version: ${file.version}`);
  if (file.kdf.name !== "scrypt") throw new Error(`Unsupported KDF: ${file.kdf.name}`);
  if (file.cipher.name !== "aes-256-gcm") throw new Error(`Unsupported cipher: ${file.cipher.name}`);

  const salt = Buffer.from(file.kdf.salt, "base64");
  const iv = Buffer.from(file.cipher.iv, "base64");
  const tag = Buffer.from(file.cipher.tag, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");

  const key = scryptSync(passphrase, salt, SCRYPT_KEY_LEN, {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    maxmem: SCRYPT_MAX_MEM,
  });

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    // GCM tag mismatch == wrong passphrase or tampering; either way, bail.
    throw new WrongPassphraseError();
  }
}

/** Type-narrow a parsed JSON object to EncryptedFile. */
export function isEncryptedFile(o: unknown): o is EncryptedFile {
  if (!o || typeof o !== "object") return false;
  const f = o as Partial<EncryptedFile>;
  return (
    f.version === 1 &&
    f.encrypted === true &&
    typeof f.ciphertext === "string" &&
    !!f.kdf &&
    typeof f.kdf.salt === "string" &&
    !!f.cipher &&
    typeof f.cipher.iv === "string" &&
    typeof f.cipher.tag === "string"
  );
}

// Re-export for tests
export { timingSafeEqual };
