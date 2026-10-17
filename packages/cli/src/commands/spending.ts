// Commands that CHARGE MONEY. Each one prints the price first and then refuses
// unless all three are present: spending turned on, --max-total, and --yes.

import kleur from "kleur";
import {
  connectionUrls,
  type BuyQuote,
  type Coronium,
  type FundingSource,
  type RenewalItem,
  type RenewalQuote,
  type SpendReceipt,
} from "coronium-sdk";
import { makeClient } from "../client.js";
import { isSpendingAllowed, loadConfig, saveConfig, type CliConfig } from "../config.js";
import {
  EXIT_OUTCOME_UNKNOWN,
  ExitWith,
  field,
  isJson,
  ok,
  parseCount,
  parseUsd,
  printJson,
  usd,
  UsageError,
  warn,
  type GlobalOptions,
} from "../output.js";
import { parseRenewalItems, printBuyQuote, printRenewalQuote } from "./catalog.js";

export interface SpendOptions extends GlobalOptions {
  funding?: string;
  maxTotal?: string;
  yes?: boolean;
  coupon?: string;
  key?: string;
}

export interface BuyOptions extends SpendOptions {
  tariff?: string;
  count?: string;
}

const FUNDING_LABEL: Record<FundingSource, string> = { account_credit: "account credit", btc: "BTC wallet" };

function parseFunding(raw: string | undefined): FundingSource {
  if (raw === "account_credit" || raw === "btc") return raw;
  throw new UsageError("--funding is required: account_credit or btc.", [
    "account_credit spends your USD account credit; btc spends the BTC wallet at the live rate.",
  ]);
}

/** Checked after the price is shown, so the user always sees what they would pay. */
async function assertSpendGates(options: SpendOptions): Promise<number> {
  const config: CliConfig = await loadConfig();
  if (!isSpendingAllowed(config)) {
    throw new UsageError("Spending is off, so nothing was charged.", [
      "Turn it on with: coronium spending on (or set CORONIUM_ALLOW_SPENDING=1)",
    ]);
  }
  if (options.maxTotal === undefined) {
    throw new UsageError("--max-total <usd> is required: the most you approve for this order. Nothing was charged.");
  }
  const maxTotal: number = parseUsd(options.maxTotal, "--max-total");
  if (!options.yes) {
    throw new UsageError("Add --yes to place this order. Nothing was charged.");
  }
  return maxTotal;
}

function printReceipt(receipt: SpendReceipt): void {
  if (receipt.status === "delivered") {
    ok(`Charged ${usd(receipt.chargedUsd)} from ${FUNDING_LABEL[receipt.funding]}. ${receipt.deliveredCount} proxies ready.`);
  }
  if (receipt.status === "processing") {
    warn(`Payment is still processing${receipt.paymentId ? ` (payment ${receipt.paymentId})` : ""}. Do not order again.`);
    if (receipt.paymentId) console.log(`  Check it with: coronium payment ${receipt.paymentId}`);
  }
  if (receipt.status === "unverified") {
    warn(`The API accepted the order but returned ${receipt.deliveredCount} of ${receipt.requestedCount} proxies. Do not order again.`);
    console.log("  Check with: coronium proxy list");
  }
  for (const proxy of receipt.proxies) {
    const urls = connectionUrls(proxy);
    console.log(`  ${kleur.bold(proxy.name)}  ${urls.http ?? ""}`);
  }
  field("idempotency key", receipt.idempotencyKey);
  if (receipt.requestId) field("request id", receipt.requestId);
}

function finishReceipt(receipt: SpendReceipt, options: GlobalOptions): void {
  if (isJson(options)) {
    printJson(receipt);
  } else {
    printReceipt(receipt);
  }
  // Anything short of a verified delivery is not a success.
  if (receipt.status !== "delivered") throw new ExitWith(EXIT_OUTCOME_UNKNOWN);
}

export async function buyCommand(options: BuyOptions): Promise<void> {
  if (!options.tariff) throw new UsageError("--tariff <id> is required. Find one with: coronium tariffs");
  const quantity: number = parseCount(options.count ?? "1", "--count");
  const funding: FundingSource = parseFunding(options.funding);
  // The quote is public, so the price is shown even before a token is checked.
  const client: Coronium = await makeClient({ requireToken: false, spending: true });
  const quote: BuyQuote = await client.spending.quoteBuy(options.tariff, quantity);
  if (!isJson(options)) {
    printBuyQuote(quote);
    field("pay from", FUNDING_LABEL[funding]);
    if (options.coupon) console.log(kleur.dim("  A coupon may lower the charge; --max-total must still cover the total above."));
  }
  const maxTotal: number = await assertSpendGates(options);
  const receipt: SpendReceipt = await client.spending.buy({
    tariffId: options.tariff,
    quantity,
    funding,
    expectedTotalUsd: maxTotal,
    idempotencyKey: options.key,
    coupon: options.coupon,
  });
  finishReceipt(receipt, options);
}

export async function renewCommand(rawItems: string[], options: SpendOptions): Promise<void> {
  const items: RenewalItem[] = parseRenewalItems(rawItems);
  const funding: FundingSource = parseFunding(options.funding);
  const client: Coronium = await makeClient({ requireToken: true, spending: true });
  const quote: RenewalQuote = await client.catalog.renewalQuote(items, options.coupon);
  if (!isJson(options)) {
    printRenewalQuote(quote);
    field("pay from", FUNDING_LABEL[funding]);
    if (quote.discount_usd > 0) {
      console.log(kleur.dim("  The charge can skip a coupon you already used; --max-total must cover the total before the discount."));
    }
  }
  const maxTotal: number = await assertSpendGates(options);
  const receipt: SpendReceipt = await client.spending.renew({
    items,
    funding,
    expectedTotalUsd: maxTotal,
    idempotencyKey: options.key,
    coupon: options.coupon,
  });
  finishReceipt(receipt, options);
}

export async function spendingSetCommand(state: string, options: GlobalOptions): Promise<void> {
  const config: CliConfig = await loadConfig();
  if (state === "status") {
    const enabled: boolean = isSpendingAllowed(config);
    if (isJson(options)) printJson({ spending_enabled: enabled });
    if (!isJson(options)) console.log(`Spending is ${enabled ? "on" : "off"}.`);
    return;
  }
  if (state !== "on" && state !== "off") throw new UsageError("Use: coronium spending on, off or status");
  const enabled: boolean = state === "on";
  await saveConfig({ ...config, allow_spending: enabled });
  if (isJson(options)) {
    printJson({ spending_enabled: enabled });
    return;
  }
  if (enabled) {
    ok("Spending is on. buy and renew still need --max-total and --yes on every order.");
  } else {
    ok("Spending is off.");
  }
}
