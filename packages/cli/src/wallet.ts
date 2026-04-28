// EVM wallet management for the CLI. Holds the user's keypair locally,
// signs SIWE messages issued by the API, and provides recovery via BIP39
// mnemonic. Keypair format matches MetaMask / standard EVM conventions —
// users can import the same mnemonic into Phantom/MetaMask if they want.

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
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

export async function loadWallet(): Promise<StoredWallet | undefined> {
  try {
    const text = await readFile(WALLET_PATH, "utf8");
    return JSON.parse(text) as StoredWallet;
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

export async function saveWallet(w: StoredWallet): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true, mode: 0o700 });
  await writeFile(WALLET_PATH, JSON.stringify(w, null, 2), { mode: 0o600 });
  await chmod(WALLET_PATH, 0o600);
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
