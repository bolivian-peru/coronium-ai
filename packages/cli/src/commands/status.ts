// `coronium status`: is it me or the API? Checks a public catalog route, then
// the token, and reports a route mismatch instead of a false green.

import kleur from "kleur";
import { CONTRACT_ID, CoroniumError, type Coronium } from "coronium-sdk";
import { makeClient } from "../client.js";
import { getApiToken, isSpendingAllowed, loadConfig, type CliConfig } from "../config.js";
import { EXIT_REJECTED, ExitWith, isJson, printJson, type GlobalOptions } from "../output.js";
import { CLI_VERSION } from "../version.js";
import { loadWallet, type StoredWallet } from "../wallet.js";

type Check = { ok: boolean; detail: string };

function describeFailure(error: unknown): string {
  if (error instanceof CoroniumError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function checkApi(client: Coronium): Promise<Check> {
  const started: number = Date.now();
  try {
    const countries = await client.catalog.countries();
    return { ok: countries.length > 0, detail: `${countries.length} countries in ${Date.now() - started} ms` };
  } catch (error) {
    return { ok: false, detail: describeFailure(error) };
  }
}

async function checkAuth(client: Coronium, hasToken: boolean): Promise<Check> {
  if (!hasToken) return { ok: false, detail: "no token configured" };
  try {
    const account = await client.account.get();
    return { ok: true, detail: `signed in as ${account.login ?? account.name ?? account._id}` };
  } catch (error) {
    return { ok: false, detail: describeFailure(error) };
  }
}

async function readWallet(): Promise<StoredWallet | undefined> {
  try {
    return await loadWallet({ noPrompt: true });
  } catch {
    return undefined;
  }
}

function mark(value: boolean): string {
  if (value) return kleur.green("✓");
  return kleur.red("✗");
}

export async function statusCommand(options: GlobalOptions): Promise<void> {
  const config: CliConfig = await loadConfig();
  const hasToken: boolean = Boolean(getApiToken(config));
  const client: Coronium = await makeClient({ requireToken: false });
  const api: Check = await checkApi(client);
  const auth: Check = await checkAuth(client, hasToken);
  const wallet: StoredWallet | undefined = await readWallet();
  const spending: boolean = isSpendingAllowed(config);

  if (isJson(options)) {
    printJson({
      cli_version: CLI_VERSION,
      contract: CONTRACT_ID,
      base_url: client.baseUrl,
      api,
      auth,
      token_configured: hasToken,
      wallet_address: wallet?.address ?? null,
      spending_enabled: spending,
    });
    failIfUnhealthy(api, auth, hasToken);
    return;
  }
  console.log(kleur.bold(`Coronium CLI ${CLI_VERSION}`) + kleur.dim(` (contract ${CONTRACT_ID})`));
  console.log("");
  console.log(`  ${kleur.dim("base url ")} ${client.baseUrl}`);
  console.log(`  ${kleur.dim("api      ")} ${mark(api.ok)} ${api.detail}`);
  console.log(`  ${kleur.dim("token    ")} ${mark(auth.ok)} ${auth.detail}`);
  console.log(`  ${kleur.dim("wallet   ")} ${mark(Boolean(wallet))} ${wallet?.address ?? "not set (only needed for voucher sign-up)"}`);
  console.log(`  ${kleur.dim("spending ")} ${spending ? "on" : "off"}`);
  failIfUnhealthy(api, auth, hasToken);
}

// A broken API or a rejected token must never exit 0.
function failIfUnhealthy(api: Check, auth: Check, hasToken: boolean): void {
  if (!api.ok) throw new ExitWith(EXIT_REJECTED);
  if (hasToken && !auth.ok) throw new ExitWith(EXIT_REJECTED);
}
