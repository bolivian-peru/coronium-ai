// Route coverage: every HTTP call the SDK can make must exist on the real
// /api/v3 router. 0.x shipped 8 of 9 methods against routes that never existed;
// this test is what would have caught it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES, type RouteSpec } from "../src/routes.js";
import { loadRouteFixture } from "./support/fixture-server.js";

const BASE_PATH: string = "/api/v3";
const SRC_DIR: string = new URL("../src", import.meta.url).pathname;

// Parameter names differ between the SDK and the router (":id" vs ":modem_id");
// only the position of a parameter matters.
function routeKey(method: string, path: string): string {
  return `${method} ${path.replace(/:[A-Za-z_]+/g, ":param")}`;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full: string = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("route coverage against v3-routes.json", () => {
  const fixture = loadRouteFixture();
  const known: Map<string, string> = new Map(
    fixture.routes.map((route): [string, string] => [routeKey(route.method, route.path), route.auth]),
  );

  it("the fixture is the full 72-route contract", () => {
    expect(fixture.routes).toHaveLength(72);
  });

  for (const [name, spec] of Object.entries(ROUTES) as Array<[string, RouteSpec]>) {
    it(`${name}: ${spec.method} ${spec.path} exists with ${spec.auth} auth`, () => {
      const key: string = routeKey(spec.method, BASE_PATH + spec.path);
      expect(known.has(key), `${key} is not a real /api/v3 route`).toBe(true);
      expect(known.get(key)).toBe(spec.auth);
    });
  }

  it("every resource method calls through ROUTES (no inline paths)", () => {
    for (const file of sourceFiles(join(SRC_DIR, "resources"))) {
      const text: string = readFileSync(file, "utf8");
      const calls: RegExpMatchArray | null = text.match(/transport\.call<[^>]*>\(\s*([^,)\s]+)/g);
      for (const call of calls ?? []) {
        expect(call, `${file} must pass a ROUTES entry`).toMatch(/ROUTES\.|order\.route/);
      }
    }
  });

  it("only transport.ts and client.ts touch fetch, and no file puts a token in a URL", () => {
    for (const file of sourceFiles(SRC_DIR)) {
      const text: string = readFileSync(file, "utf8");
      const isTransportLayer: boolean = file.endsWith("transport.ts") || file.endsWith("client.ts");
      if (!isTransportLayer) expect(text, file).not.toMatch(/\bfetch\(/);
      expect(text, file).not.toContain("auth_token=");
    }
  });

  it("spending routes are exactly the four account-credit and BTC lanes", () => {
    const spending: string[] = Object.values(ROUTES as Record<string, RouteSpec>)
      .filter((spec: RouteSpec): boolean => spec.spends)
      .map((spec: RouteSpec): string => spec.path)
      .sort();
    expect(spending).toEqual([
      "/payment/buy-modems-with-crypto-balance",
      "/payment/buy-with-account-credit",
      "/payment/renew-modems-with-crypto-balance",
      "/payment/renew-with-account-credit",
    ]);
  });
});
