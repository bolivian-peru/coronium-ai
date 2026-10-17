import kleur from "kleur";
import type { AvailableTariff, BuyQuote, Coronium, Country, RenewalItem, RenewalQuote, StockEntry } from "coronium-sdk";
import { makeClient } from "../client.js";
import { field, isJson, parseCount, printJson, usd, UsageError, type GlobalOptions } from "../output.js";

export interface TariffOptions extends GlobalOptions {
  country?: string;
  carrier?: string;
}

export interface StockOptions extends GlobalOptions {
  country?: string;
  carrierId?: string;
}

export interface QuoteBuyOptions extends GlobalOptions {
  tariff?: string;
  count?: string;
}

export interface QuoteRenewOptions extends GlobalOptions {
  coupon?: string;
}

const PERIOD_LABEL: Record<string, string> = { day: "1 day", week: "7 days", month: "30 days" };

/** Parse "<proxy id>:<days>" arguments used by `quote renew` and `renew`. */
export function parseRenewalItems(raw: string[]): RenewalItem[] {
  if (raw.length === 0) throw new UsageError("List proxies as <id>:<days>, for example 6512aa...:30");
  return raw.map((entry: string): RenewalItem => {
    const [modemId, daysText] = entry.split(":");
    const days: number = Number(daysText);
    if (!modemId || !Number.isInteger(days)) {
      throw new UsageError(`"${entry}" is not <id>:<days>.`);
    }
    return { modemId, days };
  });
}

export function periodLabel(period: string): string {
  return PERIOD_LABEL[period] ?? period;
}

export function describeTariff(tariff: AvailableTariff): string {
  return `${tariff.country_code} ${tariff.carrier_name}, ${periodLabel(tariff.period)}`;
}

export async function countriesCommand(options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: false });
  const countries: Country[] = await client.catalog.countries();
  if (isJson(options)) {
    printJson(countries);
    return;
  }
  for (const country of countries) {
    const carriers: string = country.carriers.map((carrier) => carrier.name).join(", ");
    console.log(`${kleur.bold(country.country_code.padEnd(3))} ${country.name.padEnd(20)} ${kleur.dim(carriers)}`);
  }
}

export async function tariffsCommand(options: TariffOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: false });
  const tariffs: AvailableTariff[] = await client.catalog.availableTariffs({
    countryCode: options.country,
    carrierName: options.carrier,
  });
  if (isJson(options)) {
    printJson(tariffs);
    return;
  }
  if (tariffs.length === 0) {
    console.log("No plans in stock match those filters.");
    return;
  }
  for (const tariff of tariffs) {
    const price: string = usd(tariff.price).padStart(8);
    console.log(`${tariff._id}  ${price}  ${describeTariff(tariff).padEnd(32)} ${kleur.dim(`stock ${tariff.stock}`)}`);
  }
  console.log(kleur.dim(`\n${tariffs.length} plans. Prices are per proxy for the period shown.`));
}

export async function stockCommand(options: StockOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: false });
  const stock: StockEntry[] = await client.catalog.stock({ countryCode: options.country, carrierId: options.carrierId });
  if (isJson(options)) {
    printJson(stock);
    return;
  }
  for (const row of stock) {
    const where: string = [row.countryCode, row.carrierName, row.regionName].filter(Boolean).join(" / ");
    console.log(`${String(row.count).padStart(4)}  ${where}`);
  }
}

export async function quoteBuyCommand(options: QuoteBuyOptions): Promise<void> {
  if (!options.tariff) throw new UsageError("--tariff <id> is required. Find one with: coronium tariffs");
  const quantity: number = parseCount(options.count ?? "1", "--count");
  const client: Coronium = await makeClient({ requireToken: false });
  const quote: BuyQuote = await client.spending.quoteBuy(options.tariff, quantity);
  if (isJson(options)) {
    printJson(quote);
    return;
  }
  printBuyQuote(quote);
}

export function printBuyQuote(quote: BuyQuote): void {
  console.log(kleur.bold("Quote"));
  field("plan", `${quote.tariff.name} (${describeTariff(quote.tariff)})`);
  field("unit price", usd(quote.tariff.price));
  field("quantity", quote.quantity);
  field("total", kleur.bold(usd(quote.totalUsd)));
  field("in stock", quote.tariff.stock);
}

export async function quoteRenewCommand(items: string[], options: QuoteRenewOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const quote: RenewalQuote = await client.catalog.renewalQuote(parseRenewalItems(items), options.coupon);
  if (isJson(options)) {
    printJson(quote);
    return;
  }
  printRenewalQuote(quote);
}

export function printRenewalQuote(quote: RenewalQuote): void {
  console.log(kleur.bold("Renewal quote"));
  for (const line of quote.line_items) {
    field(line.name ?? line.modem_id, `${line.days} days  ${usd(line.line_total_usd)}`);
  }
  if (quote.discount_usd > 0) field("discount", usd(quote.discount_usd));
  field("total", kleur.bold(usd(quote.total_usd)));
}
