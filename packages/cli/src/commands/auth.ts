import kleur from "kleur";
import prompts from "prompts";
import type { AccountInfo, Coronium } from "coronium-sdk";
import { makeClient } from "../client.js";
import { loadConfig, saveConfig, type CliConfig } from "../config.js";
import { isJson, ok, printJson, UsageError, type GlobalOptions } from "../output.js";

export interface LoginOptions extends GlobalOptions {
  token?: string;
  verify?: boolean;
}

async function readToken(options: LoginOptions): Promise<string> {
  if (options.token && options.token.trim() !== "") return options.token.trim();
  if (!process.stdin.isTTY) {
    throw new UsageError("Pass the token with --token <token>, or set CORONIUM_API_TOKEN.");
  }
  const answer: { token?: string } = await prompts({ type: "password", name: "token", message: "Coronium API token:" });
  const token: string = String(answer.token ?? "").trim();
  if (token === "") throw new UsageError("No token entered.");
  return token;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const token: string = await readToken(options);
  let account: AccountInfo | null = null;
  if (options.verify !== false) {
    const client: Coronium = await makeClient({ requireToken: true, token });
    account = await client.account.get();
  }
  const config: CliConfig = await loadConfig();
  const path: string = await saveConfig({ ...config, api_key: token });
  if (isJson(options)) {
    printJson({ stored: true, verified: account !== null, account_id: account?._id ?? null, config_file: path });
    return;
  }
  ok(`Token stored in ${path} (mode 0600).`);
  if (account) console.log(`  Signed in as ${kleur.bold(account.login ?? account.name ?? account._id)}.`);
  if (options.token) console.log(kleur.dim("  Tip: a token passed on the command line can end up in shell history."));
}

export async function logoutCommand(options: GlobalOptions): Promise<void> {
  const config: CliConfig = await loadConfig();
  const path: string = await saveConfig({ ...config, api_key: undefined });
  if (isJson(options)) {
    printJson({ removed: true, config_file: path });
    return;
  }
  ok(`Token removed from ${path}.`);
  if (process.env.CORONIUM_API_TOKEN || process.env.CORONIUM_API_KEY) {
    console.log(kleur.yellow("  CORONIUM_API_TOKEN is still set in your environment."));
  }
}
