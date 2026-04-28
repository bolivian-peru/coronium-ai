// Hand-authored to mirror coronium-ai/openapi.yaml. Regenerate from spec
// once we wire openapi-typescript into CI; for now, the spec is the contract
// and this file is the reflection of it.

export type Country = string; // ISO-3166 alpha-2, e.g. "US"
export type ProxyType = "4g" | "5g";
export type Chain = "base" | "tron" | "ethereum";

export type RotationPolicy =
  | "manual"
  | "every_5m"
  | "every_10m"
  | "every_30m"
  | "every_1h"
  | "sticky_session";

export type OsFingerprint =
  | ""
  | "android:1"
  | "android:3"
  | "ios:1"
  | "ios:2"
  | "macosx:3"
  | "macosx:4"
  | "windows:1";

export interface AccountCreated {
  account_id: string;
  api_key: string;
  deposit_address_usdc_base: string;
  balance_usd: number;
  daily_spend_cap_usd: number;
}

export interface Balance {
  usdc: string;
  hours_at_current_burn: string;
  active_proxies: number;
  spend_today_usd: number;
  daily_cap_usd: number;
  session_cap_usd: number;
}

export interface DepositAddress {
  chain: Chain;
  address: string;
  qr: string;
  expires_at: string;
  amount_usd: number | null;
}

export interface Tariff {
  id: string;
  country: Country;
  carrier: string;
  type: ProxyType;
  period_hours: number;
  price_usd: number;
  in_stock: boolean;
}

export interface BuyProxyRequest {
  country: Country;
  type?: ProxyType;
  carrier?: string;
  qty?: number;
  ttl?: string;
  rotation?: string;
  sticky?: boolean;
  os?: OsFingerprint;
}

export interface Proxy {
  id: string;
  host: string;
  port_http: number;
  port_socks5: number;
  username: string;
  password: string;
  country: Country;
  region?: string;
  carrier: string;
  type: ProxyType;
  ip: string;
  os?: OsFingerprint;
  created_at: string;
  expires_at: string;
  rotate_url: string;
  price_per_hour_usdc: string;
  rotation_policy: RotationPolicy;
}

export interface RotateResult {
  ip_before: string;
  ip_after: string;
  duration_ms: number;
}

export interface StockOutError {
  code: "STOCK_OUT";
  message: string;
  country: Country;
  carrier?: string;
  suggestion?: {
    available_now: Array<{
      country: Country;
      carrier: string;
      in_stock: number;
    }>;
  };
}

export interface ApiError {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface CoroniumClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  costCapCents?: number;
  userAgent?: string;
  timeoutMs?: number;
}
