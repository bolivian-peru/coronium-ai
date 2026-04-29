// `coronium wallet:encrypt` and `coronium wallet:decrypt`
//
// Encrypts the wallet file at rest with a passphrase. AES-256-GCM with a
// scrypt-derived key. See wallet-crypt.ts for primitives + threat model.

import kleur from "kleur";
import prompts from "prompts";
import {
  decryptWalletAtRest,
  encryptWalletAtRest,
  isWalletEncrypted,
  WALLET_FILE,
  WrongPassphraseError,
} from "../wallet.js";

interface BaseOpts {
  json?: boolean;
}

async function readPassphrase(message: string, confirm: boolean): Promise<string> {
  const p1 = await prompts({ type: "password", name: "p", message });
  const passphrase = String(p1.p ?? "");
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters.");
  }
  if (confirm) {
    const p2 = await prompts({ type: "password", name: "p", message: "Confirm passphrase:" });
    if (String(p2.p ?? "") !== passphrase) {
      throw new Error("Passphrases don't match.");
    }
  }
  return passphrase;
}

export async function walletEncryptCommand(opts: BaseOpts): Promise<void> {
  if (await isWalletEncrypted()) {
    if (opts.json) {
      console.log(JSON.stringify({ already_encrypted: true, file: WALLET_FILE }));
    } else {
      console.log(kleur.yellow("Wallet is already encrypted.") + " Use " + kleur.bold("coronium wallet:decrypt") + " first if you want to re-encrypt with a new passphrase.");
    }
    return;
  }

  // Allow CORONIUM_WALLET_PASSPHRASE for headless deploys.
  const envPass = process.env.CORONIUM_WALLET_PASSPHRASE;
  let passphrase: string;

  if (envPass && envPass.length >= 8) {
    passphrase = envPass;
    if (!opts.json) {
      console.log(kleur.dim("Using passphrase from CORONIUM_WALLET_PASSPHRASE env."));
    }
  } else {
    if (process.env.CORONIUM_NON_INTERACTIVE === "1") {
      throw new Error("Headless mode: set CORONIUM_WALLET_PASSPHRASE (≥ 8 chars) before running wallet:encrypt.");
    }
    if (!opts.json) {
      console.log("Encrypting wallet at " + kleur.bold(WALLET_FILE));
      console.log(kleur.dim("Passphrase ≥ 8 chars. We can't recover this for you — write it down."));
    }
    passphrase = await readPassphrase("New passphrase:", true);
  }

  await encryptWalletAtRest(passphrase);

  if (opts.json) {
    console.log(JSON.stringify({ encrypted: true, file: WALLET_FILE, seed_file_removed: true }));
  } else {
    console.log(kleur.green("✓") + ` Wallet encrypted at ${WALLET_FILE}`);
    console.log(kleur.dim("  seed.txt removed — the mnemonic now lives only in the encrypted wallet."));
    console.log(kleur.dim("  Subsequent commands (key:rotate, init --restore) will prompt for the passphrase,"));
    console.log(kleur.dim("  or read CORONIUM_WALLET_PASSPHRASE env in headless mode."));
  }
}

export async function walletDecryptCommand(opts: BaseOpts): Promise<void> {
  if (!(await isWalletEncrypted())) {
    if (opts.json) {
      console.log(JSON.stringify({ already_plaintext: true, file: WALLET_FILE }));
    } else {
      console.log(kleur.yellow("Wallet is already plaintext (not encrypted)."));
    }
    return;
  }

  const envPass = process.env.CORONIUM_WALLET_PASSPHRASE;
  let passphrase: string;
  if (envPass && envPass.length >= 8) {
    passphrase = envPass;
  } else {
    if (process.env.CORONIUM_NON_INTERACTIVE === "1") {
      throw new Error("Headless mode: set CORONIUM_WALLET_PASSPHRASE before running wallet:decrypt.");
    }
    passphrase = await readPassphrase("Wallet passphrase:", false);
  }

  try {
    const wallet = await decryptWalletAtRest(passphrase);
    if (opts.json) {
      console.log(JSON.stringify({ decrypted: true, address: wallet.address, file: WALLET_FILE }));
    } else {
      console.log(kleur.green("✓") + ` Wallet decrypted to plaintext at ${WALLET_FILE}`);
      console.log(`  ${kleur.dim("address  ")} ${wallet.address}`);
      console.log(kleur.yellow("  Wallet is no longer encrypted at rest. Be aware of who can read this file."));
    }
  } catch (e) {
    if (e instanceof WrongPassphraseError) {
      throw new Error("Wrong passphrase or corrupted wallet file. Try again.");
    }
    throw e;
  }
}
