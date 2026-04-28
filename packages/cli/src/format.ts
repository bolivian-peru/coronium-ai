import kleur from "kleur";
import type { Proxy } from "coronium-sdk";

export function printProxy(p: Proxy): void {
  const httpUrl = `http://${p.username}:${p.password}@${p.host}:${p.port_http}`;
  const socksUrl = `socks5://${p.username}:${p.password}@${p.host}:${p.port_socks5}`;
  console.log(kleur.green("✓") + ` ${kleur.bold(p.id)}`);
  console.log(`  ${kleur.dim("country  ")} ${p.country}${p.region ? ` (${p.region})` : ""}`);
  console.log(`  ${kleur.dim("carrier  ")} ${p.carrier} · ${p.type}`);
  console.log(`  ${kleur.dim("ip       ")} ${p.ip}`);
  console.log(`  ${kleur.dim("http     ")} ${httpUrl}`);
  console.log(`  ${kleur.dim("socks5   ")} ${socksUrl}`);
  console.log(`  ${kleur.dim("rotation ")} ${p.rotation_policy}`);
  console.log(`  ${kleur.dim("expires  ")} ${p.expires_at}`);
  console.log(`  ${kleur.dim("price    ")} $${p.price_per_hour_usdc}/hour`);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json);
}
