import kleur from "kleur";
import prompts from "prompts";
import { Coronium } from "coronium-sdk";
import { CONFIG_FILE, getBaseUrl, loadConfig, saveConfig } from "../config.js";

export async function initCommand(opts: { email?: string; apiKey?: string }): Promise<void> {
  const existing = await loadConfig();

  if (existing.api_key && !opts.apiKey) {
    console.log(kleur.yellow("Already initialized.") + ` Config at ${CONFIG_FILE}`);
    console.log(`Run ${kleur.bold("coronium balance")} to verify.`);
    return;
  }

  if (opts.apiKey) {
    await saveConfig({ ...existing, api_key: opts.apiKey });
    console.log(kleur.green("✓") + ` API key stored at ${CONFIG_FILE}`);
    return;
  }

  const { email } =
    opts.email !== undefined
      ? { email: opts.email }
      : await prompts({
          type: "text",
          name: "email",
          message: "Email (optional, for receipts only):",
          initial: "",
        });

  const c = new Coronium({ apiKey: "bootstrap", baseUrl: getBaseUrl(existing) });
  // /account/create is unauthenticated; the SDK skips the bearer header for it.
  const created = await c.account.create({ email: email || undefined });

  await saveConfig({
    ...existing,
    api_key: created.api_key,
    email: email || existing.email,
  });

  console.log(kleur.green("✓") + ` Account created: ${kleur.bold(created.account_id)}`);
  console.log(`  ${kleur.dim("api key       ")} ${created.api_key}  ${kleur.yellow("(stored, shown once)")}`);
  console.log(`  ${kleur.dim("USDC deposit  ")} ${created.deposit_address_usdc_base} ${kleur.dim("(Base)")}`);
  console.log(`  ${kleur.dim("trial credit  ")} $${created.balance_usd.toFixed(2)}`);
  console.log(`  ${kleur.dim("daily cap     ")} $${created.daily_spend_cap_usd.toFixed(2)}`);
  console.log("");
  console.log(`Try: ${kleur.bold("coronium proxy get --country US --type 5g")}`);
}
