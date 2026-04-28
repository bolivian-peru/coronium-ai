// End-to-end tests for the production API. Boots the real Fastify app
// against an in-process mock of cor-api-v1, walks the entire 7-verb hero
// path, and exercises auth + spend caps + error mapping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUpstreamMock } from "./upstream-mock.js";

// Set env BEFORE importing the app — config.ts reads at import time.
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";
process.env.UPSTREAM_API_TOKEN = "test-token";

let mock: Awaited<ReturnType<typeof startUpstreamMock>>;
let app: Awaited<ReturnType<typeof import("../src/server.js")["buildApp"]>>;
let apiKey: string;

beforeAll(async () => {
  mock = await startUpstreamMock();
  process.env.UPSTREAM_API_URL = mock.url;
  // Reset the cached config so it picks up the mock URL.
  const cfg = await import("../src/config.js");
  // @ts-ignore
  cfg.config.UPSTREAM_API_URL = mock.url;
  // @ts-ignore
  cfg.config.UPSTREAM_API_TOKEN = "test-token";

  const { buildApp } = await import("../src/server.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mock.close();
});

async function inject(opts: any) {
  return app.inject(opts);
}

describe("coronium-api", () => {
  it("GET /health → 200", async () => {
    const r = await inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ ok: true, name: "coronium-api" });
  });

  it("POST /v1/account/create → 201, returns sk_live_… key", async () => {
    const r = await inject({
      method: "POST",
      url: "/v1/account/create",
      payload: { email: "alex@example.com" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.account_id).toMatch(/^acc_/);
    expect(body.api_key).toMatch(/^sk_live_/);
    expect(body.deposit_address_usdc_base).toMatch(/^0x[a-f0-9]{40}$/);
    expect(body.daily_spend_cap_usd).toBe(50);
    apiKey = body.api_key;
  });

  it("GET /v1/balance with valid key → 200", async () => {
    const r = await inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      active_proxies: 0,
      daily_cap_usd: 50,
      session_cap_usd: 5,
    });
  });

  it("GET /v1/balance without key → 401 INVALID/MISSING_KEY", async () => {
    const r = await inject({ method: "GET", url: "/v1/balance" });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toMatch(/MISSING_KEY|INVALID_KEY/);
  });

  it("GET /v1/balance with wrong key → 401 INVALID_KEY", async () => {
    const r = await inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: "Bearer sk_live_definitely_not_real" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("INVALID_KEY");
  });

  it("GET /v1/tariffs?country=US → list", async () => {
    const r = await inject({
      method: "GET",
      url: "/v1/tariffs?country=US",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(r.statusCode).toBe(200);
    const list = r.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((t: any) => t.country === "US")).toBe(true);
  });

  it("POST /v1/proxies → 201 with proxy credentials", async () => {
    const r = await inject({
      method: "POST",
      url: "/v1/proxies",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      payload: { country: "US", type: "5g" },
    });
    expect(r.statusCode).toBe(201);
    const list = r.json();
    expect(list).toHaveLength(1);
    const p = list[0];
    expect(p.id).toMatch(/^px_/);
    expect(p.username).toBeTruthy();
    expect(p.password).toBeTruthy();
  });

  it("POST /v1/proxies with X-Cost-Cap-Cents=1 + qty=10 → 402 SPEND_CAP_EXCEEDED", async () => {
    const r = await inject({
      method: "POST",
      url: "/v1/proxies",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-cost-cap-cents": "1",
      },
      payload: { country: "US", qty: 10 },
    });
    expect(r.statusCode).toBe(402);
    expect(r.json().code).toBe("SPEND_CAP_EXCEEDED");
  });

  it("POST /v1/proxies with country=ZZ → 409 STOCK_OUT with suggestions", async () => {
    const r = await inject({
      method: "POST",
      url: "/v1/proxies",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { country: "ZZ" },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.code).toBe("STOCK_OUT");
    expect(body.suggestion?.available_now?.length).toBeGreaterThan(0);
  });

  it("rotate + release lifecycle", async () => {
    const buy = await inject({
      method: "POST",
      url: "/v1/proxies",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { country: "DE", type: "4g" },
    });
    const id = buy.json()[0].id;

    const rot = await inject({
      method: "POST",
      url: `/v1/proxies/${id}/rotate`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(rot.statusCode).toBe(200);
    expect(rot.json().ip_after).not.toBe(rot.json().ip_before);

    const rel = await inject({
      method: "DELETE",
      url: `/v1/proxies/${id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(rel.statusCode).toBe(204);
  });

  it("404 on unknown route returns stable code", async () => {
    const r = await inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("NOT_FOUND");
  });
});
