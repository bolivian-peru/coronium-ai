// In-memory state for the mock server. No persistence, resets on restart.

export interface MockProxy {
  id: string;
  host: string;
  port_http: number;
  port_socks5: number;
  username: string;
  password: string;
  country: string;
  region: string;
  carrier: string;
  type: "4g" | "5g";
  ip: string;
  os: string;
  created_at: string;
  expires_at: string;
  rotate_url: string;
  price_per_hour_usdc: string;
  rotation_policy: string;
  _ownerKey: string;
  _hourly_rate_usd: number;
  _bought_at_ms: number;
}

export interface MockAccount {
  account_id: string;
  api_key: string;
  email?: string;
  balance_usd: number;
  daily_spend_cap_usd: number;
  spend_today_usd: number;
  deposit_address_usdc_base: string;
}

export const accounts = new Map<string, MockAccount>(); // api_key → account
export const proxies = new Map<string, MockProxy>(); // id → proxy

export function genId(prefix: string, len = 12): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${out}`;
}

export function genApiKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "sk_live_";
  for (let i = 0; i < 40; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function genEthAddress(): string {
  const chars = "0123456789abcdef";
  let out = "0x";
  for (let i = 0; i < 40; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function genIPv4(): string {
  return [
    24 + Math.floor(Math.random() * 200),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    1 + Math.floor(Math.random() * 254),
  ].join(".");
}

// Stock catalog — keep small but representative.
export const TARIFFS = [
  { id: "trf_us_tmobile_5g", country: "US", region: "US-East", carrier: "T-Mobile", type: "5g" as const, period_hours: 24, price_usd: 0.48 },
  { id: "trf_us_verizon_4g", country: "US", region: "US-West", carrier: "Verizon", type: "4g" as const, period_hours: 24, price_usd: 0.48 },
  { id: "trf_gb_three_5g", country: "GB", region: "GB-London", carrier: "Three", type: "5g" as const, period_hours: 24, price_usd: 0.48 },
  { id: "trf_de_o2_4g", country: "DE", region: "DE-Berlin", carrier: "O2", type: "4g" as const, period_hours: 24, price_usd: 0.48 },
  { id: "trf_pl_play_4g", country: "PL", region: "PL-Warsaw", carrier: "Play", type: "4g" as const, period_hours: 24, price_usd: 0.48 },
  { id: "trf_es_movistar_4g", country: "ES", region: "ES-Madrid", carrier: "Movistar", type: "4g" as const, period_hours: 24, price_usd: 0.48 },
];

// Stock simulation: country/carrier → in-stock count. Decremented on buy, replenished
// when proxies are released.
export const stock = new Map<string, number>();
for (const t of TARIFFS) {
  stock.set(`${t.country}/${t.carrier}`, 20);
}
