import kleur from "kleur";
import { makeClient } from "../client.js";
import { isJsonMode, printJson } from "../format.js";

export async function balanceCommand(opts: { json?: boolean }): Promise<void> {
  const c = await makeClient();
  const b = await c.balance.get();
  if (isJsonMode(opts)) return printJson(b);
  console.log(`${kleur.bold("USDC")}            $${b.usdc}`);
  console.log(`${kleur.dim("hours at burn ")}  ${b.hours_at_current_burn}`);
  console.log(`${kleur.dim("active proxies")}  ${b.active_proxies}`);
  console.log(`${kleur.dim("today's spend ")}  $${b.spend_today_usd.toFixed(2)} / $${b.daily_cap_usd.toFixed(2)} daily cap`);
  console.log(`${kleur.dim("session cap   ")}  $${b.session_cap_usd.toFixed(2)}`);
}
