// `coronium init`: voucher-gated, wallet-bound (SIWE) sign-up, restore, or
// storing an existing API token. The SDK makes the HTTP calls; the wallet keys
// and signing stay in this CLI.

import kleur from "kleur";
import prompts from "prompts";
import type { Coronium, WalletChallenge, WalletRotateResult, WalletSignupResult } from "coronium-sdk";
import { makeClient } from "../client.js";
import { getApiToken, loadConfig, saveConfig, type CliConfig } from "../config.js";
import { UsageError } from "../output.js";
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

type WalletSource = "new" | "mnemonic" | "privkey";

export interface InitOptions {
  email?: string;
  apiKey?: string;
  voucher?: string;
  walletFrom?: WalletSource | "existing";
  restore?: boolean;
  noPrompt?: boolean;
  /** Commander stores --no-prompt as prompt === false. */
  prompt?: boolean;
  printMnemonic?: boolean;
  json?: boolean;
}

interface WalletChoice {
  stored: StoredWallet;
  mnemonicToShow: string | undefined;
}

function isHeadless(options: InitOptions): boolean {
  if (options.noPrompt === true) return true;
  if (options.prompt === false) return true;
  return process.env.CORONIUM_NON_INTERACTIVE === "1";
}

function envValue(name: string): string | undefined {
  const value: string | undefined = process.env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  return value;
}

function printJsonLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function storeApiKey(options: InitOptions, existing: CliConfig, apiKey: string): Promise<void> {
  const path: string = await saveConfig({ ...existing, api_key: apiKey });
  if (options.json) {
    printJsonLine({ stored: true, config_file: path });
    return;
  }
  console.log(`${kleur.green("✓")} API token stored at ${path}`);
}

async function askVoucher(headless: boolean): Promise<string> {
  const fromEnv: string | undefined = envValue("CORONIUM_VOUCHER");
  if (fromEnv) return fromEnv;
  if (headless) throw new UsageError("No voucher provided. Pass --voucher or set CORONIUM_VOUCHER.");
  const answer: { voucher?: string } = await prompts({
    type: "text",
    name: "voucher",
    message: "Voucher code (cor_v1_...):",
    validate: (value: string): boolean | string => /^cor_v[0-9]+_/.test(String(value).trim()) || "must start with cor_v..._",
  });
  const voucher: string = String(answer.voucher ?? "").trim();
  if (voucher === "") throw new UsageError("A voucher is required for wallet sign-up.");
  return voucher;
}

function headlessWalletSource(): WalletSource {
  if (envValue("CORONIUM_WALLET_MNEMONIC")) return "mnemonic";
  if (envValue("CORONIUM_WALLET_PRIVATE_KEY")) return "privkey";
  return "new";
}

async function pickWalletSource(): Promise<WalletSource> {
  const answer: { source?: WalletSource } = await prompts({
    type: "select",
    name: "source",
    message: "Wallet:",
    choices: [
      { title: "Generate a new EVM wallet (recommended)", value: "new" },
      { title: "Import existing recovery phrase (12 or 24 words)", value: "mnemonic" },
      { title: "Import existing private key (0x...)", value: "privkey" },
    ],
  });
  return answer.source ?? "new";
}

async function chooseSource(options: InitOptions, headless: boolean): Promise<WalletSource> {
  if (options.walletFrom === "existing") return "new";
  if (options.walletFrom) return options.walletFrom;
  if (headless) return headlessWalletSource();
  return pickWalletSource();
}

async function readSecret(envName: string, message: string, headless: boolean): Promise<string> {
  const fromEnv: string | undefined = envValue(envName);
  if (fromEnv) return fromEnv;
  if (headless) throw new UsageError(`Headless mode: set ${envName} or use --wallet-from new.`);
  const answer: { secret?: string } = await prompts({ type: "password", name: "secret", message });
  return String(answer.secret ?? "");
}

async function buildWallet(source: WalletSource, headless: boolean): Promise<WalletChoice> {
  if (source === "new") {
    const generated = generateWallet();
    return { stored: generated.stored, mnemonicToShow: generated.mnemonic };
  }
  if (source === "mnemonic") {
    const mnemonic: string = await readSecret("CORONIUM_WALLET_MNEMONIC", "12 or 24 word recovery phrase:", headless);
    return { stored: restoreFromMnemonic(mnemonic).stored, mnemonicToShow: undefined };
  }
  const privateKey: string = await readSecret("CORONIUM_WALLET_PRIVATE_KEY", "Private key (0x...):", headless);
  return { stored: restoreFromPrivateKey(privateKey).stored, mnemonicToShow: undefined };
}

async function walletForSignup(options: InitOptions, headless: boolean): Promise<WalletChoice> {
  const existingWallet: StoredWallet | undefined = await loadWallet();
  if (existingWallet) {
    if (!options.json) console.log(kleur.dim(`Using existing wallet at ${WALLET_FILE} (${existingWallet.address})`));
    return { stored: existingWallet, mnemonicToShow: undefined };
  }
  const choice: WalletChoice = await buildWallet(await chooseSource(options, headless), headless);
  await saveWallet(choice.stored);
  if (choice.mnemonicToShow) {
    // seed.txt (mode 0400) is always written for people; encryption is opt-in via wallet:encrypt.
    await saveSeedReadOnly(choice.mnemonicToShow);
    if (!options.json && !headless) printSeedWarning(choice.mnemonicToShow);
  }
  return choice;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const existing: CliConfig = await loadConfig();
  const headless: boolean = isHeadless(options);
  if (options.apiKey) {
    await storeApiKey(options, existing, options.apiKey);
    return;
  }
  if (options.restore) {
    await restoreAccount(options, headless);
    return;
  }
  if (existing.api_key) {
    printAlreadyInitialized(options);
    return;
  }
  const voucher: string = options.voucher ?? (await askVoucher(headless));
  const wallet: WalletChoice = await walletForSignup(options, headless);
  const client: Coronium = await makeClient({ requireToken: false });
  const signer = accountFromStored(wallet.stored);
  const challenge: WalletChallenge = await client.wallet.challenge({ walletAddress: wallet.stored.address, voucher });
  const signature: string = await signer.signMessage({ message: challenge.message });
  const result: WalletSignupResult = await client.wallet.signup({
    walletAddress: wallet.stored.address,
    voucher,
    message: challenge.message,
    signature,
  });
  const path: string = await saveConfig({ ...existing, api_key: result.api_token, email: options.email ?? existing.email });
  printSignup(options, result, path, wallet.mnemonicToShow);
}

function printAlreadyInitialized(options: InitOptions): void {
  if (options.json) {
    printJsonLine({ already_initialized: true });
    return;
  }
  console.log(kleur.yellow("Already initialized."));
  console.log(`Run ${kleur.bold("coronium status")} to verify, or ${kleur.bold("coronium key:rotate")} to get a new token.`);
}

function printSignup(options: InitOptions, result: WalletSignupResult, path: string, mnemonic: string | undefined): void {
  if (options.json) {
    const out: Record<string, unknown> = {
      account_id: result.user_id,
      api_key: result.api_token,
      wallet_address: result.wallet_address,
      balance_usd: result.balance_usd,
      config_file: path,
    };
    if (options.printMnemonic && mnemonic) out.mnemonic = mnemonic;
    printJsonLine(out);
    return;
  }
  console.log("");
  console.log(`${kleur.green("✓")} Account created: ${kleur.bold(result.user_id)}`);
  console.log(`  ${kleur.dim("wallet       ")} ${result.wallet_address}`);
  console.log(`  ${kleur.dim("api token    ")} stored in ${path}`);
  console.log(`  ${kleur.dim("credit       ")} $${result.balance_usd.toFixed(2)}`);
  if (options.printMnemonic && mnemonic) {
    console.log("");
    console.log(`${kleur.yellow("--print-mnemonic")} was set; mnemonic on the next line:`);
    console.log(mnemonic);
  }
  console.log("");
  console.log(`Next: ${kleur.bold("coronium tariffs --country US")}`);
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function printSeedWarning(mnemonic: string): void {
  const rows: string[] = chunked(mnemonic.split(/\s+/), 4).map((row: string[], index: number): string => {
    const first: string = String(index * 4 + 1).padStart(2, " ");
    const last: string = String(index * 4 + row.length).padStart(2, " ");
    return `   ${first}-${last}  ${row.join("  ")}`;
  });
  console.log("");
  console.log(kleur.bold().red("YOUR SEED PHRASE: write it down now. It is your account."));
  console.log(kleur.bold().red("Coronium cannot recover it. Anyone who has it controls the wallet."));
  console.log("");
  console.log(rows.join("\n"));
  console.log("");
  console.log(kleur.dim("Tip: encrypt it at rest with `coronium wallet:encrypt`."));
}

async function restoreWallet(headless: boolean): Promise<StoredWallet> {
  const existingWallet: StoredWallet | undefined = await loadWallet();
  if (existingWallet) return existingWallet;
  let source: WalletSource = headlessWalletSource();
  if (!headless) {
    const answer: { source?: WalletSource } = await prompts({
      type: "select",
      name: "source",
      message: "Wallet recovery:",
      choices: [
        { title: "Mnemonic phrase", value: "mnemonic" },
        { title: "Private key (0x...)", value: "privkey" },
      ],
    });
    source = answer.source ?? "mnemonic";
  }
  if (source === "new") {
    throw new UsageError("Headless --restore needs CORONIUM_WALLET_MNEMONIC or CORONIUM_WALLET_PRIVATE_KEY.");
  }
  const choice: WalletChoice = await buildWallet(source, headless);
  await saveWallet(choice.stored);
  return choice.stored;
}

async function restoreAccount(options: InitOptions, headless: boolean): Promise<void> {
  if (!options.json) console.log(kleur.bold("Restore a Coronium account from your wallet"));
  const stored: StoredWallet = await restoreWallet(headless);
  const existing: CliConfig = await loadConfig();
  const currentToken: string | undefined = getApiToken(existing);
  if (!currentToken) {
    throw new UsageError(
      "init --restore needs an existing API token (the wallet alone cannot mint one). Set CORONIUM_API_TOKEN, or run coronium init --voucher <code> for a new account.",
    );
  }
  const result: WalletRotateResult = await rotateWithWallet(stored, currentToken);
  await saveConfig({ ...existing, api_key: result.api_token });
  if (options.json) {
    printJsonLine({ restored: true, wallet_address: stored.address });
    return;
  }
  console.log(`${kleur.green("✓")} Restored. New API token stored for wallet ${stored.address}.`);
}

/** Sign the rotation challenge with the wallet and return the new token. */
export async function rotateWithWallet(stored: StoredWallet, currentToken: string): Promise<WalletRotateResult> {
  const client: Coronium = await makeClient({ requireToken: true, token: currentToken });
  const signer = accountFromStored(stored);
  const challenge: WalletChallenge = await client.wallet.rotateChallenge();
  const signature: string = await signer.signMessage({ message: challenge.message });
  return client.wallet.rotate({ message: challenge.message, signature });
}
