import kleur from "kleur";
import type { ProxyType } from "coronium-sdk";
import { CoroniumStockOutError } from "coronium-sdk";
import { makeClient } from "../client.js";
import { isJsonMode, printJson, printProxy } from "../format.js";

export async function proxyGetCommand(opts: {
  json?: boolean;
  country: string;
  type?: ProxyType;
  carrier?: string;
  qty?: string;
  ttl?: string;
  rotation?: string;
  sticky?: boolean;
  costCapCents?: string;
}): Promise<void> {
  const c = await makeClient();
  try {
    const list = await c.proxies.buy(
      {
        country: opts.country,
        type: opts.type,
        carrier: opts.carrier,
        qty: opts.qty ? Number(opts.qty) : undefined,
        ttl: opts.ttl,
        rotation: opts.rotation,
        sticky: opts.sticky,
      },
      { costCapCents: opts.costCapCents ? Number(opts.costCapCents) : undefined },
    );
    if (isJsonMode(opts)) return printJson(list);
    for (const p of list) {
      printProxy(p);
      console.log("");
    }
  } catch (e) {
    if (e instanceof CoroniumStockOutError) {
      console.error(kleur.red("Out of stock") + ` for ${opts.country}${opts.carrier ? "/" + opts.carrier : ""}.`);
      if (e.suggestions.length) {
        console.error(kleur.dim("Try one of:"));
        for (const s of e.suggestions) {
          console.error(`  ${s.country} · ${s.carrier} · ${s.in_stock} in stock`);
        }
      }
      process.exit(3);
    }
    throw e;
  }
}

export async function proxyListCommand(opts: { json?: boolean }): Promise<void> {
  const c = await makeClient();
  const list = await c.proxies.list();
  if (isJsonMode(opts)) return printJson(list);
  if (list.length === 0) {
    console.log(kleur.dim("No active proxies. ") + kleur.bold("coronium proxy get --country US"));
    return;
  }
  for (const p of list) {
    console.log(
      `${kleur.bold(p.id)}  ${p.country} · ${p.carrier} · ${p.type}  ip=${p.ip}  expires=${p.expires_at}`,
    );
  }
}

export async function proxyRotateCommand(id: string, opts: { json?: boolean }): Promise<void> {
  const c = await makeClient();
  const r = await c.proxies.rotate(id);
  if (isJsonMode(opts)) return printJson(r);
  console.log(kleur.green("✓") + ` ${id}: ${r.ip_before} → ${kleur.bold(r.ip_after)} (${r.duration_ms} ms)`);
}

export async function proxyReplaceCommand(id: string, opts: { json?: boolean }): Promise<void> {
  const c = await makeClient();
  const p = await c.proxies.replace(id);
  if (isJsonMode(opts)) return printJson(p);
  console.log(kleur.green("✓") + ` Replaced. New proxy:`);
  printProxy(p);
}

export async function proxyReleaseCommand(id: string, opts: { json?: boolean }): Promise<void> {
  const c = await makeClient();
  await c.proxies.release(id);
  if (isJsonMode(opts)) return printJson({ id, released: true });
  console.log(kleur.green("✓") + ` Released ${id}`);
}
