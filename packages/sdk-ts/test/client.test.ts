import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Coronium, CoroniumError, CoroniumStockOutError } from "../src/index.js";
import { app } from "../../../apps/api/src/index.js";

let server: Server;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;

  // Bootstrap an account against the mock.
  const c = new Coronium({ apiKey: "bootstrap", baseUrl });
  const created = await c.account.create({ email: "test@example.com" });
  apiKey = created.api_key;
  expect(apiKey).toMatch(/^sk_live_/);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Coronium SDK", () => {
  it("constructs", () => {
    const c = new Coronium({ apiKey: "k", baseUrl });
    expect(c).toBeInstanceOf(Coronium);
  });

  it("rejects missing apiKey", () => {
    expect(() => new Coronium({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("creates account with trial credit and deposit address", async () => {
    const c = new Coronium({ apiKey: "bootstrap", baseUrl });
    const a = await c.account.create({ email: "alex@example.com" });
    expect(a.account_id).toMatch(/^acc_/);
    expect(a.api_key).toMatch(/^sk_live_/);
    expect(a.balance_usd).toBe(0.5);
    expect(a.daily_spend_cap_usd).toBe(50);
    expect(a.deposit_address_usdc_base).toMatch(/^0x[a-f0-9]{40}$/);
  });

  it("gets balance with auth", async () => {
    const c = new Coronium({ apiKey, baseUrl });
    const b = await c.balance.get();
    expect(b).toMatchObject({
      usdc: expect.any(String),
      active_proxies: expect.any(Number),
      daily_cap_usd: 50,
      session_cap_usd: 5,
    });
  });

  it("rejects unauthenticated balance", async () => {
    const c = new Coronium({ apiKey: "sk_live_invalid", baseUrl });
    await expect(c.balance.get()).rejects.toBeInstanceOf(CoroniumError);
    try {
      await c.balance.get();
    } catch (e) {
      expect((e as CoroniumError).code).toBe("INVALID_KEY");
      expect((e as CoroniumError).status).toBe(401);
    }
  });

  it("lists tariffs", async () => {
    const c = new Coronium({ apiKey, baseUrl });
    const list = await c.tariffs.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatchObject({
      country: expect.any(String),
      carrier: expect.any(String),
      type: expect.stringMatching(/^(4g|5g)$/),
      in_stock: expect.any(Boolean),
    });
  });

  it("filters tariffs by country", async () => {
    const c = new Coronium({ apiKey, baseUrl });
    const list = await c.tariffs.list({ country: "US" });
    expect(list.every((t) => t.country === "US")).toBe(true);
  });

  it("buys, lists, rotates, releases a proxy", async () => {
    const c = new Coronium({ apiKey, baseUrl });
    const [p] = await c.proxies.buy({ country: "US", type: "5g" });
    expect(p).toBeDefined();
    expect(p!.id).toMatch(/^px_/);
    expect(p!.country).toBe("US");
    expect(p!.host).toMatch(/coronium/);
    expect(p!.port_http).toBeGreaterThan(0);
    expect(p!.port_socks5).toBeGreaterThan(0);

    const list = await c.proxies.list();
    expect(list.find((x) => x.id === p!.id)).toBeDefined();

    // Rotate may throw CARRIER_NO_OP ~5% of the time; retry once.
    let rotated = false;
    for (let i = 0; i < 5 && !rotated; i++) {
      try {
        const r = await c.proxies.rotate(p!.id);
        expect(r.ip_after).not.toBe(r.ip_before);
        rotated = true;
      } catch (e) {
        if (!(e instanceof CoroniumError) || e.code !== "CARRIER_NO_OP") throw e;
      }
    }
    expect(rotated).toBe(true);

    await c.proxies.release(p!.id);
    const after = await c.proxies.list();
    expect(after.find((x) => x.id === p!.id)).toBeUndefined();
  });

  it("throws CoroniumStockOutError with suggestions on out-of-stock country", async () => {
    const c = new Coronium({ apiKey, baseUrl });
    const err = await c.proxies.buy({ country: "ZZ" }).catch((e) => e);
    expect(err).toBeInstanceOf(CoroniumStockOutError);
    expect((err as CoroniumStockOutError).code).toBe("STOCK_OUT");
    expect((err as CoroniumStockOutError).suggestions.length).toBeGreaterThan(0);
    expect((err as CoroniumStockOutError).suggestions[0]).toMatchObject({
      country: expect.any(String),
      in_stock: expect.any(Number),
    });
  });

  it("respects per-call cost cap", async () => {
    const c = new Coronium({ apiKey, baseUrl });
    const err = await c.proxies
      .buy({ country: "US", qty: 10 }, { costCapCents: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CoroniumError);
    expect((err as CoroniumError).code).toBe("SPEND_CAP_EXCEEDED");
  });
});
