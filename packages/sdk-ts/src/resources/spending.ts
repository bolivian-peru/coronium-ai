// Methods in this file CHARGE MONEY. They are disabled unless the client was
// created with `allowSpending: true`, and each call needs the total the user
// approved (`expectedTotalUsd`).
//
// The approved total is checked against a fresh quote right before the order is
// sent, and sent along as `max_total_usd`. Until the API enforces that field
// itself, the check is a client-side pre-check: a price change between the quote
// and the charge is still possible, so keep the window short.

import { createHash, randomUUID } from "node:crypto";
import { CoroniumError } from "../errors.js";
import { ROUTES, type RouteSpec } from "../routes.js";
import { isObject, type CallResult, type Transport } from "../transport.js";
import type {
  AvailableTariff,
  BuyInput,
  BuyQuote,
  FundingSource,
  OwnedProxy,
  RenewalQuote,
  RenewInput,
  SpendReceipt,
} from "../types.js";
import { assertRenewalItems, couponBody, renewalModems, type CatalogResource } from "./catalog.js";

interface Intent {
  fingerprint: string;
  result: Promise<CallResult<unknown>>;
}

interface Order {
  route: RouteSpec;
  body: Record<string, unknown>;
  funding: FundingSource;
  idempotencyKey: string;
  approvedTotalUsd: number;
  quotedTotalUsd: number;
  requestedCount: number;
}

const MIN_KEY_LENGTH: number = 8;
const MAX_KEY_LENGTH: number = 128;
const MAX_QUANTITY: number = 100;
const MAX_INTENTS: number = 10_000;

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

function assertSpendingAllowed(allowSpending: boolean): void {
  if (allowSpending) return;
  throw new CoroniumError({
    code: "spending_disabled",
    message: "Spending is turned off. Create the client with { allowSpending: true } to buy or renew.",
    suggestedAction: "enable_spending",
  });
}

function assertFunding(funding: FundingSource): void {
  if (funding === "account_credit" || funding === "btc") return;
  throw new CoroniumError({ code: "invalid_argument", message: 'funding must be "account_credit" or "btc".' });
}

function assertApprovedTotal(expectedTotalUsd: number): void {
  const valid: boolean = typeof expectedTotalUsd === "number" && Number.isFinite(expectedTotalUsd) && expectedTotalUsd > 0;
  if (valid) return;
  throw new CoroniumError({
    code: "invalid_argument",
    message: "expectedTotalUsd is required: pass the total in USD the user approved.",
  });
}

function assertQuantity(quantity: number): void {
  if (Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY) return;
  throw new CoroniumError({ code: "invalid_argument", message: `quantity must be a whole number from 1 to ${MAX_QUANTITY}.` });
}

function resolveIdempotencyKey(provided: string | undefined): string {
  if (provided === undefined) return `cor-${randomUUID()}`;
  if (provided.length >= MIN_KEY_LENGTH && provided.length <= MAX_KEY_LENGTH) return provided;
  throw new CoroniumError({ code: "invalid_argument", message: "idempotencyKey must be 8 to 128 characters." });
}

/** Refuse only when the fresh total is higher than approved; a lower price is fine. */
function assertWithinApproved(quotedTotalUsd: number, approvedTotalUsd: number): void {
  if (toCents(quotedTotalUsd) <= toCents(approvedTotalUsd)) return;
  throw new CoroniumError({
    code: "price_changed",
    message: `The current total is $${quotedTotalUsd.toFixed(2)}, above the approved $${approvedTotalUsd.toFixed(2)}. Nothing was charged. Show the new total and ask again.`,
    suggestedAction: "requote_and_confirm",
  });
}

function buyRoute(funding: FundingSource): RouteSpec {
  if (funding === "btc") return ROUTES.buyWithBtc;
  return ROUTES.buyWithAccountCredit;
}

function renewRoute(funding: FundingSource): RouteSpec {
  if (funding === "btc") return ROUTES.renewWithBtc;
  return ROUTES.renewWithAccountCredit;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  return null;
}

function deliveredProxies(body: Record<string, unknown>): OwnedProxy[] {
  if (Array.isArray(body.data)) return body.data as OwnedProxy[];
  return [];
}

function toReceipt(order: Order, result: CallResult<unknown>): SpendReceipt {
  const body: Record<string, unknown> = isObject(result.body) ? result.body : {};
  const proxies: OwnedProxy[] = deliveredProxies(body);
  const base: Omit<SpendReceipt, "status"> = {
    funding: order.funding,
    idempotencyKey: order.idempotencyKey,
    requestId: result.requestId,
    paymentId: stringOrNull(body.paymentId) ?? stringOrNull(body.payment_id),
    chargedUsd: numberOrNull(body.charged_usd),
    approvedTotalUsd: order.approvedTotalUsd,
    quotedTotalUsd: order.quotedTotalUsd,
    requestedCount: order.requestedCount,
    deliveredCount: proxies.length,
    proxies,
    response: result.body,
  };
  if (result.status === 202) return { status: "processing", ...base };
  // A 200 without the ordered number of proxies is not proof of delivery.
  if (body.result === "ok" && proxies.length === order.requestedCount) return { status: "delivered", ...base };
  return { status: "unverified", ...base };
}

export class SpendingResource {
  private readonly intents: Map<string, Intent> = new Map();

  constructor(
    private readonly transport: Transport,
    private readonly catalog: CatalogResource,
    private readonly allowSpending: boolean,
    private readonly purchaseTimeoutMs: number,
  ) {}

  /** True when this client may call `buy` and `renew`. */
  get enabled(): boolean {
    return this.allowSpending;
  }

  /**
   * Price an order from the live catalog: plan price x quantity, before coupons.
   * Read-only. Throws `tariff_unavailable` or `insufficient_stock`.
   */
  async quoteBuy(tariffId: string, quantity: number): Promise<BuyQuote> {
    assertQuantity(quantity);
    const tariffs: AvailableTariff[] = await this.catalog.availableTariffs();
    const tariff: AvailableTariff | undefined = tariffs.find((row: AvailableTariff): boolean => String(row._id) === tariffId);
    if (!tariff) {
      throw new CoroniumError({ code: "tariff_unavailable", message: `Plan ${tariffId} is not on sale right now.`, suggestedAction: "list_tariffs" });
    }
    if (typeof tariff.stock !== "number" || tariff.stock < quantity) {
      throw new CoroniumError({
        code: "insufficient_stock",
        message: `Plan ${tariffId} has ${tariff.stock} in stock, fewer than ${quantity}.`,
        suggestedAction: "list_tariffs",
      });
    }
    const totalUsd: number = toCents(tariff.price) * quantity / 100;
    return { tariff, quantity, totalUsd };
  }

  /**
   * CHARGES MONEY. Buy new proxies from account credit or the BTC wallet.
   *
   * Requires `allowSpending: true` on the client and `expectedTotalUsd`. A fresh
   * quote above the approved total throws `price_changed` and nothing is sent.
   * On `outcome: "unknown"` or `status: "unverified"`, do not buy again: check
   * `account.payment` and `proxies.list` first.
   */
  async buy(input: BuyInput): Promise<SpendReceipt> {
    assertSpendingAllowed(this.allowSpending);
    assertFunding(input.funding);
    assertApprovedTotal(input.expectedTotalUsd);
    const idempotencyKey: string = resolveIdempotencyKey(input.idempotencyKey);
    const quote: BuyQuote = await this.quoteBuy(input.tariffId, input.quantity);
    assertWithinApproved(quote.totalUsd, input.expectedTotalUsd);
    // A buy sends only tariff_id + modemCount; never a renewal basket.
    const body: Record<string, unknown> = {
      tariff_id: input.tariffId,
      modemCount: input.quantity,
      max_total_usd: input.expectedTotalUsd,
      ...couponBody(input.coupon),
    };
    if (input.metadata !== undefined) body.metadata = input.metadata;
    if (input.wantP0f !== undefined) body.wantP0f = input.wantP0f;
    return this.submit({
      route: buyRoute(input.funding),
      body,
      funding: input.funding,
      idempotencyKey,
      approvedTotalUsd: input.expectedTotalUsd,
      quotedTotalUsd: quote.totalUsd,
      requestedCount: input.quantity,
    });
  }

  /**
   * CHARGES MONEY. Renew proxies you own for 1 to 90 days each.
   *
   * Requires `allowSpending: true` and `expectedTotalUsd`, checked against a fresh
   * renewal quote that must cover every proxy for exactly the requested days.
   */
  async renew(input: RenewInput): Promise<SpendReceipt> {
    assertSpendingAllowed(this.allowSpending);
    assertFunding(input.funding);
    assertApprovedTotal(input.expectedTotalUsd);
    assertRenewalItems(input.items);
    const idempotencyKey: string = resolveIdempotencyKey(input.idempotencyKey);
    const quote: RenewalQuote = await this.catalog.renewalQuote(input.items, input.coupon);
    assertWithinApproved(quote.total_usd, input.expectedTotalUsd);
    // A renewal never sends tariff_id: with both present the API would buy.
    const body: Record<string, unknown> = {
      modems: renewalModems(input.items),
      max_total_usd: input.expectedTotalUsd,
      ...couponBody(input.coupon),
    };
    return this.submit({
      route: renewRoute(input.funding),
      body,
      funding: input.funding,
      idempotencyKey,
      approvedTotalUsd: input.expectedTotalUsd,
      quotedTotalUsd: quote.total_usd,
      requestedCount: input.items.length,
    });
  }

  // Concurrent or repeated calls with the same key and payload share one HTTP
  // request in this process; the same key with a different payload is refused.
  private async submit(order: Order): Promise<SpendReceipt> {
    const scope: string = sha256(this.transport.token ?? "");
    const intentKey: string = `${scope}:${order.idempotencyKey}`;
    const fingerprint: string = sha256(JSON.stringify({ path: order.route.path, body: order.body }));
    const previous: Intent | undefined = this.intents.get(intentKey);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new CoroniumError({
        code: "idempotency_conflict",
        message: "This idempotency key already belongs to a different order. Use a new key for a new order.",
        idempotencyKey: order.idempotencyKey,
      });
    }
    let result: Promise<CallResult<unknown>>;
    if (previous) {
      result = previous.result;
    } else {
      result = this.send(order);
      this.remember(intentKey, { fingerprint, result });
    }
    return toReceipt(order, await result);
  }

  private send(order: Order): Promise<CallResult<unknown>> {
    return this.transport.call<unknown>(order.route, {
      body: order.body,
      idempotencyKey: order.idempotencyKey,
      timeoutMs: this.purchaseTimeoutMs,
    });
  }

  private remember(intentKey: string, intent: Intent): void {
    if (this.intents.size >= MAX_INTENTS) {
      const oldest: string | undefined = this.intents.keys().next().value;
      if (oldest !== undefined) this.intents.delete(oldest);
    }
    this.intents.set(intentKey, intent);
  }
}
