// Every HTTP call the SDK makes goes through one entry of this table, so the
// route-coverage test can prove each one exists on the real /api/v3 router.
// Paths are relative to the base URL and use `:name` for path parameters.

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type RouteAuth = "public" | "bearer";

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  auth: RouteAuth;
  /** True when the call can change state. Mutations are never retried. */
  mutates: boolean;
  /** True when the call debits money. Gated behind `allowSpending`. */
  spends: boolean;
}

function read(method: HttpMethod, path: string, auth: RouteAuth): RouteSpec {
  return { method, path, auth, mutates: false, spends: false };
}

function write(method: HttpMethod, path: string, auth: RouteAuth): RouteSpec {
  return { method, path, auth, mutates: true, spends: false };
}

function spend(path: string): RouteSpec {
  return { method: "POST", path, auth: "bearer", mutates: true, spends: true };
}

export const ROUTES = {
  // account
  accountGet: read("GET", "/account", "bearer"),
  // Creates BTC and USDT deposit wallets on the first call, so it counts as a write.
  accountCryptoBalance: write("GET", "/account/crypto-balance", "bearer"),
  paymentStatus: read("GET", "/payments/:id/status", "bearer"),

  // catalog
  countries: read("GET", "/countries", "public"),
  tariffs: read("GET", "/tariffs", "public"),
  availableTariffs: read("GET", "/tariffs/available", "public"),
  stock: read("GET", "/free-modems", "public"),
  // A POST, but read-only: it prices a renewal without charging.
  renewalQuote: read("POST", "/payment/renewal-quote", "bearer"),

  // proxies
  proxiesList: read("GET", "/account/proxies", "bearer"),
  proxyRestart: write("POST", "/modems/:id/restart", "bearer"),
  proxyRotationStatus: read("GET", "/modems/:id/rotation-status", "bearer"),
  // A GET that rotates the IP. Never prefetch or unfurl this URL.
  proxyRotateByToken: write("GET", "/modems/rotate-modem-by-token/:token", "public"),
  proxyReplace: write("POST", "/modems/:id/replace", "bearer"),
  // Issues a new certificate or a one-time download on some providers.
  proxyOpenVpn: write("GET", "/modems/:id/openvpn", "bearer"),
  proxyTest: write("POST", "/modems/:id/test", "bearer"),
  proxySetWhitelist: write("PUT", "/modems/:id/set-white-list", "bearer"),

  // tickets
  ticketsList: read("GET", "/tickets", "bearer"),
  ticketsGet: read("GET", "/tickets/:id", "bearer"),
  ticketsCreate: write("POST", "/tickets", "bearer"),
  ticketsReply: write("POST", "/tickets/:id/reply", "bearer"),
  ticketsArchive: write("PUT", "/tickets/:id/archive", "bearer"),

  // webhook
  webhookGet: read("GET", "/account/webhook", "bearer"),
  webhookSet: write("PUT", "/account/webhook", "bearer"),
  webhookDelete: write("DELETE", "/account/webhook", "bearer"),
  webhookRotateSecret: write("POST", "/account/webhook/secret/rotate", "bearer"),
  webhookTest: write("POST", "/account/webhook/test", "bearer"),

  // wallet (SIWE) sign-up and key rotation; signing happens outside the SDK
  walletChallenge: write("POST", "/wallet-challenge", "public"),
  walletSignup: write("POST", "/wallet-signup", "public"),
  walletRotateChallenge: write("POST", "/wallet-key/rotate-challenge", "bearer"),
  walletRotate: write("POST", "/wallet-key/rotate", "bearer"),

  // spending (charges money)
  buyWithAccountCredit: spend("/payment/buy-with-account-credit"),
  renewWithAccountCredit: spend("/payment/renew-with-account-credit"),
  buyWithBtc: spend("/payment/buy-modems-with-crypto-balance"),
  renewWithBtc: spend("/payment/renew-modems-with-crypto-balance"),
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;
