import type { OwnedProxy, ProxyEndpoint } from "./types.js";

export type ProxyProtocol = "http" | "socks5";

export interface ConnectionUrls {
  http: string | null;
  socks5: string | null;
}

/** The host to connect to; providers fill different fields. */
export function proxyHost(proxy: OwnedProxy): string | null {
  const candidates: unknown[] = [proxy.connection_ip, proxy.ip_address, proxy.host];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

function validPort(port: unknown): number | null {
  const value: number = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return null;
  return value;
}

function bracketIpv6(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function endpointUrl(protocol: ProxyProtocol, endpoint: ProxyEndpoint): string | null {
  const port: number | null = validPort(endpoint.port);
  if (port === null || !endpoint.host || /[\s/@?#]/.test(endpoint.host)) return null;
  const user: string = encodeURIComponent(endpoint.username);
  const password: string = encodeURIComponent(endpoint.password);
  return `${protocol}://${user}:${password}@${bracketIpv6(endpoint.host)}:${port}`;
}

function legacyEndpoint(proxy: OwnedProxy, protocol: ProxyProtocol): ProxyEndpoint | null {
  const host: string | null = proxyHost(proxy);
  if (host === null) return null;
  let port: string | number = proxy.socks_port;
  if (protocol === "http") port = proxy.http_port;
  return { host, port, username: proxy.proxy_login, password: proxy.proxy_password };
}

function urlFor(proxy: OwnedProxy, protocol: ProxyProtocol): string | null {
  // Some providers issue different logins per protocol; prefer those when present.
  const separate: ProxyEndpoint | undefined = proxy.proxyEndpoints?.[protocol];
  const endpoint: ProxyEndpoint | null = separate ?? legacyEndpoint(proxy, protocol);
  if (endpoint === null) return null;
  return endpointUrl(protocol, endpoint);
}

/** Ready-to-use HTTP and SOCKS5 URLs. Listing a URL does not prove it connects. */
export function connectionUrls(proxy: OwnedProxy): ConnectionUrls {
  return { http: urlFor(proxy, "http"), socks5: urlFor(proxy, "socks5") };
}
