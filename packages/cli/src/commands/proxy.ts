import { writeFile } from "node:fs/promises";
import kleur from "kleur";
import {
  connectionUrls,
  type ConnectionUrls,
  type Coronium,
  type OwnedProxy,
  type ProxyTestResult,
  type ReplaceResult,
  type RotationResult,
  type RotationStatus,
} from "coronium-sdk";
import { makeClient } from "../client.js";
import {
  EXIT_REJECTED,
  ExitWith,
  field,
  formatDate,
  isJson,
  ok,
  printJson,
  UsageError,
  warn,
  type GlobalOptions,
} from "../output.js";

export interface RotateOptions extends GlobalOptions {
  wait?: boolean;
}

export interface ConfirmOptions extends GlobalOptions {
  yes?: boolean;
}

export interface OpenVpnCommandOptions extends GlobalOptions {
  tcp?: boolean;
  out?: string;
}

function requireYes(options: ConfirmOptions, what: string): void {
  if (options.yes) return;
  throw new UsageError(`${what} Re-run with --yes to confirm.`);
}

async function ownedProxy(client: Coronium, identifier: string): Promise<OwnedProxy> {
  return client.proxies.get(identifier);
}

function printProxyRow(proxy: OwnedProxy): void {
  const urls: ConnectionUrls = connectionUrls(proxy);
  let online: string = kleur.red("offline");
  if (proxy.isOnline) online = kleur.green("online");
  console.log(`${kleur.bold(proxy.name)}  ${kleur.dim(proxy._id)}  ${online}`);
  field("http", urls.http);
  field("socks5", urls.socks5);
  field("exit ip", proxy.ext_ip);
  field("expires", formatDate(proxy.tariff_expired_at));
}

export async function proxyListCommand(options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const proxies: OwnedProxy[] = await client.proxies.list();
  if (isJson(options)) {
    printJson(proxies.map((proxy: OwnedProxy) => ({ ...proxy, urls: connectionUrls(proxy) })));
    return;
  }
  if (proxies.length === 0) {
    console.log("No proxies on this account. See plans with: coronium tariffs");
    return;
  }
  for (const proxy of proxies) {
    printProxyRow(proxy);
    console.log("");
  }
}

export async function proxyShowCommand(identifier: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  if (isJson(options)) {
    printJson({ ...proxy, urls: connectionUrls(proxy) });
    return;
  }
  printProxyRow(proxy);
  field("rotation every", proxy.rotation_interval ? `${proxy.rotation_interval} s` : "off");
}

function printRotation(name: string, result: RotationResult): void {
  if (result.state === "done") {
    ok(`${name}: new IP ${result.ip ?? "(not reported)"}`);
    return;
  }
  if (result.state === "rotating") {
    console.log(`${kleur.cyan("…")} ${name}: rotating. Check with: coronium proxy rotation-status ${name}`);
    return;
  }
  warn(`${name}: the rotation ran but the carrier kept the same IP (${result.ip ?? "unknown"}). Try again after a minute.`);
}

function printRotationStatus(name: string, status: RotationStatus): void {
  console.log(`${kleur.bold(name)} rotation: ${status.state}`);
  field("ip", status.ext_ip);
  if (status.reset_error) field("error", status.reset_error);
}

export async function proxyRotateCommand(identifier: string, options: RotateOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  const result: RotationResult = await client.proxies.rotate(proxy._id);
  let finalStatus: RotationStatus | null = null;
  if (result.state === "rotating" && options.wait) {
    finalStatus = await client.proxies.waitForRotation(proxy._id);
  }
  if (isJson(options)) {
    printJson({ state: result.state, result, final_status: finalStatus });
  } else {
    printRotation(proxy.name, result);
    if (finalStatus) printRotationStatus(proxy.name, finalStatus);
  }
  // A failed or unchanged rotation must not exit 0.
  if (result.state === "unchanged") throw new ExitWith(EXIT_REJECTED);
  if (finalStatus && finalStatus.state === "failed") throw new ExitWith(EXIT_REJECTED);
}

export async function proxyRotationStatusCommand(identifier: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  const status: RotationStatus = await client.proxies.rotationStatus(proxy._id);
  if (isJson(options)) {
    printJson(status);
    return;
  }
  printRotationStatus(proxy.name, status);
}

export async function proxyReplaceCommand(identifier: string, options: ConfirmOptions): Promise<void> {
  requireYes(options, "Replace swaps this proxy for another modem: new host, new credentials, and it uses one of your 2 replacements per 24 hours.");
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  const result: ReplaceResult = await client.proxies.replace(proxy._id);
  if (isJson(options)) {
    printJson(result);
    return;
  }
  ok(`Replaced ${proxy.name}. New proxy id: ${result.newModemId ?? "(not reported)"}`);
  if (result.newModem) {
    field("host", result.newModem.host);
    field("http port", result.newModem.http_port);
    field("socks port", result.newModem.socks_port);
    field("login", result.newModem.proxy_login);
    field("password", result.newModem.proxy_password);
  } else {
    console.log("  Run coronium proxy list to see the new credentials.");
  }
}

export async function proxyOpenVpnCommand(identifier: string, options: OpenVpnCommandOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  let proto: "tcp" | undefined;
  if (options.tcp) proto = "tcp";
  const profile: string = await client.proxies.openvpn(proxy._id, { proto });
  if (options.out) {
    await writeFile(options.out, profile, { mode: 0o600 });
    if (!isJson(options)) ok(`OpenVPN profile saved to ${options.out} (contains secrets).`);
    if (isJson(options)) printJson({ saved: options.out });
    return;
  }
  process.stdout.write(profile);
}

export async function proxyTestCommand(identifier: string, options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  const result: ProxyTestResult = await client.proxies.test(proxy._id);
  if (isJson(options)) {
    printJson(result);
  } else if (result.ok) {
    ok(`${proxy.name} answered. Exit IP ${result.extIp ?? "(not reported)"}`);
  } else {
    warn(`${proxy.name} failed the check: ${result.error ?? "no reason given"}`);
  }
  if (!result.ok) throw new ExitWith(EXIT_REJECTED);
}

export async function proxyWhitelistCommand(identifier: string, ips: string[], options: ConfirmOptions): Promise<void> {
  requireYes(options, "This replaces the proxy's whole IP whitelist (Coronium Node proxies only).");
  const client: Coronium = await makeClient({ requireToken: true });
  const proxy: OwnedProxy = await ownedProxy(client, identifier);
  const result = await client.proxies.setWhitelist(proxy._id, ips);
  if (isJson(options)) {
    printJson(result);
    return;
  }
  ok(`Whitelist for ${proxy.name} set to ${ips.length === 0 ? "empty" : ips.join(", ")}.`);
}

/** `proxy get` bought a proxy in 0.x. Refuse loudly instead of guessing. */
export function proxyGetRemoved(): never {
  throw new UsageError("`coronium proxy get` was removed in 1.0.", [
    "List plans: coronium tariffs --country US",
    "Then buy one: coronium buy --tariff <id> --count 1 --funding account_credit --max-total <usd> --yes",
    "To view a proxy you own: coronium proxy show <id>",
  ]);
}
