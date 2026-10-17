import { AccountResource } from "./resources/account.js";
import { CatalogResource } from "./resources/catalog.js";
import { ProxiesResource } from "./resources/proxies.js";
import { SpendingResource } from "./resources/spending.js";
import { TicketsResource } from "./resources/tickets.js";
import { WalletResource } from "./resources/wallet.js";
import { WebhookResource } from "./resources/webhook.js";
import { normalizeBaseUrl, Transport, type FetchLike } from "./transport.js";
import { DEFAULT_BASE_URL } from "./version.js";

export interface CoroniumOptions {
  /** API token from dashboard.coronium.io (Account, API Access). Not needed for the public catalog. */
  token?: string;
  /** Defaults to https://api.coronium.io/api/v3. HTTPS only, except http://localhost for tests. */
  baseUrl?: string;
  /**
   * Turn on the methods that charge money (`spending.buy`, `spending.renew`).
   * Off by default.
   */
  allowSpending?: boolean;
  /** Timeout for ordinary calls. Default 30 seconds. */
  timeoutMs?: number;
  /** Timeout for rotate, replace and test, which wait for the device. Default 180 seconds. */
  actionTimeoutMs?: number;
  /** Timeout for purchases and renewals. Default 180 seconds. */
  purchaseTimeoutMs?: number;
  /** Custom fetch (for tests or proxies). Defaults to the global fetch. */
  fetch?: FetchLike;
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS: number = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS: number = 180_000;
const DEFAULT_PURCHASE_TIMEOUT_MS: number = 180_000;

function defaultFetch(): FetchLike {
  return (input: string, init: RequestInit): Promise<Response> => globalThis.fetch(input, init);
}

/**
 * Typed client for the Coronium mobile proxy API (/api/v3).
 *
 * ```ts
 * const coronium = new Coronium({ token: process.env.CORONIUM_API_TOKEN });
 * const proxies = await coronium.proxies.list();
 * ```
 */
export class Coronium {
  readonly account: AccountResource;
  readonly catalog: CatalogResource;
  readonly proxies: ProxiesResource;
  readonly tickets: TicketsResource;
  readonly webhook: WebhookResource;
  readonly wallet: WalletResource;
  /** Methods that charge money. Disabled unless `allowSpending: true`. */
  readonly spending: SpendingResource;
  readonly baseUrl: string;

  constructor(options: CoroniumOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    const transport: Transport = new Transport({
      baseUrl: this.baseUrl,
      token: options.token,
      fetch: options.fetch ?? defaultFetch(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      userAgent: options.userAgent,
    });
    this.account = new AccountResource(transport);
    this.catalog = new CatalogResource(transport);
    this.proxies = new ProxiesResource(transport, options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
    this.tickets = new TicketsResource(transport);
    this.webhook = new WebhookResource(transport);
    this.wallet = new WalletResource(transport);
    this.spending = new SpendingResource(
      transport,
      this.catalog,
      options.allowSpending === true,
      options.purchaseTimeoutMs ?? DEFAULT_PURCHASE_TIMEOUT_MS,
    );
  }
}
