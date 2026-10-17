import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Coronium, CoroniumError, normalizeBaseUrl } from "../src/index.js";
import { Transport } from "../src/transport.js";
import type { RouteSpec } from "../src/routes.js";
import { FIXTURE_TOKEN, installCatalog, startFixtureServer, type FixtureServer } from "./support/fixture-server.js";

// A route the real router does not have, used to reproduce the redirect trap.
const MISSING_ROUTE: RouteSpec = { method: "GET", path: "/balance", auth: "bearer", mutates: false, spends: false };
const MISSING_MUTATION: RouteSpec = { method: "POST", path: "/proxies", auth: "bearer", mutates: true, spends: false };

let server: FixtureServer;

function transport(token: string | undefined = FIXTURE_TOKEN): Transport {
  return new Transport({
    baseUrl: server.baseUrl,
    token,
    fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
    timeoutMs: 5_000,
    userAgent: undefined,
  });
}

async function captureError(promise: Promise<unknown>): Promise<CoroniumError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoroniumError) return error;
    throw error;
  }
  throw new Error("expected a CoroniumError");
}

beforeEach(async () => {
  server = await startFixtureServer();
  installCatalog(server);
});

afterEach(async () => {
  await server.close();
});

describe("transport", () => {
  it("turns the 302 for a missing route into route_not_found instead of returning the HTML page", async () => {
    const error: CoroniumError = await captureError(transport().call(MISSING_ROUTE));
    expect(error.code).toBe("route_not_found");
    expect(error.status).toBe(302);
    expect(error.outcome).toBe("rejected");
    // The redirect was not followed: the only request is the original one.
    expect(server.requests.map((request) => request.path)).toEqual(["/balance"]);
  });

  it("does not follow the redirect for a POST either (no request to /)", async () => {
    const error: CoroniumError = await captureError(transport().call(MISSING_MUTATION, { body: {} }));
    expect(error.code).toBe("route_not_found");
    expect(server.requests).toHaveLength(1);
  });

  it("rejects an HTML 200 as invalid_response", async () => {
    server.on("GET /account", () => ({ text: "<h1>API Server</h1>", contentType: "text/html" }));
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    const error: CoroniumError = await captureError(client.account.get());
    expect(error.code).toBe("invalid_response");
  });

  it("rejects an empty 200 on a mutation with outcome unknown", async () => {
    server.on("POST /modems/:modem_id/replace", () => ({ status: 200 }));
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    const error: CoroniumError = await captureError(client.proxies.replace("abc"));
    expect(error.code).toBe("invalid_response");
    expect(error.outcome).toBe("unknown");
  });

  it("reads the message from `error` and keeps the lowercase code", async () => {
    const error: CoroniumError = await captureError(transport("wrong-token").call({ ...MISSING_ROUTE, path: "/account" }));
    expect(error.status).toBe(401);
    expect(error.code).toBe("auth_required");
    expect(error.message).toBe("No auth token");
  });

  it("marks a mutation 5xx as outcome unknown and suggests checking state", async () => {
    server.on("POST /modems/:modem_id/replace", () => ({ status: 500, body: { error: "Replacement failed" } }));
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    const error: CoroniumError = await captureError(client.proxies.replace("abc"));
    expect(error.outcome).toBe("unknown");
    expect(error.suggestedAction).toBe("check_state_before_retrying");
    expect(server.requests).toHaveLength(1);
  });

  it("never retries a failed request", async () => {
    let hits: number = 0;
    server.on("GET /account", () => {
      hits += 1;
      return { status: 503, body: { error: "busy" } };
    });
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    await captureError(client.account.get());
    expect(hits).toBe(1);
  });

  it("classifies 429 by status and reads Retry-After from the header", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({
      status: 429,
      headers: { "Retry-After": "42" },
      body: { error: "The last rotation failed", code: "modem_rotation_in_progress" },
    }));
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    const error: CoroniumError = await captureError(client.proxies.rotate("abc"));
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.outcome).toBe("rejected");
  });

  it("reads retry_after_seconds from the body when there is no header", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({
      status: 429,
      body: { error: "Please wait", code: "internal_error", retry_after_seconds: 17 },
    }));
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    const error: CoroniumError = await captureError(client.proxies.rotate("abc"));
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBe(17);
  });

  it("sends the token only as a Bearer header", async () => {
    server.on("GET /account", () => ({ body: { _id: "u1", accountCredit: 5 } }));
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    await client.account.get();
    const request = server.requests[0];
    expect(request?.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(request?.url).not.toContain(FIXTURE_TOKEN);
  });

  it("does not send the token to public routes", async () => {
    const client: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    await client.catalog.countries();
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("refuses a bearer call without a token before any request", async () => {
    const client: Coronium = new Coronium({ baseUrl: server.baseUrl });
    const error: CoroniumError = await captureError(client.account.get());
    expect(error.code).toBe("not_authenticated");
    expect(server.requests).toHaveLength(0);
  });

  it("reports a timeout on a mutation as outcome unknown", async () => {
    const hanging: Coronium = new Coronium({
      token: FIXTURE_TOKEN,
      baseUrl: server.baseUrl,
      actionTimeoutMs: 50,
      fetch: (_input: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject: (reason: unknown) => void): void => {
          init.signal?.addEventListener("abort", (): void => reject(init.signal?.reason));
        }),
    });
    const error: CoroniumError = await captureError(hanging.proxies.replace("abc"));
    expect(error.code).toBe("timeout");
    expect(error.outcome).toBe("unknown");
  });

  it("sends a versioned User-Agent", async () => {
    const client: Coronium = new Coronium({ baseUrl: server.baseUrl });
    await client.catalog.countries();
    expect(String(server.requests[0]?.headers["user-agent"])).toMatch(/^coronium-sdk\/1\.0\.0/);
  });
});

describe("base URL", () => {
  it("defaults to the production v3 API", () => {
    expect(new Coronium().baseUrl).toBe("https://api.coronium.io/api/v3");
  });

  it("allows http only on loopback", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8787/api/v3/")).toBe("http://127.0.0.1:8787/api/v3");
    expect(() => normalizeBaseUrl("http://api.example.com/api/v3")).toThrow(/https/);
  });

  it("rejects credentials, query strings and fragments", () => {
    expect(() => normalizeBaseUrl("https://user:pass@api.coronium.io/api/v3")).toThrow(/credentials/);
    expect(() => normalizeBaseUrl("https://api.coronium.io/api/v3?x=1")).toThrow(/query/);
    expect(() => normalizeBaseUrl("https://api.coronium.io/api/v3#a")).toThrow(/fragment/);
  });
});
