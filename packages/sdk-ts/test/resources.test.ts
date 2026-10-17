import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionUrls, Coronium, CoroniumError, verifyWebhookSignature, type OwnedProxy } from "../src/index.js";
import {
  FIXTURE_TOKEN,
  installCatalog,
  SAMPLE_PROXY,
  SAMPLE_SPLIT_PROXY,
  startFixtureServer,
  type FixtureServer,
} from "./support/fixture-server.js";

let server: FixtureServer;
let client: Coronium;

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
  server.on("GET /account/proxies", () => ({ body: { data: [SAMPLE_PROXY, SAMPLE_SPLIT_PROXY] } }));
  client = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
});

afterEach(async () => {
  await server.close();
});

describe("account", () => {
  it("returns account credit and crypto balances", async () => {
    server.on("GET /account", () => ({
      body: { _id: "u1", name: "Ana", login: "ana", btc: { balance: 0.001 }, usdt: { balance: 3 }, accountCredit: 12.5, proxyCount: 2 },
    }));
    const account = await client.account.get();
    expect(account.accountCredit).toBe(12.5);
    expect(account.btc?.balance).toBe(0.001);
  });

  it("never reads a missing accountCredit as zero", async () => {
    server.on("GET /account", () => ({ body: { _id: "u1" } }));
    const error: CoroniumError = await captureError(client.account.get());
    expect(error.code).toBe("invalid_response");
  });

  it("returns the crypto balance array with deposit addresses", async () => {
    server.on("GET /account/crypto-balance", () => ({
      body: [
        { coin: "btc", balance: 0.0001, address: "bc1qexample" },
        { coin: "usdt", balance: 4, address: "TExample" },
        { coin: "account_credit", balance: 10 },
      ],
    }));
    const balances = await client.account.cryptoBalances();
    expect(balances.map((row) => row.coin)).toEqual(["btc", "usdt", "account_credit"]);
  });

  it("reads a payment status", async () => {
    server.on("GET /payments/:id/status", (request) => ({ body: { _id: request.params.id, status: "completed", isConfirmed: true } }));
    const payment = await client.account.payment("pay_1");
    expect(payment.status).toBe("completed");
  });
});

describe("catalog", () => {
  it("lists countries without a token", async () => {
    const anonymous: Coronium = new Coronium({ baseUrl: server.baseUrl });
    const countries = await anonymous.catalog.countries();
    expect(countries.map((row) => row.country_code).sort()).toEqual(["GB", "US"]);
  });

  it("filters available tariffs by country and carrier client-side", async () => {
    const us = await client.catalog.availableTariffs({ countryCode: "us" });
    expect(us.length).toBe(2);
    expect(us.every((row) => row.country_code === "US")).toBe(true);
    const three = await client.catalog.availableTariffs({ carrierName: "three" });
    expect(three.every((row) => row.carrier_name === "Three")).toBe(true);
  });

  it("resolves stock rows to country, carrier and region names", async () => {
    const stock = await client.catalog.stock({ countryCode: "GB" });
    expect(stock).toEqual([
      expect.objectContaining({ countryCode: "GB", carrierName: "Three", regionName: "North London", count: 10 }),
    ]);
  });

  it("quotes a renewal and sends modems with modem_id and days", async () => {
    server.on("POST /payment/renewal-quote", (request) => {
      const body = request.body as { modems: Array<{ modem_id: string; days: number }> };
      return {
        body: {
          currency: "USD",
          subtotal_usd: 49,
          discount_usd: 0,
          total_usd: 49,
          coupon: null,
          line_items: body.modems.map((row) => ({ ...row, line_total_usd: 49 })),
        },
      };
    });
    const quote = await client.catalog.renewalQuote([{ modemId: SAMPLE_PROXY._id, days: 7 }]);
    expect(quote.total_usd).toBe(49);
    expect(server.requests.at(-1)?.body).toEqual({ modems: [{ modem_id: SAMPLE_PROXY._id, days: 7 }] });
  });

  it("refuses a renewal quote that leaves a proxy out", async () => {
    server.on("POST /payment/renewal-quote", () => ({
      body: { currency: "USD", subtotal_usd: 49, discount_usd: 0, total_usd: 49, coupon: null, line_items: [] },
    }));
    const error: CoroniumError = await captureError(client.catalog.renewalQuote([{ modemId: "m1", days: 7 }]));
    expect(error.code).toBe("incomplete_renewal_quote");
  });

  it("validates renewal days before calling the API", async () => {
    const error: CoroniumError = await captureError(client.catalog.renewalQuote([{ modemId: "m1", days: 91 }]));
    expect(error.code).toBe("invalid_argument");
    expect(server.requests).toHaveLength(0);
  });
});

describe("proxies", () => {
  it("lists and finds proxies by id, name or port id", async () => {
    expect(await client.proxies.list()).toHaveLength(2);
    expect((await client.proxies.get("us_tmobile_01"))._id).toBe(SAMPLE_PROXY._id);
    expect((await client.proxies.get("cor_US_0001"))._id).toBe(SAMPLE_PROXY._id);
    const error: CoroniumError = await captureError(client.proxies.get("nope"));
    expect(error.code).toBe("proxy_not_found");
  });

  it("builds encoded connection URLs, preferring separate SOCKS5 credentials", () => {
    expect(connectionUrls(SAMPLE_PROXY as OwnedProxy)).toEqual({
      http: "http://user01:p%40ss%20word@198.51.100.7:8001",
      socks5: "socks5://user01:p%40ss%20word@198.51.100.7:9001",
    });
    expect(connectionUrls(SAMPLE_SPLIT_PROXY as OwnedProxy).socks5).toBe("socks5://socks-user:socks-pass@203.0.113.9:7002");
  });

  it("reports a completed rotation as done", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({ body: { result: "ok", rotated: true, ip: "172.58.1.1", message: "IP rotated" } }));
    const result = await client.proxies.rotate(SAMPLE_PROXY._id);
    expect(result).toMatchObject({ state: "done", ip: "172.58.1.1" });
  });

  it("reports a 202 pending rotation as rotating, never as a failure", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({
      status: 202,
      body: { result: "ok", accepted: true, rotated: false, pending: true, state: "rotating", retry_after_seconds: 10, status_url: "/api/v3/modems/x/rotation-status" },
    }));
    const result = await client.proxies.rotate(SAMPLE_PROXY._id);
    expect(result).toMatchObject({ state: "rotating", retryAfterSeconds: 10 });
  });

  it("reports 200 rotated:false as unchanged, not as an error", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({ body: { result: "ok", rotated: false, ip: "172.58.1.1", message: "Rotation did not change the IP" } }));
    const result = await client.proxies.rotate(SAMPLE_PROXY._id);
    expect(result).toMatchObject({ state: "unchanged", ip: "172.58.1.1" });
  });

  it("accepts the token route's success shape, which has no rotated field", async () => {
    server.on("GET /modems/rotate-modem-by-token/:token", () => ({ body: { result: "ok", message: "IP rotated", ext_ip: "1.1.1.1", new_ip: "2.2.2.2" } }));
    const anonymous: Coronium = new Coronium({ baseUrl: server.baseUrl });
    const result = await anonymous.proxies.rotateByToken("2b7c1e0e-0000-4000-8000-000000000000");
    expect(result).toMatchObject({ state: "done", ip: "2.2.2.2" });
    expect(server.requests.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("waits for an async rotation to finish", async () => {
    let reads: number = 0;
    server.on("GET /modems/:modem_id/rotation-status", () => {
      reads += 1;
      const state: string = reads < 2 ? "rotating" : "done";
      return { body: { state, ext_ip: "3.3.3.3", rotated_at: 1 } };
    });
    const status = await client.proxies.waitForRotation("m1", { intervalMs: 5, timeoutMs: 2_000 });
    expect(status.state).toBe("done");
    expect(reads).toBe(2);
  });

  it("returns the replacement's new credentials", async () => {
    server.on("POST /modems/:modem_id/replace", () => ({
      body: { result: "ok", oldModemId: "old", newModemId: "new", newModem: { _id: "new", http_port: "1", socks_port: "2", proxy_login: "a", proxy_password: "b" } },
    }));
    const result = await client.proxies.replace("old");
    expect(result.newModemId).toBe("new");
    expect(result.newModem?.proxy_login).toBe("a");
  });

  it("downloads an OpenVPN profile as text", async () => {
    server.on("GET /modems/:modem_id/openvpn", () => ({ text: "client\ndev tun\n", contentType: "application/x-openvpn-profile" }));
    const profile: string = await client.proxies.openvpn("m1", { proto: "tcp" });
    expect(profile).toContain("dev tun");
    expect(server.requests.at(-1)?.query.get("proto")).toBe("tcp");
  });

  it("maps a 200 test failure to ok:false instead of throwing", async () => {
    server.on("POST /modems/:modem_id/test", () => ({ body: { error: "Modem unavailable!", message: "timeout", requestTime: 3000 } }));
    const result = await client.proxies.test("m1");
    expect(result).toMatchObject({ ok: false, error: "Modem unavailable!", requestTime: 3000 });
  });

  it("maps a 201 test success to ok:true with the exit IP", async () => {
    server.on("POST /modems/:modem_id/test", () => ({ status: 201, body: { data: { error: "", groupName: "pingStatus", extIp: "4.4.4.4", requestTime: 120 } } }));
    const result = await client.proxies.test("m1");
    expect(result).toMatchObject({ ok: true, extIp: "4.4.4.4" });
  });

  it("sets a whitelist with the white_list key", async () => {
    server.on("PUT /modems/:modem_id/set-white-list", () => ({ body: { result: "ok", data: ["1.2.3.4"] } }));
    await client.proxies.setWhitelist("m1", [" 1.2.3.4 "]);
    expect(server.requests.at(-1)?.body).toEqual({ white_list: ["1.2.3.4"] });
  });
});

describe("tickets", () => {
  const staffTicket = {
    _id: "t1",
    _ownerId: "u1",
    subject: "Slow proxy",
    status: "open",
    messages: [{ text: "hi", isAdmin: false }],
    internalNotes: [{ text: "staff only" }],
    escalated: true,
    escalationReason: "x",
    escalatedAt: 1,
  };

  it("strips staff-only fields from list and get", async () => {
    server.on("GET /tickets", () => ({ body: { data: { tickets: [staffTicket], total: 1, limit: 50, offset: 0 } } }));
    server.on("GET /tickets/:id", () => ({ body: { data: staffTicket } }));
    const page = await client.tickets.list({ limit: 1000 });
    const ticket = await client.tickets.get("t1");
    for (const view of [page.tickets[0], ticket]) {
      expect(view).not.toHaveProperty("internalNotes");
      expect(view).not.toHaveProperty("escalated");
      expect(view).not.toHaveProperty("escalationReason");
      expect(view).not.toHaveProperty("_ownerId");
    }
    expect(server.requests[0]?.query.get("limit")).toBe("100");
  });

  it("creates, replies and archives", async () => {
    server.on("POST /tickets", (request) => ({ status: 201, body: { data: { ...staffTicket, ...(request.body as object) } } }));
    server.on("POST /tickets/:id/reply", () => ({ body: { data: staffTicket } }));
    server.on("PUT /tickets/:id/archive", () => ({ body: { result: "ok" } }));
    const created = await client.tickets.create({ subject: "Slow proxy", message: "It is slow" });
    expect(created).not.toHaveProperty("internalNotes");
    await client.tickets.reply("t1", "more detail");
    await client.tickets.archive("t1");
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /tickets",
      "POST /tickets/t1/reply",
      "PUT /tickets/t1/archive",
    ]);
  });
});

describe("webhook", () => {
  const settings = { webhook_url: "https://example.com/hook", enabled: true, auto_replace_dead_proxies: true };

  it("always sends the webhook_url key and requires https", async () => {
    server.on("PUT /account/webhook", () => ({ body: settings }));
    await client.webhook.set("https://example.com/hook");
    expect(server.requests.at(-1)?.body).toEqual({ webhook_url: "https://example.com/hook" });
    const error: CoroniumError = await captureError(client.webhook.set("http://example.com/hook"));
    expect(error.code).toBe("invalid_argument");
  });

  it("gets, deletes, rotates the secret and tests", async () => {
    server.on("GET /account/webhook", () => ({ body: settings }));
    server.on("DELETE /account/webhook", () => ({ body: { ...settings, enabled: false, webhook_url: null } }));
    server.on("POST /account/webhook/secret/rotate", () => ({ body: { secret: "whsec_once", preview: "whsec_...", rotated: true } }));
    server.on("POST /account/webhook/test", () => ({ body: { delivered: false, status_code: null, error: "connect ECONNREFUSED", signed: true } }));
    expect((await client.webhook.get()).enabled).toBe(true);
    expect((await client.webhook.delete()).enabled).toBe(false);
    expect((await client.webhook.rotateSecret()).secret).toBe("whsec_once");
    const test = await client.webhook.test();
    expect(test).toMatchObject({ delivered: false, error: "connect ECONNREFUSED" });
  });

  it("verifies an X-Coronium-Signature header", () => {
    const body: string = JSON.stringify({ event: "proxy.expired" });
    const signature: string = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(body, signature, "other")).toBe(false);
  });
});

describe("wallet", () => {
  it("runs the challenge and sign-up calls with the backend field names", async () => {
    server.on("POST /wallet-challenge", () => ({ body: { message: "siwe message", nonce: "n1", expires_in_s: 300 } }));
    server.on("POST /wallet-signup", () => ({ body: { api_token: "jwt", user_id: "u1", wallet_address: "0xabc", balance_usd: 5 } }));
    const anonymous: Coronium = new Coronium({ baseUrl: server.baseUrl });
    const challenge = await anonymous.wallet.challenge({ walletAddress: "0xabc", voucher: "cor_v1_x" });
    const signup = await anonymous.wallet.signup({ walletAddress: "0xabc", voucher: "cor_v1_x", message: challenge.message, signature: "0xsig" });
    expect(signup.api_token).toBe("jwt");
    expect(server.requests[1]?.body).toEqual({ wallet_address: "0xabc", voucher: "cor_v1_x", message: "siwe message", signature: "0xsig" });
  });

  it("rotates a wallet-bound key with the Bearer token", async () => {
    server.on("POST /wallet-key/rotate-challenge", () => ({ body: { message: "rotate me", nonce: "n2", expires_in_s: 300 } }));
    server.on("POST /wallet-key/rotate", () => ({ body: { api_token: "jwt2" } }));
    const challenge = await client.wallet.rotateChallenge();
    const rotated = await client.wallet.rotate({ message: challenge.message, signature: "0xsig" });
    expect(rotated.api_token).toBe("jwt2");
    expect(server.requests.every((request) => !request.url.includes("auth_token"))).toBe(true);
  });
});
