// EVM wallet management for the CLI. Holds the user's keypair locally,
// signs SIWE messages issued by the API, and provides recovery via BIP39
// mnemonic. Keypair format matches MetaMask / standard EVM conventions —
// users can import the same mnemonic into Phantom/MetaMask if they want.

import { mkdir, readFile, writeFile, chmod, unlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type HDAccount,
  type PrivateKeyAccount,
  generateMnemonic,
  english,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import {
  decryptJson,
  encryptJson,
  isEncryptedFile,
  type EncryptedFile,
  WrongPassphraseError,
} from "./wallet-crypt.js";
import prompts from "prompts";

const WALLET_DIR = join(homedir(), ".coronium");
const WALLET_PATH = join(WALLET_DIR, "wallet.json");
const SEED_PATH = join(WALLET_DIR, "seed.txt");

export interface StoredWallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  mnemonic?: string;          // optional if user imported a privkey directly
  derivation_path?: string;   // m/44'/60'/0'/0/0 for the default
  created_at: string;
  app: "coronium-cli";
  version: 1;
}

export type WalletAccount = HDAccount | PrivateKeyAccount;

export interface LoadOptions {
  /** Optional passphrase for an encrypted wallet. If omitted and the wallet
   *  is encrypted, we read CORONIUM_WALLET_PASSPHRASE env, then prompt
   *  interactively (in TTY) or fail (in --no-prompt). */
  passphrase?: string;
  /** True to skip interactive prompt and fail with a clear error if the
   *  passphrase isn't available via opts/env. */
  noPrompt?: boolean;
}

export async function isWalletEncrypted(): Promise<boolean> {
  try {
    const text = await readFile(WALLET_PATH, "utf8");
    const parsed = JSON.parse(text);
    return isEncryptedFile(parsed);
  } catch (e: any) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

export async function loadWallet(opts: LoadOptions = {}): Promise<StoredWallet | undefined> {
  let text: string;
  try {
    text = await readFile(WALLET_PATH, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
  const parsed = JSON.parse(text);

  if (!isEncryptedFile(parsed)) {
    return parsed as StoredWallet;
  }

  // Encrypted — need a passphrase.
  let passphrase = opts.passphrase ?? process.env.CORONIUM_WALLET_PASSPHRASE;
  if (!passphrase) {
    if (opts.noPrompt) {
      throw new Error(
        "Wallet is encrypted but no passphrase available. Set CORONIUM_WALLET_PASSPHRASE or pass passphrase explicitly.",
      );
    }
    const { p } = await prompts({
      type: "password",
      name: "p",
      message: "Wallet passphrase:",
    });
    passphrase = String(p ?? "");
  }
  if (!passphrase) {
    throw new Error("Passphrase required to unlock wallet.");
  }
  return decryptJson<StoredWallet>(parsed as EncryptedFile, passphrase);
}

export async function saveWallet(w: StoredWallet): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true, mode: 0o700 });
  await writeFile(WALLET_PATH, JSON.stringify(w, null, 2), { mode: 0o600 });
  await chmod(WALLET_PATH, 0o600);
}

/** Encrypt-in-place: read the plaintext wallet, write the encrypted form,
 *  delete seed.txt (mnemonic now lives only in the encrypted blob). */
export async function encryptWalletAtRest(passphrase: string): Promise<void> {
  const text = await readFile(WALLET_PATH, "utf8");
  const parsed = JSON.parse(text);
  if (isEncryptedFile(parsed)) {
    throw new Error("Wallet is already encrypted. Use wallet:decrypt first if you want to re-encrypt.");
  }
  const encrypted = encryptJson(parsed, passphrase);
  await writeFile(WALLET_PATH, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  await chmod(WALLET_PATH, 0o600);
  // Clean up seed.txt — the mnemonic is now in the encrypted wallet.json.
  try {
    await unlink(SEED_PATH);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

/** Decrypt-in-place: convert encrypted wallet back to plaintext. Existing
 *  seed.txt is regenerated only if user opts in (we deliberately don't write
 *  it automatically — once you've encrypted, presumably you wanted that). */
export async function decryptWalletAtRest(passphrase: string): Promise<StoredWallet> {
  const text = await readFile(WALLET_PATH, "utf8");
  const parsed = JSON.parse(text);
  if (!isEncryptedFile(parsed)) {
    throw new Error("Wallet is not encrypted.");
  }
  const wallet = decryptJson<StoredWallet>(parsed as EncryptedFile, passphrase);
  await saveWallet(wallet);
  return wallet;
}

export async function saveSeedReadOnly(mnemonic: string): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true, mode: 0o700 });
  await writeFile(
    SEED_PATH,
    `# Coronium wallet recovery phrase — DO NOT SHARE OR LOSE\n# Same mnemonic works in MetaMask, Phantom, Rabby, etc.\n\n${mnemonic}\n`,
    { mode: 0o400 },
  );
  await chmod(SEED_PATH, 0o400);
}

/** Generate a fresh wallet from cryptographic entropy. */
export function generateWallet(): { account: HDAccount; mnemonic: string; stored: StoredWallet } {
  const mnemonic = generateMnemonic(english);
  const account = mnemonicToAccount(mnemonic);
  const stored: StoredWallet = {
    address: account.address,
    privateKey: bytesToHex(account.getHdKey().privateKey!),
    mnemonic,
    derivation_path: "m/44'/60'/0'/0/0",
    created_at: new Date().toISOString(),
    app: "coronium-cli",
    version: 1,
  };
  return { account, mnemonic, stored };
}

/** Restore from a 12-word BIP39 mnemonic. */
export function restoreFromMnemonic(mnemonic: string): { account: HDAccount; stored: StoredWallet } {
  const trimmed = mnemonic.trim().split(/\s+/).join(" ");
  const account = mnemonicToAccount(trimmed);
  const stored: StoredWallet = {
    address: account.address,
    privateKey: bytesToHex(account.getHdKey().privateKey!),
    mnemonic: trimmed,
    derivation_path: "m/44'/60'/0'/0/0",
    created_at: new Date().toISOString(),
    app: "coronium-cli",
    version: 1,
  };
  return { account, stored };
}

/** Restore from a raw 0x-prefixed private key (no mnemonic recovery). */
export function restoreFromPrivateKey(privateKey: string): { account: PrivateKeyAccount; stored: StoredWallet } {
  const pk = privateKey.startsWith("0x") ? (privateKey as `0x${string}`) : (`0x${privateKey}` as `0x${string}`);
  const account = privateKeyToAccount(pk);
  const stored: StoredWallet = {
    address: account.address,
    privateKey: pk,
    created_at: new Date().toISOString(),
    app: "coronium-cli",
    version: 1,
  };
  return { account, stored };
}

/** Re-hydrate the viem account from a stored wallet (for signing). */
export function accountFromStored(stored: StoredWallet): WalletAccount {
  if (stored.mnemonic) return mnemonicToAccount(stored.mnemonic);
  return privateKeyToAccount(stored.privateKey);
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

export const WALLET_FILE = WALLET_PATH;
export const SEED_FILE = SEED_PATH;
export { WrongPassphraseError };
// Suppress unused-import lint
void stat;
