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
  noPrompt?: boolean;        // headless mode — fail if any input would block on stdin
  printMnemonic?: boolean;   // emit mnemonic to stdout (or to JSON output)
  json?: boolean;            // machine-readable output
}

/**
 * Returns true if the CLI should run non-interactively (no TTY prompts).
 *
 * Triggered by:
 *   --no-prompt flag (Commander stores as opts.prompt === false)
 *   { noPrompt: true } in the programmatic InitOptions API
 *   CORONIUM_NON_INTERACTIVE=1 env var
 */
function isHeadless(opts: InitOptions & { prompt?: boolean }): boolean {
  if (opts.noPrompt === true) return true;
  if (opts.prompt === false) return true; // Commander --no-prompt
  if (process.env.CORONIUM_NON_INTERACTIVE === "1") return true;
  return false;
}

function envVoucher(): string | undefined {
  const v = process.env.CORONIUM_VOUCHER?.trim();
  return v && v.length > 0 ? v : undefined;
}

function envMnemonic(): string | undefined {
  const v = process.env.CORONIUM_WALLET_MNEMONIC?.trim();
  return v && v.length > 0 ? v : undefined;
}

function envPrivKey(): string | undefined {
  const v = process.env.CORONIUM_WALLET_PRIVATE_KEY?.trim();
  return v && v.length > 0 ? v : undefined;
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const existing = await loadConfig();
  const headless = isHeadless(opts);
  const json = Boolean(opts.json);

  // ─── Bypass: store an existing key ──────────────────────────────────
  if (opts.apiKey) {
    await saveConfig({ ...existing, api_key: opts.apiKey });
    if (json) {
      console.log(JSON.stringify({ stored: true, config_file: CONFIG_FILE }));
    } else {
      console.log(kleur.green("✓") + ` API key stored at ${CONFIG_FILE}`);
    }
    return;
  }

  // ─── Already initialized? ───────────────────────────────────────────
  if (existing.api_key && !opts.restore) {
    if (json) {
      console.log(JSON.stringify({ already_initialized: true, config_file: CONFIG_FILE }));
    } else {
      console.log(kleur.yellow("Already initialized.") + ` Config at ${CONFIG_FILE}`);
      console.log(`Run ${kleur.bold("coronium balance")} to verify, or ${kleur.bold("coronium key:rotate")} to refresh the key.`);
    }
    return;
  }

  // ─── Restore path ───────────────────────────────────────────────────
  if (opts.restore) {
    return restoreAccount(headless, json);
  }

  // ─── Voucher path (default) ─────────────────────────────────────────
  let voucher = opts.voucher ?? envVoucher();
  if (!voucher) {
    if (headless) {
      die(json, "VOUCHER_MISSING", "No voucher provided. Pass --voucher or set CORONIUM_VOUCHER.");
    }
    const ans = await prompts({
      type: "text",
      name: "v",
      message: "Voucher code (cor_v1_…):",
      validate: (s) => /^cor_v[0-9]+_/.test(String(s).trim()) || "must start with cor_v…_",
    });
    voucher = ans.v;
  }
  if (!voucher) {
    die(json, "VOUCHER_MISSING", "A voucher is required. Get one at https://coronium.ai/free.");
  }

  // ─── Wallet selection ───────────────────────────────────────────────
  let stored: StoredWallet;
  let mnemonicToShow: string | undefined;

  const existingWallet = await loadWallet();
  if (existingWallet) {
    if (!json) console.log(kleur.dim(`Using existing wallet at ${WALLET_FILE} (${existingWallet.address})`));
    stored = existingWallet;
  } else {
    let choice: "new" | "mnemonic" | "privkey" = opts.walletFrom === "existing"
      ? "new"
      : (opts.walletFrom ?? (headless ? resolveHeadlessWalletSource() : await pickWalletSource()));

    if (choice === "new") {
      const g = generateWallet();
      stored = g.stored;
      mnemonicToShow = g.mnemonic;
    } else if (choice === "mnemonic") {
      const m = envMnemonic() ?? (headless
        ? die(json, "MNEMONIC_MISSING", "Headless mode: set CORONIUM_WALLET_MNEMONIC env var or use --wallet-from new.")
        : (await prompts({ type: "password", name: "mnemonic", message: "12 or 24 word recovery phrase:" })).mnemonic);
      const r = restoreFromMnemonic(String(m));
      stored = r.stored;
    } else {
      const p = envPrivKey() ?? (headless
        ? die(json, "PRIVATE_KEY_MISSING", "Headless mode: set CORONIUM_WALLET_PRIVATE_KEY env var or use --wallet-from new.")
        : (await prompts({ type: "password", name: "pk", message: "Private key (0x…):" })).pk);
      const r = restoreFromPrivateKey(String(p));
      stored = r.stored;
    }

    await saveWallet(stored);
    if (mnemonicToShow) {
      // Always persist seed.txt for human users (mode 0400). Encryption is
      // separately opt-in via `coronium wallet:encrypt`.
      await saveSeedReadOnly(mnemonicToShow);
      if (!json && !headless) printSeedWarning(mnemonicToShow);
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

  // ─── Output ─────────────────────────────────────────────────────────
  if (json) {
    const out: Record<string, unknown> = {
      account_id: result.account_id,
      api_key: result.api_key,
      wallet_address: result.wallet_address,
      wallet_chain: result.wallet_chain,
      balance_usd: result.balance_usd,
      daily_spend_cap_usd: result.daily_spend_cap_usd,
      deposit_addresses: result.deposit_addresses,
      config_file: CONFIG_FILE,
    };
    if (opts.printMnemonic && mnemonicToShow) out.mnemonic = mnemonicToShow;
    console.log(JSON.stringify(out));
    return;
  }

  console.log("");
  console.log(kleur.green("✓") + ` Account created: ${kleur.bold(result.account_id)}`);
  console.log(`  ${kleur.dim("wallet         ")} ${result.wallet_address} ${kleur.dim("(Base / EVM)")}`);
  console.log(`  ${kleur.dim("api key        ")} ${result.api_key}  ${kleur.yellow("(stored, shown once)")}`);
  console.log(`  ${kleur.dim("trial credit   ")} $${result.balance_usd.toFixed(2)}`);
  console.log(`  ${kleur.dim("daily cap      ")} $${result.daily_spend_cap_usd.toFixed(2)}`);
  console.log(`  ${kleur.dim("USDC deposit   ")} ${result.deposit_addresses.evm_native} ${kleur.dim("(your own — Base/Arbitrum/Optimism)")}`);
  if (opts.printMnemonic && mnemonicToShow) {
    console.log("");
    console.log(kleur.yellow("--print-mnemonic") + " was set; mnemonic on next line:");
    console.log(mnemonicToShow);
  }
  console.log("");
  console.log(`Try: ${kleur.bold("coronium proxy get --country US --type 5g")}`);
}

function resolveHeadlessWalletSource(): "new" | "mnemonic" | "privkey" {
  if (envMnemonic()) return "mnemonic";
  if (envPrivKey()) return "privkey";
  return "new";
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
  console.log(kleur.dim("Tip: encrypt at rest with `coronium wallet:encrypt`."));
}

async function restoreAccount(headless: boolean, json: boolean): Promise<void> {
  if (!json) console.log(kleur.bold("Restore an existing Coronium account from your wallet"));
  let stored = await loadWallet();
  if (!stored) {
    if (headless) {
      const m = envMnemonic();
      const pk = envPrivKey();
      if (!m && !pk) {
        die(json, "WALLET_MISSING", "Headless --restore needs CORONIUM_WALLET_MNEMONIC or CORONIUM_WALLET_PRIVATE_KEY.");
      }
      stored = m ? restoreFromMnemonic(m).stored : restoreFromPrivateKey(pk!).stored;
    } else {
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
    }
    await saveWallet(stored);
  }

  const account = accountFromStored(stored);
  const challenge = await api.rotateChallenge({ wallet_address: stored.address });
  const signature = await account.signMessage({ message: challenge.siwe_message });
  const result = await api.rotate({ siwe_message: challenge.siwe_message, signature });

  const existing = await loadConfig();
  await saveConfig({ ...existing, api_key: result.api_key });

  if (json) {
    console.log(JSON.stringify({
      restored: true,
      account_id: result.account_id,
      api_key: result.api_key,
      wallet_address: result.wallet_address,
    }));
    return;
  }

  console.log(kleur.green("✓") + ` Restored account: ${kleur.bold(result.account_id)}`);
  console.log(`  ${kleur.dim("wallet  ")} ${result.wallet_address}`);
  console.log(`  ${kleur.dim("api key ")} ${result.api_key} ${kleur.yellow("(stored)")}`);
}

function die(json: boolean, code: string, message: string): never {
  if (json) {
    console.log(JSON.stringify({ error: { code, summary: message, hints: [], raw_message: message } }));
  } else {
    console.error(kleur.red(`error[${code}]`) + ` ${message}`);
  }
  process.exit(2);
}

function chunked<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
