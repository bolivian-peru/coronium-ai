import { Coronium } from "coronium-sdk";
import kleur from "kleur";
import { getApiKey, getBaseUrl, loadConfig } from "./config.js";

export async function makeClient(): Promise<Coronium> {
  const cfg = await loadConfig();
  const apiKey = getApiKey(cfg);
  if (!apiKey) {
    console.error(
      kleur.red("No API key configured.") +
        "\n  Run " +
        kleur.bold("coronium init") +
        " to create one, or set " +
        kleur.bold("CORONIUM_API_KEY") +
        " in your environment.",
    );
    process.exit(2);
  }
  return new Coronium({
    apiKey,
    baseUrl: getBaseUrl(cfg),
    userAgent: `coronium-cli/0.1.0`,
  });
}
