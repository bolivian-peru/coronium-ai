// Response and request types for /api/v3, written by hand from the verified
// route contract (not from the public OpenAPI file, which is missing routes and
// has wrong shapes for several). Fields the API may add later pass through.

// ---------- account ----------

export interface AccountInfo {
  _id: string;
  name?: string;
  login?: string;
  /** USD account credit. Refunds and balance top-ups land here. */
  accountCredit: number;
  btc?: { balance: number };
  usdt?: { balance: number };
  proxyCount?: number;
  [key: string]: unknown;
}

export type CryptoCoin = "btc" | "usdt" | "account_credit";

export interface CryptoBalance {
  coin: CryptoCoin | string;
  balance: number;
  /** Deposit address: BTC, or USDT on TRC-20. Absent for account credit. */
  address?: string;
}

export interface PaymentStatus {
  _id: string;
  status: string;
  isConfirmed?: boolean;
  /** Seconds or milliseconds since the epoch; the API mixes both. */
  createdAt?: number;
  lastError?: string | null;
  modems?: OwnedProxy[];
  [key: string]: unknown;
}

// ---------- catalog ----------

export interface Carrier {
  _id: string;
  name: string;
  code?: string;
}

export interface Region {
  _id: string;
  name: string;
  code?: string;
}

export interface Country {
  _id: string;
  name: string;
  country_code: string;
  description?: string;
  carriers: Carrier[];
  regions: Region[];
  [key: string]: unknown;
}

export type TariffPeriod = "day" | "week" | "month";

export interface Tariff {
  _id: string;
  name: string;
  period: TariffPeriod;
  /** USD per proxy for one period. */
  price: number;
  isShared: boolean;
  country_id: string;
  country_name: string;
  country_code: string;
  carrier_id: string | null;
  carrier_name: string | null;
  [key: string]: unknown;
}

export interface FeatureCount {
  count: number;
  all: boolean;
}

export interface AvailableTariff extends Tariff {
  carrier_id: string;
  carrier_name: string;
  /** Proxies currently in stock for this plan. Always above 0 on this endpoint. */
  stock: number;
  ip_stack?: { ipv4: number; ipv6: number; native_ipv6: boolean };
  features?: { p0f?: FeatureCount; openvpn?: FeatureCount; ipv6_native?: boolean };
}

export interface StockRow {
  country_id: string;
  carrier_id: string;
  region_id: string | null;
  count: number;
}

export interface StockEntry {
  countryId: string;
  countryCode: string | null;
  countryName: string | null;
  carrierId: string;
  carrierName: string | null;
  regionId: string | null;
  regionName: string | null;
  count: number;
}

export interface RenewalLine {
  modem_id: string;
  name?: string;
  days: number;
  plan?: string;
  pricing_basis?: string;
  unit_price_usd?: number;
  tariff_id?: string;
  country_id?: string;
  carrier_id?: string;
  kind?: string;
  quantity?: number;
  line_total_usd: number;
  [key: string]: unknown;
}

export interface RenewalQuote {
  currency: "USD";
  subtotal_usd: number;
  discount_usd: number;
  total_usd: number;
  total_cents?: number;
  coupon: { name: string; value: string | number } | null;
  line_items: RenewalLine[];
  [key: string]: unknown;
}

export interface RenewalItem {
  modemId: string;
  /** 1 to 90 days. */
  days: number;
}

// ---------- proxies ----------

export interface ProxyEndpoint {
  host: string;
  port: number | string;
  username: string;
  password: string;
}

export interface ProxyEndpoints {
  provider?: string;
  credentials?: string;
  http?: ProxyEndpoint;
  socks5?: ProxyEndpoint;
  capabilities?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface OwnedProxy {
  _id: string;
  name: string;
  carrier_id?: string | null;
  carrier?: Carrier | null;
  country_id?: string;
  region_id?: string | null;
  tariff_id?: string;
  isOnline?: boolean;
  ext_ip?: string | null;
  ip_address?: string;
  connection_ip?: string;
  http_port: string | number;
  socks_port: string | number;
  proxy_login: string;
  proxy_password: string;
  rotation_interval?: number;
  rotated_at?: number | null;
  white_list?: string[];
  metadata?: string;
  /** Expiry in milliseconds since the epoch. */
  tariff_expired_at?: number;
  /** Present for providers that issue separate HTTP and SOCKS5 logins. */
  proxyEndpoints?: ProxyEndpoints;
  portId?: string;
  [key: string]: unknown;
}

export interface RestartResponse {
  result?: string;
  rotated?: boolean;
  pending?: boolean;
  accepted?: boolean;
  ip?: string | null;
  ext_ip?: string | null;
  new_ip?: string;
  message?: string;
  state?: string;
  status_url?: string;
  retry_after_seconds?: number;
  [key: string]: unknown;
}

/**
 * - `done`: the IP changed.
 * - `rotating`: accepted and still running; poll `rotationStatus`, do not resubmit.
 * - `unchanged`: the rotation ran but the carrier kept the same IP. Connections
 *   still dropped. Retry after the cooldown rather than replacing the proxy.
 */
export type RotationResult =
  | { state: "done"; ip: string | null; response: RestartResponse }
  | { state: "rotating"; statusUrl: string | null; retryAfterSeconds: number | null; response: RestartResponse }
  | { state: "unchanged"; ip: string | null; message: string | null; response: RestartResponse };

export type RotationState = "idle" | "rotating" | "done" | "failed";

export interface RotationStatus {
  modemId?: string;
  name?: string;
  state: RotationState | string;
  ext_ip: string | null;
  rotated_at: number | null;
  reset_started?: number | null;
  reset_error?: string | null;
  elapsedMs?: number | null;
  hint?: string | null;
  [key: string]: unknown;
}

export interface ReplaceResult {
  oldModemId: string | null;
  newModemId: string | null;
  /** May be null when the API confirms the swap but cannot read the new proxy yet. */
  newModem: ReplacedProxy | null;
}

export interface ReplacedProxy {
  _id: string;
  name?: string;
  host?: string;
  country_code?: string;
  carrier_id?: string;
  http_port: string | number;
  socks_port: string | number;
  proxy_login: string;
  proxy_password: string;
  tariff_expired_at?: number;
  isOnline?: boolean;
  [key: string]: unknown;
}

export interface ProxyTestResult {
  /** True only when the API reports the proxy answered. */
  ok: boolean;
  extIp: string | null;
  error: string | null;
  requestTime: number | null;
  response: unknown;
}

export interface WhitelistResult {
  result: string;
  data?: unknown;
  [key: string]: unknown;
}

// ---------- tickets ----------

export type TicketStatus = "open" | "pending" | "resolved" | "closed";

export interface TicketMessage {
  text: string;
  isAdmin: boolean;
  authorName?: string;
  createdAt?: string | number;
  [key: string]: unknown;
}

export interface Ticket {
  _id: string;
  subject: string;
  category?: string;
  status: TicketStatus | string;
  messages: TicketMessage[];
  relatedProxies?: string[];
  createdAt?: string | number;
  updatedAt?: string | number;
  closedAt?: string | number | null;
  isArchivedByUser?: boolean;
  [key: string]: unknown;
}

export interface TicketPage {
  tickets: Ticket[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateTicketInput {
  subject: string;
  message: string;
  category?: string;
  relatedProxies?: string[];
}

// ---------- webhook ----------

export interface WebhookSettings {
  webhook_url: string | null;
  enabled: boolean;
  auto_replace_dead_proxies?: boolean;
  secret?: { exists: boolean; preview: string | null; created_at: string | number | null };
  signing?: string;
  signature?: Record<string, unknown>;
  events?: unknown[];
  message?: string;
  [key: string]: unknown;
}

export interface WebhookSecret {
  /** Shown once. Store it now; the API will not return it again. */
  secret: string;
  preview?: string;
  created_at?: string | number;
  rotated?: boolean;
  warning?: string;
  [key: string]: unknown;
}

export interface WebhookTestResult {
  delivered: boolean;
  url?: string;
  event_id?: string;
  status_code: number | null;
  latency_ms?: number;
  error: string | null;
  response_preview?: string | null;
  hint?: string;
  [key: string]: unknown;
}

// ---------- wallet (SIWE) ----------

export interface WalletChallenge {
  /** The SIWE message to sign. */
  message: string;
  nonce: string;
  expires_in_s: number;
}

export interface WalletSignupResult {
  api_token: string;
  user_id: string;
  wallet_address: string;
  balance_usd: number;
}

export interface WalletRotateResult {
  api_token: string;
}

// ---------- spending ----------

export type FundingSource = "account_credit" | "btc";

export interface BuyQuote {
  tariff: AvailableTariff;
  quantity: number;
  /** price x quantity, before any coupon. */
  totalUsd: number;
}

export interface BuyInput {
  tariffId: string;
  quantity: number;
  funding: FundingSource;
  /**
   * The total the user approved, in USD. Required. The SDK refuses to send the
   * order when a fresh quote is higher. Coupons do not lower this check: the API
   * can charge full price when a coupon is used up.
   */
  expectedTotalUsd: number;
  /** Reuse only when reconciling the same order. Generated when omitted. */
  idempotencyKey?: string;
  coupon?: string;
  metadata?: string;
  wantP0f?: boolean;
}

export interface RenewInput {
  items: RenewalItem[];
  funding: FundingSource;
  /** The total the user approved, in USD. Required; checked against a fresh renewal quote. */
  expectedTotalUsd: number;
  idempotencyKey?: string;
  coupon?: string;
}

export interface SpendReceipt {
  /**
   * - `delivered`: the API answered 200 and returned as many proxies as ordered.
   * - `unverified`: 200, but the proxy count does not match. Do not order again;
   *   reconcile with `account.payment` or `proxies.list`.
   * - `processing`: 202, still running. Poll `account.payment(paymentId)`.
   */
  status: "delivered" | "unverified" | "processing";
  funding: FundingSource;
  idempotencyKey: string;
  requestId: string | undefined;
  paymentId: string | null;
  chargedUsd: number | null;
  approvedTotalUsd: number;
  quotedTotalUsd: number;
  requestedCount: number;
  deliveredCount: number;
  proxies: OwnedProxy[];
  response: unknown;
}
