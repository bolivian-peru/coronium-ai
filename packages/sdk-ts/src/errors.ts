/**
 * What the caller can conclude about a request that failed.
 *
 * - `rejected`: the API refused it, or it never left this process. Nothing changed.
 * - `unknown`: a mutation may or may not have been applied (5xx, timeout, network
 *   error, or a 2xx without the expected confirmation). Check state before retrying.
 * - `refunded_not_charged`: a purchase failed and the API reports the debit was
 *   refunded in the same response.
 */
export type RequestOutcome = "rejected" | "unknown" | "refunded_not_charged";

export interface CoroniumErrorInit {
  status?: number;
  code: string;
  message: string;
  outcome?: RequestOutcome;
  suggestedAction?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  idempotencyKey?: string;
  details?: unknown;
}

export class CoroniumError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly outcome: RequestOutcome;
  readonly suggestedAction: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly idempotencyKey: string | undefined;
  readonly details: unknown;

  constructor(init: CoroniumErrorInit) {
    super(init.message);
    this.name = "CoroniumError";
    this.status = init.status;
    this.code = init.code;
    this.outcome = init.outcome ?? "rejected";
    this.suggestedAction = init.suggestedAction;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.idempotencyKey = init.idempotencyKey;
    this.details = init.details;
  }

  /**
   * Rate limits are classified by HTTP status, never by `code`: the API rewrites
   * several rate-limit codes to generic ones before they reach the client.
   */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isOutcomeUnknown(): boolean {
    return this.outcome === "unknown";
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      outcome: this.outcome,
      suggested_action: this.suggestedAction,
      request_id: this.requestId,
      retry_after_seconds: this.retryAfterSeconds,
      idempotency_key: this.idempotencyKey,
    };
  }
}

export function isCoroniumError(value: unknown): value is CoroniumError {
  return value instanceof CoroniumError;
}

const SECRET_KEY_PATTERN: RegExp = /password|token|authorization|secret|signature|api.?key/i;

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:auth_token|token|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}

/** Remove tokens, passwords and credential URLs before an error body is kept. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}
