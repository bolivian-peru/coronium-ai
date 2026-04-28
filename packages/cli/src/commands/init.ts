import kleur from "kleur";
import prompts from "prompts";
import { CONFIG_FILE, loadConfig, saveConfig } from "../config.js";
import {
  WALLET_FILE,
  accountFromStored,
  generateWallet,
  loadWallet,
  restoreFromMnemonic,
  restoreFromPrivateKey,
  saveSeedReadOnly,
  saveWallet,
  type StoredWallet,
} from "../wallet.js";
import { api } from "../api.js";

export interface InitOptions {
  email?: string;            // optional email tag (no longer used for verification)
  apiKey?: string;           // bypass: paste an existing key
  voucher?: string;          // voucher to redeem
  walletFrom?: "new" | "mnemonic" | "privkey" | "existing";
  restore?: boolean;         // skip voucher path; restore existing account from wallet
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const existing = await loadConfig();

  // ─── Bypass: store an existing key ──────────────────────────────────
  if (opts.apiKey) {
    await saveConfig({ ...existing, api_key: opts.apiKey });
    console.log(kleur.green("✓") + ` API key stored at ${CONFIG_FILE}`);
    return;
  }

  // ─── Already initialized? ───────────────────────────────────────────
  if (existing.api_key && !opts.restore) {
    console.log(kleur.yellow("Already initialized.") + ` Config at ${CONFIG_FILE}`);
    console.log(`Run ${kleur.bold("coronium balance")} to verify, or ${kleur.bold("coronium key:rotate")} to refresh the key.`);
    return;
  }

  // ─── Restore path ───────────────────────────────────────────────────
  if (opts.restore) {
    return restoreAccount();
  }

  // ─── Voucher path (default) ─────────────────────────────────────────
  const voucher = opts.voucher ?? (await prompts({
    type: "text",
    name: "v",
    message: "Voucher code (cor_v1_…):",
    validate: (s) => /^cor_v[0-9]+_/.test(String(s).trim()) || "must start with cor_v…_",
  })).v;
  if (!voucher) {
    console.error(kleur.red("A voucher is required.") + " Get one at https://coronium.ai/free or via a partner.");
    process.exit(2);
  }

  // ─── Wallet selection ───────────────────────────────────────────────
  let stored: StoredWallet;
  let mnemonicToShow: string | undefined;

  const existingWallet = await loadWallet();
  if (existingWallet) {
    console.log(kleur.dim(`Using existing wallet at ${WALLET_FILE} (${existingWallet.address})`));
    stored = existingWallet;
  } else {
    const choice = opts.walletFrom ?? await pickWalletSource();
    if (choice === "new") {
      const g = generateWallet();
      stored = g.stored;
      mnemonicToShow = g.mnemonic;
    } else if (choice === "mnemonic") {
      const { mnemonic } = await prompts({
        type: "password",
        name: "mnemonic",
        message: "12 or 24 word recovery phrase:",
      });
      const r = restoreFromMnemonic(String(mnemonic));
      stored = r.stored;
    } else {
      const { pk } = await prompts({
        type: "password",
        name: "pk",
        message: "Private key (0x…):",
      });
      const r = restoreFromPrivateKey(String(pk));
      stored = r.stored;
    }
    await saveWallet(stored);
    if (mnemonicToShow) {
      await saveSeedReadOnly(mnemonicToShow);
      printSeedWarning(mnemonicToShow);
    }
  }

  // ─── Sign and redeem ────────────────────────────────────────────────
  const account = accountFromStored(stored);
  const challenge = await api.redeemChallenge({
    voucher,
    wallet_address: stored.address,
  });
  const signature = await account.signMessage({ message: challenge.siwe_message });
  const result = await api.redeem({
    siwe_message: challenge.siwe_message,
    signature,
  });

  await saveConfig({
    ...existing,
    api_key: result.api_key,
    email: opts.email ?? existing.email,
  });

  console.log("");
  console.log(kleur.green("✓") + ` Account created: ${kleur.bold(result.account_id)}`);
  console.log(`  ${kleur.dim("wallet         ")} ${result.wallet_address} ${kleur.dim("(Base / EVM)")}`);
  console.log(`  ${kleur.dim("api key        ")} ${result.api_key}  ${kleur.yellow("(stored, shown once)")}`);
  console.log(`  ${kleur.dim("trial credit   ")} $${result.balance_usd.toFixed(2)}`);
  console.log(`  ${kleur.dim("daily cap      ")} $${result.daily_spend_cap_usd.toFixed(2)}`);
  console.log(`  ${kleur.dim("USDC deposit   ")} ${result.deposit_addresses.evm_native} ${kleur.dim("(your own — Base/Arbitrum/Optimism)")}`);
  console.log("");
  console.log(`Try: ${kleur.bold("coronium proxy get --country US --type 5g")}`);
}

async function pickWalletSource(): Promise<"new" | "mnemonic" | "privkey"> {
  const { source } = await prompts({
    type: "select",
    name: "source",
    message: "Wallet:",
    choices: [
      { title: "Generate a new EVM wallet (recommended)", value: "new" },
      { title: "Import existing recovery phrase (12 or 24 words)", value: "mnemonic" },
      { title: "Import existing private key (0x…)", value: "privkey" },
    ],
  });
  return source ?? "new";
}

function printSeedWarning(mnemonic: string): void {
  const words = mnemonic.split(/\s+/);
  const block = chunked(words, 4)
    .map((row, i) => `   ${String(i * 4 + 1).padStart(2, " ")}-${String(i * 4 + row.length).padStart(2, " ")}  ${row.join("  ")}`)
    .join("\n");
  console.log("");
  console.log(kleur.bold().red("┌──────────────────────────────────────────────────────────────────┐"));
  console.log(kleur.bold().red("│  YOUR SEED PHRASE — write this down NOW. It IS your account.    │"));
  console.log(kleur.bold().red("│  Coronium cannot recover it. Anyone with it can drain funds.    │"));
  console.log(kleur.bold().red("└──────────────────────────────────────────────────────────────────┘"));
  console.log("");
  console.log(block);
  console.log("");
  console.log(kleur.dim("Press Enter when you've written it down to continue."));
}

async function restoreAccount(): Promise<void> {
  console.log(kleur.bold("Restore an existing Coronium account from your wallet"));
  let stored = await loadWallet();
  if (!stored) {
    const { source } = await prompts({
      type: "select",
      name: "source",
      message: "Wallet recovery:",
      choices: [
        { title: "Mnemonic phrase", value: "mnemonic" },
        { title: "Private key (0x…)", value: "privkey" },
      ],
    });
    if (source === "mnemonic") {
      const { mnemonic } = await prompts({ type: "password", name: "mnemonic", message: "Recovery phrase:" });
      stored = restoreFromMnemonic(String(mnemonic)).stored;
    } else {
      const { pk } = await prompts({ type: "password", name: "pk", message: "Private key (0x…):" });
      stored = restoreFromPrivateKey(String(pk)).stored;
    }
    await saveWallet(stored);
  }

  const account = accountFromStored(stored);
  const challenge = await api.rotateChallenge({ wallet_address: stored.address });
  const signature = await account.signMessage({ message: challenge.siwe_message });
  const result = await api.rotate({ siwe_message: challenge.siwe_message, signature });

  const existing = await loadConfig();
  await saveConfig({ ...existing, api_key: result.api_key });

  console.log(kleur.green("✓") + ` Restored account: ${kleur.bold(result.account_id)}`);
  console.log(`  ${kleur.dim("wallet  ")} ${result.wallet_address}`);
  console.log(`  ${kleur.dim("api key ")} ${result.api_key} ${kleur.yellow("(stored)")}`);
}

function chunked<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
