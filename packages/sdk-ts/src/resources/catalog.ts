import { CoroniumError } from "../errors.js";
import { ROUTES } from "../routes.js";
import { dataArray, objectBody, type Transport } from "../transport.js";
import type {
  AvailableTariff,
  Carrier,
  Country,
  RenewalItem,
  RenewalQuote,
  Region,
  StockEntry,
  StockRow,
  Tariff,
} from "../types.js";

export interface TariffFilter {
  /** ISO-2 country code, for example "US". */
  countryCode?: string;
  carrierId?: string;
  /** Case-insensitive carrier name, for example "verizon". */
  carrierName?: string;
}

export interface StockFilter {
  countryCode?: string;
  carrierId?: string;
}

const MIN_RENEWAL_DAYS: number = 1;
const MAX_RENEWAL_DAYS: number = 90;

function sameText(left: string | null | undefined, right: string): boolean {
  return (left ?? "").toLowerCase() === right.toLowerCase();
}

// The API ignores query filters on these endpoints, so filtering is done here.
function matchesTariff(tariff: AvailableTariff, filter: TariffFilter): boolean {
  if (filter.countryCode && !sameText(tariff.country_code, filter.countryCode)) return false;
  if (filter.carrierId && String(tariff.carrier_id) !== filter.carrierId) return false;
  if (filter.carrierName && !sameText(tariff.carrier_name, filter.carrierName)) return false;
  return true;
}

function findById<T extends { _id: string }>(rows: T[] | undefined, id: string | null): T | undefined {
  if (!rows || id === null) return undefined;
  return rows.find((row: T): boolean => String(row._id) === String(id));
}

function toStockEntry(row: StockRow, countries: Country[]): StockEntry {
  const country: Country | undefined = findById(countries, row.country_id);
  const carrier: Carrier | undefined = findById(country?.carriers, row.carrier_id);
  const region: Region | undefined = findById(country?.regions, row.region_id);
  return {
    countryId: row.country_id,
    countryCode: country?.country_code ?? null,
    countryName: country?.name ?? null,
    carrierId: row.carrier_id,
    carrierName: carrier?.name ?? null,
    regionId: row.region_id ?? null,
    regionName: region?.name ?? null,
    count: row.count,
  };
}

function matchesStock(entry: StockEntry, filter: StockFilter): boolean {
  if (filter.countryCode && !sameText(entry.countryCode, filter.countryCode)) return false;
  if (filter.carrierId && entry.carrierId !== filter.carrierId) return false;
  return true;
}

export function assertRenewalItems(items: RenewalItem[]): void {
  if (items.length === 0) {
    throw new CoroniumError({ code: "invalid_argument", message: "List at least one proxy to renew." });
  }
  const seen: Set<string> = new Set();
  for (const item of items) {
    const validDays: boolean = Number.isInteger(item.days) && item.days >= MIN_RENEWAL_DAYS && item.days <= MAX_RENEWAL_DAYS;
    if (!validDays) {
      throw new CoroniumError({ code: "invalid_argument", message: `Renewal days must be a whole number from 1 to 90 (got ${item.days}).` });
    }
    const key: string = item.modemId.toLowerCase();
    if (seen.has(key)) {
      throw new CoroniumError({ code: "invalid_argument", message: `Proxy ${item.modemId} is listed twice.` });
    }
    seen.add(key);
  }
}

// The quote handler silently drops ids it does not recognise, so a partial
// quote must never be mistaken for the price of the whole basket.
function assertCompleteQuote(quote: RenewalQuote, items: RenewalItem[]): void {
  if (!Array.isArray(quote.line_items) || typeof quote.total_usd !== "number" || !Number.isFinite(quote.total_usd)) {
    throw new CoroniumError({ code: "invalid_response", message: "Renewal quote has no line items or USD total." });
  }
  for (const item of items) {
    const line = quote.line_items.find((row): boolean => sameText(String(row.modem_id), item.modemId));
    if (!line) {
      throw new CoroniumError({
        code: "incomplete_renewal_quote",
        message: `The quote does not include proxy ${item.modemId}. Check that you own it.`,
        suggestedAction: "list_proxies",
      });
    }
    if (line.days !== item.days) {
      throw new CoroniumError({
        code: "incomplete_renewal_quote",
        message: `The quote priced ${line.days} days for proxy ${item.modemId}, not ${item.days}.`,
      });
    }
  }
}

export function couponBody(coupon: string | undefined): Record<string, unknown> {
  if (!coupon) return {};
  return { coupon: { coupon_name: coupon } };
}

export function renewalModems(items: RenewalItem[]): Array<{ modem_id: string; days: number }> {
  return items.map((item: RenewalItem): { modem_id: string; days: number } => ({ modem_id: item.modemId, days: item.days }));
}

export class CatalogResource {
  constructor(private readonly transport: Transport) {}

  /** Countries with their carriers and regions. Listing does not mean stock. */
  async countries(): Promise<Country[]> {
    const result = await this.transport.call<unknown>(ROUTES.countries);
    return dataArray<Country>(result.body, "Countries");
  }

  /** Every plan, including ones with no stock. Use `availableTariffs` to shop. */
  async tariffs(): Promise<Tariff[]> {
    const result = await this.transport.call<unknown>(ROUTES.tariffs);
    return dataArray<Tariff>(result.body, "Tariffs");
  }

  /** Plans with stock right now (a cached snapshot, up to about 30 seconds old). */
  async availableTariffs(filter: TariffFilter = {}): Promise<AvailableTariff[]> {
    const result = await this.transport.call<unknown>(ROUTES.availableTariffs);
    const rows: AvailableTariff[] = dataArray<AvailableTariff>(result.body, "Available tariffs");
    return rows.filter((row: AvailableTariff): boolean => matchesTariff(row, filter));
  }

  /** Proxies in stock grouped by country, carrier and region, with names resolved. */
  async stock(filter: StockFilter = {}): Promise<StockEntry[]> {
    const [stockResult, countries] = await Promise.all([
      this.transport.call<unknown>(ROUTES.stock),
      this.countries(),
    ]);
    const rows: StockRow[] = dataArray<StockRow>(stockResult.body, "Stock");
    const entries: StockEntry[] = rows.map((row: StockRow): StockEntry => toStockEntry(row, countries));
    return entries.filter((entry: StockEntry): boolean => matchesStock(entry, filter));
  }

  /**
   * Price a renewal of proxies you own. Read-only: nothing is charged. A quote is
   * not a price lock. Throws `incomplete_renewal_quote` unless every proxy is
   * priced for exactly the requested days.
   */
  async renewalQuote(items: RenewalItem[], coupon?: string): Promise<RenewalQuote> {
    assertRenewalItems(items);
    const body: Record<string, unknown> = { modems: renewalModems(items), ...couponBody(coupon) };
    const result = await this.transport.call<unknown>(ROUTES.renewalQuote, { body });
    const quote: RenewalQuote = objectBody<RenewalQuote>(result.body, "Renewal quote");
    assertCompleteQuote(quote, items);
    return quote;
  }
}
