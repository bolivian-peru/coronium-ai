import kleur from "kleur";
import type { Chain } from "@coronium/sdk-ts";
import { makeClient } from "../client.js";
import { isJsonMode, printJson } from "../format.js";

export async function depositCommand(opts: {
  json?: boolean;
  chain?: Chain;
  amount?: string;
}): Promise<void> {
  const c = await makeClient();
  const amount = opts.amount ? Number(opts.amount) : undefined;
  const r = await c.deposit.address({
    chain: opts.chain ?? "base",
    amount_usd: amount,
  });
  if (isJsonMode(opts)) return printJson(r);
  console.log(kleur.green("✓") + ` Deposit address (${r.chain})`);
  console.log(`  ${kleur.bold(r.address)}`);
  if (r.amount_usd) console.log(`  ${kleur.dim("requested")}  $${r.amount_usd}`);
  console.log(`  ${kleur.dim("expires  ")}  ${r.expires_at}`);
  if (r.qr) console.log(`  ${kleur.dim("qr       ")}  data URL (${r.qr.length} bytes)`);
}
