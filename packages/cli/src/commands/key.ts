import kleur from "kleur";
import { loadConfig, getApiKey, saveConfig } from "../config.js";
import { accountFromStored, loadWallet, WALLET_FILE } from "../wallet.js";
import { api } from "../api.js";

export async function keyRotateCommand(_opts: { json?: boolean }): Promise<void> {
  const stored = await loadWallet();
  if (!stored) {
    console.error(kleur.red(`No wallet found at ${WALLET_FILE}.`));
    console.error(`Run ${kleur.bold("coronium init --restore")} to import a wallet first.`);
    process.exit(2);
  }
  const cfg = await loadConfig();
  const apiKey = getApiKey(cfg);
  if (!apiKey) {
    console.error(kleur.red(`No API key found. Run ${kleur.bold("coronium init")} first.`));
    process.exit(2);
  }

  const account = accountFromStored(stored);
  const challenge = await api.rotateChallenge({ wallet_address: stored.address, api_key: apiKey });
  const signature = await account.signMessage({ message: challenge.siwe_message });
  const result = await api.rotate({ siwe_message: challenge.siwe_message, signature, wallet_address: stored.address, api_key: apiKey });

  await saveConfig({ ...cfg, api_key: result.api_key });

  console.log(kleur.green("✓") + ` New API key issued. Old keys revoked.`);
  console.log(`  ${kleur.dim("api key ")} ${result.api_key}`);
}
