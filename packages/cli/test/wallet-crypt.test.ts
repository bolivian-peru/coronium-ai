// Round-trip and bad-passphrase tests for the encryption layer.
// Pure-function level — no filesystem, no CLI. Fast.

import { describe, expect, it } from "vitest";
import {
  decryptJson,
  encryptJson,
  isEncryptedFile,
  WrongPassphraseError,
} from "../src/wallet-crypt.js";

describe("wallet-crypt", () => {
  it("encrypt → decrypt round-trip preserves the JSON value", () => {
    const wallet = {
      address: "0x742d35cc6634c0532925a3b844bc9e7595f2bd12",
      privateKey: "0x" + "a".repeat(64),
      mnemonic: "abandon idea drift forest banana table crown rocket idea drift forest banana",
      app: "coronium-cli",
      version: 1,
    };
    const passphrase = "correct-horse-battery-staple";
    const enc = encryptJson(wallet, passphrase);
    expect(isEncryptedFile(enc)).toBe(true);
    const dec = decryptJson(enc, passphrase);
    expect(dec).toEqual(wallet);
  }, 30_000);

  it("two encryptions of the same plaintext produce different ciphertexts (random salt + IV)", () => {
    const data = { secret: "plaintext" };
    const a = encryptJson(data, "shared-passphrase");
    const b = encryptJson(data, "shared-passphrase");
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, 30_000);

  it("wrong passphrase raises WrongPassphraseError", () => {
    const wallet = { address: "0xabc", privateKey: "0x123" };
    const enc = encryptJson(wallet, "right-passphrase");
    expect(() => decryptJson(enc, "wrong-passphrase")).toThrow(WrongPassphraseError);
  }, 30_000);

  it("tampered ciphertext raises WrongPassphraseError (GCM tag fails)", () => {
    const enc = encryptJson({ x: 1 }, "passphrase-a");
    // Flip a byte in the ciphertext.
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext, "base64").reverse().toString("base64") };
    expect(() => decryptJson(tampered, "passphrase-a")).toThrow(WrongPassphraseError);
  }, 30_000);

  it("rejects passphrases shorter than 8 chars", () => {
    expect(() => encryptJson({}, "short")).toThrow(/at least 8/);
  });

  it("isEncryptedFile narrows correctly", () => {
    expect(isEncryptedFile({ version: 1, encrypted: true })).toBe(false); // missing fields
    const enc = encryptJson({ a: 1 }, "passphrase");
    expect(isEncryptedFile(enc)).toBe(true);
    expect(isEncryptedFile({ address: "0x", privateKey: "0x", version: 1 })).toBe(false);
  }, 30_000);
});
