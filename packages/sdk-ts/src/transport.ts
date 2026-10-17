// HTTP transport for /api/v3. The behaviour mirrors the coronium-proxy-mcp
// client, which is the one that has been proven against production:
//
// - no redirects: an authenticated request to a route that does not exist is
//   answered with 302 -> "/" and an HTML page. Following it turns every typo or
//   stale route into a fake success, so a 3xx is always `route_not_found`;
// - a 2xx must carry JSON (or plain text where the route returns a file); HTML
//   and empty bodies are `invalid_response`;
// - nothing is retried, mutations least of all;
// - the token travels only in the Authorization header, never in the URL.

import { CoroniumError, redact, type RequestOutcome } from "./errors.js";
import type { RouteSpec } from "./routes.js";
import { CONTRACT_ID, SDK_VERSION } from "./version.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  baseUrl: string;
  token: string | undefined;
  fetch: FetchLike;
  timeoutMs: number;
  userAgent: string | undefined;
}

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Accept a plain-text 2xx body (for file downloads such as OpenVPN profiles). */
  text?: boolean;
  /** Return a 2xx body that carries an `error` string instead of throwing. Diagnostic routes only. */
  allowErrorBody?: boolean;
}

export interface CallResult<T> {
  status: number;
  body: T;
  requestId: string | undefined;
  idempotencyKey: string | undefined;
}

interface ParsedBody {
  json: unknown;
  text: string;
}

type JsonObject = Record<string, unknown>;

const HTML_PATTERN: RegExp = /^\s*(?:<!doctype\s+html|<html|<head|<body|<h1)\b/i;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Validate and normalise a base URL. HTTPS only, except plain HTTP on loopback for tests. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError(`Base URL is not a valid URL: ${raw}`);
  }
  const loopback: boolean = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw configError("Base URL must use https (plain http is allowed only on localhost).");
  }
  if (url.username !== "" || url.password !== "") {
    throw configError("Base URL must not contain credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw configError("Base URL must not contain a query string or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function configError(message: string): CoroniumError {
  return new CoroniumError({ code: "invalid_configuration", message });
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fillPath(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/:([A-Za-z_]+)/g, (_match: string, name: string): string => {
    const value: string | undefined = params?.[name];
    if (value === undefined || value === "") {
      throw new CoroniumError({ code: "invalid_argument", message: `Missing path parameter "${name}".` });
    }
    return encodeURIComponent(value);
  });
}

function buildUrl(baseUrl: string, route: RouteSpec, options: CallOptions): string {
  const url: URL = new URL(baseUrl + fillPath(route.path, options.params));
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function acceptHeader(options: CallOptions): string {
  if (options.text) return "text/plain, application/x-openvpn-profile, application/octet-stream, application/json";
  return "application/json";
}

function buildHeaders(route: RouteSpec, options: CallOptions, transport: TransportOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: acceptHeader(options),
    "User-Agent": transport.userAgent ?? `coronium-sdk/${SDK_VERSION} (${CONTRACT_ID})`,
  };
  if (route.auth === "bearer" && transport.token) headers.Authorization = `Bearer ${transport.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  return headers;
}

function parseBody(text: string): ParsedBody {
  if (text.trim() === "") return { json: undefined, text };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

/** Retry-After may be seconds or an HTTP date; the body may also carry a number. */
function retryAfterSeconds(response: Response, body: JsonObject): number | undefined {
  const raw: unknown = response.headers.get("retry-after") ?? body.retry_after_seconds ?? body.retryAfter;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text: string = String(raw);
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const date: number = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function requestIdOf(response: Response, body: JsonObject): string | undefined {
  const fromBody: unknown = body.request_id ?? body.requestId;
  if (typeof fromBody === "string" && fromBody !== "") return fromBody;
  return response.headers.get("x-request-id") ?? undefined;
}

function failureOutcome(route: RouteSpec, status: number, body: JsonObject): RequestOutcome {
  if (body.refunded === true) return "refunded_not_charged";
  if (route.mutates && status >= 500) return "unknown";
  return "rejected";
}

function suggestedActionFor(outcome: RequestOutcome, body: JsonObject): string | undefined {
  if (outcome === "unknown") return "check_state_before_retrying";
  if (typeof body.suggested_action === "string") return body.suggested_action;
  return undefined;
}

function unconfirmedOutcome(route: RouteSpec): RequestOutcome {
  if (route.mutates) return "unknown";
  return "rejected";
}

function messageOf(body: JsonObject, status: number): string {
  if (typeof body.error === "string" && body.error !== "") return body.error;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  return `Coronium returned HTTP ${status}.`;
}

function codeOf(body: JsonObject, fallback: string): string {
  if (typeof body.code === "string" && body.code !== "") return body.code;
  return fallback;
}

export class Transport {
  constructor(private readonly options: TransportOptions) {}

  get hasToken(): boolean {
    return Boolean(this.options.token);
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** The bearer token, for callers that scope in-process state per account. */
  get token(): string | undefined {
    return this.options.token;
  }

  async call<T>(route: RouteSpec, options: CallOptions = {}): Promise<CallResult<T>> {
    if (route.auth === "bearer" && !this.options.token) {
      throw new CoroniumError({
        code: "not_authenticated",
        message: "This call needs an API token. Set CORONIUM_API_TOKEN or pass { token } to the client.",
        suggestedAction: "authenticate",
      });
    }
    const response: Response = await this.send(route, options);
    const parsed: ParsedBody = parseBody(await this.readText(response, route, options));
    return this.interpret<T>(route, options, response, parsed);
  }

  private async send(route: RouteSpec, options: CallOptions): Promise<Response> {
    const url: string = buildUrl(this.options.baseUrl, route, options);
    const init: RequestInit = {
      method: route.method,
      headers: buildHeaders(route, options, this.options),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs),
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    try {
      return await this.options.fetch(url, init);
    } catch (error) {
      throw this.networkError(route, options, error);
    }
  }

  private async readText(response: Response, route: RouteSpec, options: CallOptions): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.networkError(route, options, error);
    }
  }

  private networkError(route: RouteSpec, options: CallOptions, error: unknown): CoroniumError {
    const timedOut: boolean = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const outcome: RequestOutcome = unconfirmedOutcome(route);
    let code: string = "network_error";
    let message: string = "The request to Coronium did not complete. No automatic retry was made.";
    if (timedOut) {
      code = "timeout";
      message = "The request to Coronium timed out. No automatic retry was made.";
    }
    return new CoroniumError({
      code,
      message,
      outcome,
      suggestedAction: suggestedActionFor(outcome, {}),
      idempotencyKey: options.idempotencyKey,
    });
  }

  private interpret<T>(route: RouteSpec, options: CallOptions, response: Response, parsed: ParsedBody): CallResult<T> {
    const status: number = response.status;
    if (status >= 300 && status < 400) {
      // The route does not exist on this server, so nothing was applied.
      throw new CoroniumError({
        status,
        code: "route_not_found",
        message: `Coronium has no ${route.method} ${route.path} route at ${this.options.baseUrl}. Check the base URL or upgrade the SDK.`,
        outcome: "rejected",
        idempotencyKey: options.idempotencyKey,
      });
    }
    if (status < 200 || status >= 300) {
      throw this.httpError(route, options, response, parsed);
    }
    return this.success<T>(route, options, response, parsed);
  }

  private httpError(route: RouteSpec, options: CallOptions, response: Response, parsed: ParsedBody): CoroniumError {
    const body: JsonObject = isObject(parsed.json) ? parsed.json : {};
    const outcome: RequestOutcome = failureOutcome(route, response.status, body);
    return new CoroniumError({
      status: response.status,
      code: codeOf(body, `http_${response.status}`),
      message: messageOf(body, response.status),
      outcome,
      suggestedAction: suggestedActionFor(outcome, body),
      requestId: requestIdOf(response, body),
      retryAfterSeconds: retryAfterSeconds(response, body),
      idempotencyKey: options.idempotencyKey,
      details: redact(body),
    });
  }

  private success<T>(route: RouteSpec, options: CallOptions, response: Response, parsed: ParsedBody): CallResult<T> {
    const body: unknown = this.successBody(route, options, response, parsed);
    const requestId: string | undefined = requestIdOf(response, isObject(body) ? body : {});
    return { status: response.status, body: body as T, requestId, idempotencyKey: options.idempotencyKey };
  }

  private successBody(route: RouteSpec, options: CallOptions, response: Response, parsed: ParsedBody): unknown {
    if (parsed.json === undefined) {
      const isText: boolean = options.text === true && parsed.text.trim() !== "" && !HTML_PATTERN.test(parsed.text);
      if (isText) return parsed.text;
      throw this.invalidResponse(route, options, response.status, "Coronium returned an empty or non-JSON response.");
    }
    const body: unknown = parsed.json;
    // Some legacy handlers report a refusal as HTTP 200 with an error string.
    if (isObject(body) && typeof body.error === "string" && body.error !== "" && !options.allowErrorBody) {
      const outcome: RequestOutcome = unconfirmedOutcome(route);
      throw new CoroniumError({
        status: response.status,
        code: codeOf(body, "upstream_rejected"),
        message: body.error,
        outcome,
        suggestedAction: suggestedActionFor(outcome, body),
        requestId: requestIdOf(response, body),
        idempotencyKey: options.idempotencyKey,
        details: redact(body),
      });
    }
    return body;
  }

  private invalidResponse(route: RouteSpec, options: CallOptions, status: number, message: string): CoroniumError {
    const outcome: RequestOutcome = unconfirmedOutcome(route);
    return new CoroniumError({
      status,
      code: "invalid_response",
      message,
      outcome,
      suggestedAction: suggestedActionFor(outcome, {}),
      idempotencyKey: options.idempotencyKey,
    });
  }
}

/** Shared guard for list endpoints that wrap rows in `{ data: [...] }`. */
export function dataArray<T>(body: unknown, label: string, outcome: RequestOutcome = "rejected"): T[] {
  const rows: unknown = isObject(body) ? body.data : undefined;
  if (!Array.isArray(rows)) {
    throw new CoroniumError({ code: "invalid_response", message: `${label} did not return a data array.`, outcome });
  }
  return rows as T[];
}

/** Shared guard for endpoints that must return a JSON object. */
export function objectBody<T>(body: unknown, label: string, outcome: RequestOutcome = "rejected"): T {
  if (!isObject(body)) {
    throw new CoroniumError({ code: "invalid_response", message: `${label} did not return a JSON object.`, outcome });
  }
  return body as T;
}
