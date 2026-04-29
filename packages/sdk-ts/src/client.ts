import { CoroniumError, CoroniumStockOutError } from "./errors.js";
import type {
  AccountCreated,
  Balance,
  BuyProxyRequest,
  Chain,
  CoroniumClientOptions,
  DepositAddress,
  Proxy,
  RotateResult,
  Tariff,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.coronium.ai/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "coronium-sdk-ts/0.1.0";

/**
 * Backoff delays (ms) for retried requests. ±15% jitter applied per attempt.
 * Total worst-case retry budget = sum + jitter ≈ 4.6 s before final failure.
 */
const RETRY_DELAYS_MS = [200, 800, 3200];

/** HTTP status codes that warrant a retry on idempotent requests. */
const RETRIABLE_STATUSES = new Set([502, 503, 504]);

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  costCapCents?: number;
  unauthenticated?: boolean;
  /**
   * Whether the operation is safe to retry on transient failure. GET, DELETE,
   * and rotate are safe (idempotent or near-idempotent). POST /proxies (buys)
   * and POST /proxies/:id/replace (creates new proxy) are not — never retry
   * them, since a successful-but-disconnected first attempt would result in
   * a duplicate charge / duplicate provisioning.
   */
  idempotent?: boolean;
}

export class Coronium {
  readonly account = {
    create: (input?: { email?: string }): Promise<AccountCreated> =>
      this.request<AccountCreated>({
        method: "POST",
        path: "/account/create",
        body: input ?? {},
        unauthenticated: true,
        // Account creation is idempotent server-side (returns existing on retry)
        // and the cost of a duplicate is bounded ($0.50 trial credit).
        idempotent: true,
      }),
  };

  readonly balance = {
    get: (): Promise<Balance> =>
      this.request<Balance>({ method: "GET", path: "/balance", idempotent: true }),
  };

  readonly deposit = {
    address: (input?: { chain?: Chain; amount_usd?: number }): Promise<DepositAddress> =>
      this.request<DepositAddress>({
        method: "POST",
        path: "/deposit/address",
        body: input ?? {},
        idempotent: true, // returns existing address; safe to retry
      }),
  };

  readonly tariffs = {
    list: (input?: { country?: string; carrier?: string; type?: "4g" | "5g" }): Promise<Tariff[]> =>
      this.request<Tariff[]>({ method: "GET", path: "/tariffs", query: input, idempotent: true }),
  };

  readonly proxies = {
    list: (): Promise<Proxy[]> =>
      this.request<Proxy[]>({ method: "GET", path: "/proxies", idempotent: true }),

    buy: (input: BuyProxyRequest, opts?: { costCapCents?: number }): Promise<Proxy[]> =>
      this.request<Proxy[]>({
        method: "POST",
        path: "/proxies",
        body: input,
        costCapCents: opts?.costCapCents,
        idempotent: false, // SPENDS MONEY — never retry
      }),

    release: (id: string): Promise<void> =>
      this.request<void>({
        method: "DELETE",
        path: `/proxies/${encodeURIComponent(id)}`,
        idempotent: true, // second DELETE is just 404
      }),

    rotate: (id: string): Promise<RotateResult> =>
      this.request<RotateResult>({
        method: "POST",
        path: `/proxies/${encodeURIComponent(id)}/rotate`,
        idempotent: true, // rotating twice is fine; carrier responds the same
      }),

    replace: (id: string): Promise<Proxy> =>
      this.request<Proxy>({
        method: "POST",
        path: `/proxies/${encodeURIComponent(id)}/replace`,
        idempotent: false, // creates a new proxy each call
      }),
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly costCapCents: number | undefined;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(opts: CoroniumClientOptions) {
    if (!opts.apiKey) throw new Error("Coronium: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    if (!this.fetch) {
      throw new Error("Coronium: no fetch implementation available; pass `fetch` in options");
    }
    this.costCapCents = opts.costCapCents;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const idempotent = opts.idempotent ?? false;
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.requestOnce<T>(opts);
      } catch (e) {
        lastError = e;
        if (!idempotent || attempt === RETRY_DELAYS_MS.length || !isRetriable(e)) {
          throw e;
        }
        const baseDelay = RETRY_DELAYS_MS[attempt]!;
        const jitter = 0.85 + Math.random() * 0.3; // 0.85x..1.15x
        await sleep(Math.round(baseDelay * jitter));
      }
    }
    throw lastError;
  }

  private async requestOnce<T>({
    method,
    path,
    body,
    query,
    costCapCents,
    unauthenticated,
  }: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
    };
    if (!unauthenticated) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const cap = costCapCents ?? this.costCapCents;
    if (cap !== undefined) headers["X-Cost-Cap-Cents"] = String(cap);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TimeoutError("timeout")), this.timeoutMs);

    try {
      const res = await this.fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;

      if (!res.ok) {
        const errBody = (parsed && typeof parsed === "object" ? parsed : undefined) as
          | { code?: string; message?: string }
          | undefined;
        const msg = `Coronium ${method} ${path} -> ${res.status}`;
        if (errBody?.code === "STOCK_OUT") {
          throw new CoroniumStockOutError(res.status, errBody as any, msg);
        }
        throw new CoroniumError(res.status, errBody as any, msg);
      }

      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Internal: marker for our own timeout aborts vs caller-driven aborts. */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function isRetriable(e: unknown): boolean {
  // Network-level errors — retry.
  if (e instanceof TimeoutError) return true;
  if (e instanceof Error) {
    // Node fetch wraps the system error in `cause`.
    const cause = (e as Error & { cause?: { code?: string } }).cause;
    const code = cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
      return true;
    }
    // The actual node fetch error names.
    if (e.name === "TypeError" && /fetch failed|network/i.test(e.message)) return true;
    // Don't retry caller-driven aborts.
    if (e.name === "AbortError" && !(e instanceof TimeoutError)) return false;
  }
  // 502/503/504 with idempotent=true — retry. (4xx never; 500 deliberately not, since it could be a partial mutation.)
  if (e instanceof CoroniumError && RETRIABLE_STATUSES.has(e.status)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
