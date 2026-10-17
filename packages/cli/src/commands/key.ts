import kleur from "kleur";
import type { WalletRotateResult } from "coronium-sdk";
import { getApiToken, loadConfig, saveConfig, type CliConfig } from "../config.js";
import { isJson, printJson, UsageError, type GlobalOptions } from "../output.js";
import { loadWallet, WALLET_FILE, type StoredWallet } from "../wallet.js";
import { rotateWithWallet } from "./init.js";

export async function keyRotateCommand(options: GlobalOptions): Promise<void> {
  const stored: StoredWallet | undefined = await loadWallet();
  if (!stored) {
    throw new UsageError(`No wallet found at ${WALLET_FILE}.`, ["Import one first: coronium init --restore"]);
  }
  const config: CliConfig = await loadConfig();
  const token: string | undefined = getApiToken(config);
  if (!token) throw new UsageError("No API token found. Run coronium init first.");
  const result: WalletRotateResult = await rotateWithWallet(stored, token);
  await saveConfig({ ...config, api_key: result.api_token });
  if (isJson(options)) {
    printJson({ rotated: true, wallet_address: stored.address });
    return;
  }
  console.log(`${kleur.green("✓")} New API token issued and stored.`);
  console.log(kleur.dim("  Earlier tokens are not revoked by this command; they stay valid until they expire."));
}
