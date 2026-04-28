// End-to-end tests for the production API. Boots the real Fastify app
// against an in-process mock of cor-api-v1, walks the wallet-bound voucher
// signup, then the entire 7-verb hero path. Exercises auth + spend caps +
// SIWE failure modes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startUpstreamMock } from "./upstream-mock.js";

// Set env BEFORE importing the app — config.ts reads at import time.
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";
process.env.UPSTREAM_API_TOKEN = "test-token";

let mock: Awaited<ReturnType<typeof startUpstreamMock>>;
let app: Awaited<ReturnType<typeof import("../src/server.js")["buildApp"]>>;
let apiKey: string;
let walletAccount: ReturnType<typeof privateKeyToAccount>;

async function inject(opts: any) {
  return app.inject(opts);
}

async function mintVoucher(id: string, opts: { initial_credit_cents?: number } = {}) {
  const { db } = await import("../src/db/index.js");
  const { insertVoucher } = await import("../src/db/vouchers.js");
  insertVoucher({
    id,
    batch: "test-batch",
    campaign: null,
    affiliate_id: null,
    initial_credit_cents: opts.initial_credit_cents ?? 50,
    daily_cap_cents: null,
    session_cap_cents: null,
    expires_at: null,
    consumed_at: null,
    consumed_by_account_id: null,
    created_at: Date.now(),
    notes: null,
  });
  void db;
}

async function redeem(voucherId: string, account: ReturnType<typeof privateKeyToAccount>) {
  // Step 1: ask for challenge
  const c = await inject({
    method: "POST",
    url: "/v1/account/redeem-challenge",
    payload: { voucher: voucherId, wallet_address: account.address },
  });
  if (c.statusCode !== 200) return c;
  const { siwe_message } = c.json();

  // Step 2: sign and redeem
  const signature = await account.signMessage({ message: siwe_message });
  return inject({
    method: "POST",
    url: "/v1/account/redeem",
    payload: { siwe_message, signature },
  });
}

beforeAll(async () => {
  mock = await startUpstreamMock();
  process.env.UPSTREAM_API_URL = mock.url;
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

describe("coronium-api — health", () => {
  it("GET /health → 200", async () => {
    const r = await inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, name: "coronium-api" });
  });
});

describe("coronium-api — wallet-bound voucher signup", () => {
  it("redeem flow: voucher + SIWE → 201 with sk_live_… key", async () => {
    await mintVoucher("cor_v1_test_alpha_001");
    walletAccount = privateKeyToAccount(generatePrivateKey());
    const r = await redeem("cor_v1_test_alpha_001", walletAccount);
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.account_id).toMatch(/^acc_/);
    expect(body.api_key).toMatch(/^sk_live_/);
    expect(body.wallet_address).toBe(walletAccount.address.toLowerCase());
    expect(body.wallet_chain).toBe("evm");
    expect(body.balance_usd).toBe(0.5);
    expect(body.daily_spend_cap_usd).toBe(50);
    expect(body.deposit_addresses.evm_native).toBe(walletAccount.address.toLowerCase());
    apiKey = body.api_key;
  });

  it("redeem-challenge → 404 VOUCHER_NOT_FOUND for unknown voucher", async () => {
    const acc = privateKeyToAccount(generatePrivateKey());
    const r = await inject({
      method: "POST",
      url: "/v1/account/redeem-challenge",
      payload: { voucher: "cor_v1_does_not_exist", wallet_address: acc.address },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("VOUCHER_NOT_FOUND");
  });

  it("redeem-challenge → 400 INVALID_REQUEST for malformed wallet", async () => {
    await mintVoucher("cor_v1_test_alpha_002");
    const r = await inject({
      method: "POST",
      url: "/v1/account/redeem-challenge",
      payload: { voucher: "cor_v1_test_alpha_002", wallet_address: "not-a-wallet" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("INVALID_REQUEST");
  });

  it("redeem → 409 VOUCHER_CONSUMED on second redeem of same voucher", async () => {
    await mintVoucher("cor_v1_test_alpha_003");
    const acc1 = privateKeyToAccount(generatePrivateKey());
    const r1 = await redeem("cor_v1_test_alpha_003", acc1);
    expect(r1.statusCode).toBe(201);
    const acc2 = privateKeyToAccount(generatePrivateKey());
    const r2 = await redeem("cor_v1_test_alpha_003", acc2);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe("VOUCHER_CONSUMED");
  });

  it("redeem → 400 SIWE_INVALID_SIGNATURE when signed by wrong wallet", async () => {
    await mintVoucher("cor_v1_test_alpha_004");
    const stated = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());

    const c = await inject({
      method: "POST",
      url: "/v1/account/redeem-challenge",
      payload: { voucher: "cor_v1_test_alpha_004", wallet_address: stated.address },
    });
    expect(c.statusCode).toBe(200);
    const { siwe_message } = c.json();

    // Attacker signs the same message — signature won't recover to `stated`.
    const sig = await attacker.signMessage({ message: siwe_message });
    const r = await inject({
      method: "POST",
      url: "/v1/account/redeem",
      payload: { siwe_message, signature: sig },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("SIWE_INVALID_SIGNATURE");
  });

  it("redeem → 409 WALLET_ALREADY_REGISTERED when same wallet redeems twice", async () => {
    await mintVoucher("cor_v1_test_alpha_005");
    const r = await inject({
      method: "POST",
      url: "/v1/account/redeem-challenge",
      payload: { voucher: "cor_v1_test_alpha_005", wallet_address: walletAccount.address },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("WALLET_ALREADY_REGISTERED");
  });
});

describe("coronium-api — key rotation via SIWE", () => {
  it("rotates the API key when wallet signs the rotate challenge", async () => {
    const c = await inject({
      method: "POST",
      url: "/v1/account/key/rotate-challenge",
      payload: { wallet_address: walletAccount.address },
    });
    expect(c.statusCode).toBe(200);
    const { siwe_message } = c.json();

    const sig = await walletAccount.signMessage({ message: siwe_message });
    const r = await inject({
      method: "POST",
      url: "/v1/account/key/rotate",
      payload: { siwe_message, signature: sig },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.api_key).toMatch(/^sk_live_/);
    expect(body.api_key).not.toBe(apiKey);

    // Old key now revoked.
    const old = await inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(old.statusCode).toBe(401);

    apiKey = body.api_key;

    // New key works.
    const fresh = await inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(fresh.statusCode).toBe(200);
  });
});

describe("coronium-api — auth required surfaces", () => {
  it("GET /v1/balance with valid key → 200", async () => {
    const r = await inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ daily_cap_usd: 50, session_cap_usd: 5 });
  });

  it("GET /v1/balance without key → 401", async () => {
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

  it("GET /v1/tariffs?country=US → filtered list", async () => {
    const r = await inject({
      method: "GET",
      url: "/v1/tariffs?country=US",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().every((t: any) => t.country === "US")).toBe(true);
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
    expect(list[0].id).toMatch(/^px_/);
  });

  it("POST /v1/proxies with X-Cost-Cap-Cents=1 + qty=10 → 402 SPEND_CAP_EXCEEDED", async () => {
    const r = await inject({
      method: "POST",
      url: "/v1/proxies",
      headers: { authorization: `Bearer ${apiKey}`, "x-cost-cap-cents": "1" },
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
    expect(r.json().code).toBe("STOCK_OUT");
    expect(r.json().suggestion?.available_now?.length).toBeGreaterThan(0);
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
