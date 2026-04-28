import kleur from "kleur";
import type { ProxyType } from "@coronium/sdk-ts";
import { makeClient } from "../client.js";
import { isJsonMode, printJson } from "../format.js";

export async function tariffsCommand(opts: {
  json?: boolean;
  country?: string;
  carrier?: string;
  type?: ProxyType;
}): Promise<void> {
  const c = await makeClient();
  const list = await c.tariffs.list({
    country: opts.country,
    carrier: opts.carrier,
    type: opts.type,
  });
  if (isJsonMode(opts)) return printJson(list);
  if (list.length === 0) {
    console.log(kleur.yellow("No tariffs match those filters."));
    return;
  }
  for (const t of list) {
    const stock = t.in_stock ? kleur.green("in stock") : kleur.red("out");
    console.log(
      `${kleur.bold(t.country)} · ${t.carrier} · ${t.type}  $${t.price_usd}/${t.period_hours}h  ${stock}  ${kleur.dim(t.id)}`,
    );
  }
}
