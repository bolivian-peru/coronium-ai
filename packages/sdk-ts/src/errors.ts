import type { ApiError } from "./types.js";

export class CoroniumError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: ApiError | undefined;

  constructor(status: number, body: ApiError | undefined, fallbackMessage: string) {
    super(body?.message || fallbackMessage);
    this.name = "CoroniumError";
    this.status = status;
    this.code = body?.code || `HTTP_${status}`;
    this.body = body;
  }
}

export class CoroniumStockOutError extends CoroniumError {
  readonly suggestions: Array<{ country: string; carrier: string; in_stock: number }>;

  constructor(status: number, body: ApiError, fallbackMessage: string) {
    super(status, body, fallbackMessage);
    this.name = "CoroniumStockOutError";
    const suggestion = (body as any)?.suggestion?.available_now;
    this.suggestions = Array.isArray(suggestion) ? suggestion : [];
  }
}
