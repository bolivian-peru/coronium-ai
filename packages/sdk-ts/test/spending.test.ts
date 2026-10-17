import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Coronium, CoroniumError } from "../src/index.js";
import { FIXTURE_TOKEN, installCatalog, SAMPLE_PROXY, startFixtureServer, type FixtureServer, type FixtureReply } from "./support/fixture-server.js";

// From catalog-sample.json: US T-Mobile 7-day plan, $49, stock 2.
const TARIFF_ID: string = "61effbaf5a33f238ac15a911";
const PRICE: number = 49;

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

function paymentRequests(): Array<{ path: string; body: unknown; key: unknown }> {
  return server.requests
    .filter((request) => request.path.startsWith("/payment/") && request.path !== "/payment/renewal-quote")
    .map((request) => ({ path: request.path, body: request.body, key: request.headers["idempotency-key"] }));
}

function delivered(count: number): FixtureReply {
  const data = Array.from({ length: count }, (_value, index) => ({ ...SAMPLE_PROXY, _id: `new${index}` }));
  return { body: { result: "ok", charged_usd: PRICE * count, currency: "USD", data, billing: { schema_version: 1, action: "purchase" } } };
}

beforeEach(async () => {
  server = await startFixtureServer();
  installCatalog(server);
  client = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl, allowSpending: true });
});

afterEach(async () => {
  await server.close();
});

describe("spending gate", () => {
  it("is off by default and refuses before any request", async () => {
    const locked: Coronium = new Coronium({ token: FIXTURE_TOKEN, baseUrl: server.baseUrl });
    expect(locked.spending.enabled).toBe(false);
    const error: CoroniumError = await captureError(
      locked.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: PRICE }),
    );
    expect(error.code).toBe("spending_disabled");
    expect(server.requests).toHaveLength(0);
  });

  it("requires expectedTotalUsd", async () => {
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit" } as never),
    );
    expect(error.code).toBe("invalid_argument");
    expect(server.requests).toHaveLength(0);
  });

  it("quotes without spending", async () => {
    const locked: Coronium = new Coronium({ baseUrl: server.baseUrl });
    const quote = await locked.spending.quoteBuy(TARIFF_ID, 2);
    expect(quote.totalUsd).toBe(98);
  });
});

describe("buy", () => {
  it("refuses with price_changed when the fresh total is above the approved one, sending nothing", async () => {
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 2, funding: "account_credit", expectedTotalUsd: 97.99 }),
    );
    expect(error.code).toBe("price_changed");
    expect(paymentRequests()).toHaveLength(0);
  });

  it("refuses when stock is short, sending nothing", async () => {
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 3, funding: "account_credit", expectedTotalUsd: 500 }),
    );
    expect(error.code).toBe("insufficient_stock");
    expect(paymentRequests()).toHaveLength(0);
  });

  it("buys with account credit: tariff_id + modemCount only, with an Idempotency-Key", async () => {
    server.on("POST /payment/buy-with-account-credit", () => delivered(2));
    const receipt = await client.spending.buy({ tariffId: TARIFF_ID, quantity: 2, funding: "account_credit", expectedTotalUsd: 98 });
    expect(receipt.status).toBe("delivered");
    expect(receipt.chargedUsd).toBe(98);
    expect(receipt.proxies).toHaveLength(2);
    const [payment] = paymentRequests();
    expect(payment?.body).toEqual({ tariff_id: TARIFF_ID, modemCount: 2, max_total_usd: 98 });
    expect(payment?.key).toBe(receipt.idempotencyKey);
  });

  it("uses the BTC lane when funding is btc", async () => {
    server.on("POST /payment/buy-modems-with-crypto-balance", () => delivered(1));
    await client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "btc", expectedTotalUsd: 49 });
    expect(paymentRequests()[0]?.path).toBe("/payment/buy-modems-with-crypto-balance");
  });

  it("reports a 202 as processing with the payment id", async () => {
    server.on("POST /payment/buy-modems-with-crypto-balance", () => ({ status: 202, body: { message: "processing", paymentId: "pay_9" } }));
    const receipt = await client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "btc", expectedTotalUsd: 49 });
    expect(receipt).toMatchObject({ status: "processing", paymentId: "pay_9" });
  });

  it("marks a 200 with fewer proxies than ordered as unverified", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({ body: { result: "ok", data: [] } }));
    const receipt = await client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 49 });
    expect(receipt.status).toBe("unverified");
    expect(receipt.deliveredCount).toBe(0);
  });

  it("maps a synchronous refund to outcome refunded_not_charged", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({
      status: 503,
      body: { error: "Out of stock", code: "no_stock", refunded: true, refund_amount: 49 },
    }));
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 49 }),
    );
    expect(error.outcome).toBe("refunded_not_charged");
  });

  it("maps a 500 to outcome unknown and keeps the idempotency key", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({ status: 500, body: { error: "provisioning failed" } }));
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 49, idempotencyKey: "order-0001" }),
    );
    expect(error.outcome).toBe("unknown");
    expect(error.idempotencyKey).toBe("order-0001");
  });

  it("treats a 200 that carries an error string as outcome unknown", async () => {
    server.on("POST /payment/buy-modems-with-crypto-balance", () => ({ body: { error: "Please pay or cancel current pending payment" } }));
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "btc", expectedTotalUsd: 49 }),
    );
    expect(error.outcome).toBe("unknown");
  });

  it("sends one request for repeated calls with the same key and payload", async () => {
    server.on("POST /payment/buy-with-account-credit", () => delivered(1));
    const input = { tariffId: TARIFF_ID, quantity: 1, funding: "account_credit" as const, expectedTotalUsd: 49, idempotencyKey: "order-0002" };
    await Promise.all([client.spending.buy(input), client.spending.buy(input)]);
    expect(paymentRequests()).toHaveLength(1);
  });

  it("refuses an idempotency key the API would reject, sending nothing", async () => {
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 49, idempotencyKey: "order 0004!" }),
    );
    expect(error.code).toBe("invalid_argument");
    expect(paymentRequests()).toHaveLength(0);
  });

  it("lets the same key be sent again after a clear refusal", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({
      status: 400,
      body: { error: "Not enough credit", code: "INSUFFICIENT_CREDIT", available_usd: 10, required_usd: 49 },
    }));
    const input = { tariffId: TARIFF_ID, quantity: 1, funding: "account_credit" as const, expectedTotalUsd: 49, idempotencyKey: "order-0005" };
    const error: CoroniumError = await captureError(client.spending.buy(input));
    expect(error.outcome).toBe("rejected");
    server.on("POST /payment/buy-with-account-credit", () => delivered(1));
    const receipt = await client.spending.buy(input);
    expect(receipt.status).toBe("delivered");
    expect(paymentRequests()).toHaveLength(2);
  });

  it("never resends a key whose outcome is unknown in the same process", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({ status: 500, body: { error: "provisioning failed" } }));
    const input = { tariffId: TARIFF_ID, quantity: 1, funding: "account_credit" as const, expectedTotalUsd: 49, idempotencyKey: "order-0006" };
    await captureError(client.spending.buy(input));
    server.on("POST /payment/buy-with-account-credit", () => delivered(1));
    const again: CoroniumError = await captureError(client.spending.buy(input));
    expect(again.outcome).toBe("unknown");
    expect(paymentRequests()).toHaveLength(1);
  });

  it("maps a 409 request_outcome_unknown to outcome unknown", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({
      status: 409,
      body: { error: "An earlier request with this key has an unknown outcome", code: "request_outcome_unknown" },
    }));
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 49 }),
    );
    expect(error.outcome).toBe("unknown");
  });

  it("maps new_order_created:false to outcome rejected even on a 503", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({
      status: 503,
      body: { error: "Payment service unavailable", code: "PAYMENT_SERVICE_UNAVAILABLE", new_order_created: false },
    }));
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 49 }),
    );
    expect(error.outcome).toBe("rejected");
  });

  it("refuses the same key for a different order", async () => {
    server.on("POST /payment/buy-with-account-credit", () => delivered(1));
    await client.spending.buy({ tariffId: TARIFF_ID, quantity: 1, funding: "account_credit", expectedTotalUsd: 98, idempotencyKey: "order-0003" });
    server.on("POST /payment/buy-with-account-credit", () => delivered(2));
    const error: CoroniumError = await captureError(
      client.spending.buy({ tariffId: TARIFF_ID, quantity: 2, funding: "account_credit", expectedTotalUsd: 98, idempotencyKey: "order-0003" }),
    );
    expect(error.code).toBe("idempotency_conflict");
    expect(paymentRequests()).toHaveLength(1);
  });
});

describe("renew", () => {
  beforeEach(() => {
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
  });

  it("renews with modems only (never tariff_id) after a complete quote", async () => {
    server.on("POST /payment/renew-with-account-credit", () => delivered(1));
    const receipt = await client.spending.renew({ items: [{ modemId: "m1", days: 7 }], funding: "account_credit", expectedTotalUsd: 49 });
    expect(receipt.status).toBe("delivered");
    const [payment] = paymentRequests();
    expect(payment?.body).toEqual({ modems: [{ modem_id: "m1", days: 7 }], max_total_usd: 49 });
  });

  it("checks a coupon renewal against the undiscounted subtotal, because the charge can skip the coupon", async () => {
    server.on("POST /payment/renewal-quote", () => ({
      body: {
        currency: "USD",
        subtotal_usd: 49,
        discount_usd: 9.8,
        total_usd: 39.2,
        coupon: { name: "SAVE20", value: "20" },
        line_items: [{ modem_id: "m1", days: 7, line_total_usd: 49 }],
      },
    }));
    const error: CoroniumError = await captureError(
      client.spending.renew({ items: [{ modemId: "m1", days: 7 }], funding: "account_credit", expectedTotalUsd: 39.2, coupon: "SAVE20" }),
    );
    expect(error.code).toBe("price_changed");
    expect(paymentRequests()).toHaveLength(0);

    server.on("POST /payment/renew-with-account-credit", () => delivered(1));
    const receipt = await client.spending.renew({ items: [{ modemId: "m1", days: 7 }], funding: "account_credit", expectedTotalUsd: 49, coupon: "SAVE20" });
    expect(receipt.quotedTotalUsd).toBe(49);
    expect(paymentRequests()[0]?.body).toEqual({ modems: [{ modem_id: "m1", days: 7 }], max_total_usd: 49, coupon: { coupon_name: "SAVE20" } });
  });

  it("refuses when the renewal quote is above the approved total", async () => {
    const error: CoroniumError = await captureError(
      client.spending.renew({ items: [{ modemId: "m1", days: 7 }], funding: "btc", expectedTotalUsd: 40 }),
    );
    expect(error.code).toBe("price_changed");
    expect(paymentRequests()).toHaveLength(0);
  });
});
