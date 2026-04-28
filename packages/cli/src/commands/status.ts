// `coronium status` — single-command health check. Useful for triaging
// "is it me or is it the API?" situations.

import kleur from "kleur";
import { loadConfig, getApiKey, getBaseUrl } from "../config.js";
import { loadWallet } from "../wallet.js";
import { isJsonMode, printJson } from "../format.js";

const DEFAULT_BASE = "https://api.coronium.ai/v1";

export async function statusCommand(opts: { json?: boolean }): Promise<void> {
  const cfg = await loadConfig();
  const apiKey = getApiKey(cfg);
  const baseUrl = (getBaseUrl(cfg) ?? DEFAULT_BASE).replace(/\/$/, "");
  const wallet = await loadWallet();

  const result = {
    config: {
      api_key: apiKey ? `${apiKey.slice(0, 16)}…(set)` : null,
      base_url: baseUrl,
      wallet_address: wallet?.address ?? null,
      wallet_chain: "evm",
      mnemonic_present: Boolean(wallet?.mnemonic),
    },
    backend: { health: "unknown" as "ok" | "down" | "unknown", latency_ms: 0 },
    auth: { ok: false, code: "" as string | undefined },
  };

  // Health check (unauth)
  const healthUrl = baseUrl.replace(/\/v1$/, "") + "/health";
  const t0 = Date.now();
  try {
    const r = await fetch(healthUrl);
    result.backend.health = r.ok ? "ok" : "down";
    result.backend.latency_ms = Date.now() - t0;
  } catch {
    result.backend.health = "down";
    result.backend.latency_ms = Date.now() - t0;
  }

  // Balance check (auth)
  if (apiKey && result.backend.health === "ok") {
    try {
      const r = await fetch(`${baseUrl}/balance`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (r.ok) {
        result.auth.ok = true;
      } else {
        const body = await r.json().catch(() => ({}));
        result.auth.code = (body as any).code ?? `HTTP_${r.status}`;
      }
    } catch (e: any) {
      result.auth.code = "NETWORK_ERROR";
    }
  }

  if (isJsonMode(opts)) return printJson(result);

  const ok = (b: boolean) => (b ? kleur.green("✓") : kleur.red("✗"));
  console.log(kleur.bold("Coronium status"));
  console.log("");
  console.log(`  ${kleur.dim("base url      ")} ${baseUrl}`);
  console.log(`  ${kleur.dim("backend       ")} ${ok(result.backend.health === "ok")} ${result.backend.health} (${result.backend.latency_ms}ms)`);
  console.log(`  ${kleur.dim("api key       ")} ${ok(Boolean(apiKey))} ${apiKey ? "configured" : "missing — run " + kleur.bold("coronium init")}`);
  if (apiKey) {
    console.log(`  ${kleur.dim("auth          ")} ${ok(result.auth.ok)} ${result.auth.ok ? "valid" : `failed: ${result.auth.code ?? "unknown"}`}`);
  }
  console.log(`  ${kleur.dim("wallet        ")} ${ok(Boolean(wallet))} ${wallet?.address ?? "not set"}`);
  console.log(`  ${kleur.dim("mnemonic file ")} ${ok(result.config.mnemonic_present)} ${result.config.mnemonic_present ? "stored" : "not stored (you may have noted it elsewhere)"}`);
  console.log("");

  if (result.backend.health !== "ok") {
    console.log(kleur.yellow("Backend is unreachable.") + " Check https://status.coronium.ai (when live) or your CORONIUM_BASE_URL env.");
  } else if (!apiKey) {
    console.log("Get started: " + kleur.bold("coronium init --voucher cor_v1_…") + "  (free voucher at https://coronium.ai/free)");
  } else if (!result.auth.ok) {
    console.log(kleur.yellow("API key rejected.") + " Try " + kleur.bold("coronium key:rotate") + " if you still have your wallet.");
  }
}
