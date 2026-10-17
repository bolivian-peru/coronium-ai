// Loopback replica of /api/v3 for behaviour tests. It serves only the routes in
// test/fixtures/v3-routes.json and reproduces how production answers everything
// else:
//
// - no token on a bearer route: 401 {code:"auth_required"};
// - a valid token on a path the router does not have: 302 -> "/", and "/" is an
//   HTML page with status 200 (the trap that made 0.x clients print fake results).
//
// Tests register per-route handlers; every request is recorded.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

export const FIXTURE_TOKEN: string = "fixture-token";

export interface FixtureRequest {
  method: string;
  path: string;
  url: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FixtureReply {
  status?: number;
  body?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type FixtureHandler = (request: FixtureRequest) => FixtureReply;

interface RouteEntry {
  method: string;
  path: string;
  auth: "public" | "bearer";
}

interface CompiledRoute extends RouteEntry {
  key: string;
  pattern: RegExp;
  names: string[];
}

export interface FixtureServer {
  baseUrl: string;
  requests: FixtureRequest[];
  /** Register a handler by "METHOD /path" as written in v3-routes.json, without the /api/v3 prefix. */
  on(key: string, handler: FixtureHandler): void;
  close(): Promise<void>;
}

const BASE_PATH: string = "/api/v3";
const HTML_HOME: string = "<h1>API Server</h1>";

export function loadRouteFixture(): { routes: RouteEntry[] } {
  const url: URL = new URL("../fixtures/v3-routes.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as { routes: RouteEntry[] };
}

export function loadCatalogSample(): Record<string, unknown[]> {
  const url: URL = new URL("../fixtures/catalog-sample.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown[]>;
}

function compile(route: RouteEntry): CompiledRoute {
  const relative: string = route.path.slice(BASE_PATH.length);
  const names: string[] = [];
  const source: string = relative.replace(/:([A-Za-z_]+)/g, (_match: string, name: string): string => {
    names.push(name);
    return "([^/]+)";
  });
  return { ...route, key: `${route.method} ${relative}`, pattern: new RegExp(`^${source}$`), names };
}

function findRoute(routes: CompiledRoute[], method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match: RegExpMatchArray | null = path.match(route.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name: string, index: number): void => {
      params[name] = decodeURIComponent(match[index + 1] ?? "");
    });
    return { route, params };
  }
  return null;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text: string = Buffer.concat(chunks).toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header: string | undefined = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function sendReply(response: ServerResponse, reply: FixtureReply): void {
  const status: number = reply.status ?? 200;
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let payload: string = "";
  if (reply.text !== undefined) {
    headers["Content-Type"] = reply.contentType ?? "text/plain";
    payload = reply.text;
  } else if (reply.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(reply.body);
  }
  response.writeHead(status, headers);
  response.end(payload);
}

function unauthenticated(): FixtureReply {
  return { status: 401, body: { error: "No auth token", code: "auth_required", suggested_action: "authenticate", retryable: false } };
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes: CompiledRoute[] = loadRouteFixture().routes.map(compile);
  const handlers: Map<string, FixtureHandler> = new Map();
  const requests: FixtureRequest[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url: URL = new URL(request.url ?? "/", "http://127.0.0.1");
    const method: string = request.method ?? "GET";
    const body: unknown = await readBody(request);
    if (url.pathname === "/" && method === "GET") {
      sendReply(response, { text: HTML_HOME, contentType: "text/html" });
      return;
    }
    const relative: string = url.pathname.slice(BASE_PATH.length);
    const found = url.pathname.startsWith(BASE_PATH) ? findRoute(routes, method, relative) : null;
    const record: FixtureRequest = {
      method,
      path: relative,
      url: request.url ?? "",
      params: found?.params ?? {},
      query: url.searchParams,
      headers: request.headers,
      body,
    };
    requests.push(record);
    const token: string | undefined = bearerToken(request);
    const isPublic: boolean = found?.route.auth === "public";
    if (!isPublic && token !== FIXTURE_TOKEN) {
      sendReply(response, unauthenticated());
      return;
    }
    if (!found) {
      // Production falls through to the app's catch-all redirect.
      sendReply(response, { status: 302, headers: { Location: "/" } });
      return;
    }
    const handler: FixtureHandler | undefined = handlers.get(found.route.key);
    if (!handler) {
      sendReply(response, { status: 501, body: { error: `fixture has no handler for ${found.route.key}` } });
      return;
    }
    sendReply(response, handler(record));
  }

  await new Promise<void>((resolve: () => void): void => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}${BASE_PATH}`,
    requests,
    on(key: string, handler: FixtureHandler): void {
      if (!routes.some((route: CompiledRoute): boolean => route.key === key)) {
        throw new Error(`"${key}" is not a route in v3-routes.json`);
      }
      handlers.set(key, handler);
    },
    close(): Promise<void> {
      return new Promise<void>((resolve: () => void): void => {
        server.close((): void => resolve());
      });
    },
  };
}

/** Handlers that answer like production for the public catalog. */
export function installCatalog(server: FixtureServer): void {
  const sample: Record<string, unknown[]> = loadCatalogSample();
  server.on("GET /countries", (): FixtureReply => ({ body: { data: sample.countries } }));
  server.on("GET /tariffs", (): FixtureReply => ({ body: { data: sample.availableTariffs } }));
  server.on("GET /tariffs/available", (): FixtureReply => ({ body: { data: sample.availableTariffs, _cached: true, _ageMs: 1200 } }));
  server.on("GET /free-modems", (): FixtureReply => ({ body: { data: sample.stock } }));
}

export const SAMPLE_PROXY = {
  _id: "6512aa000000000000000001",
  name: "us_tmobile_01",
  portId: "cor_US_0001",
  country_id: "60b292a86f46de4a880f89d3",
  carrier_id: "673c2ac3724c63eb0711be88",
  isOnline: true,
  ext_ip: "172.58.10.20",
  connection_ip: "198.51.100.7",
  ip_address: "198.51.100.7",
  http_port: "8001",
  socks_port: "9001",
  proxy_login: "user01",
  proxy_password: "p@ss word",
  rotation_interval: 0,
  tariff_expired_at: 1_900_000_000_000,
};

export const SAMPLE_SPLIT_PROXY = {
  _id: "6512aa000000000000000002",
  name: "us_split_02",
  connection_ip: "203.0.113.9",
  http_port: "7001",
  socks_port: "7002",
  proxy_login: "http-user",
  proxy_password: "http-pass",
  proxyEndpoints: {
    provider: "pocketproxy",
    http: { host: "203.0.113.9", port: 7001, username: "http-user", password: "http-pass" },
    socks5: { host: "203.0.113.9", port: 7002, username: "socks-user", password: "socks-pass" },
  },
};
