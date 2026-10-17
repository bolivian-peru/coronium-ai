// Human-facing copy for API errors. The structured `code` is kept as-is for
// --json consumers; this layer only adds a summary line and next-step hints.
// Codes are matched case-insensitively: the API mixes `no_stock` and `OUT_OF_STOCK`.

import kleur from "kleur";
import { CoroniumError } from "coronium-sdk";
import { EXIT_OUTCOME_UNKNOWN, EXIT_REFUNDED, EXIT_REJECTED, EXIT_USAGE, UsageError } from "./output.js";

export interface FormattedError {
  code: string;
  summary: string;
  hints: string[];
  status: number | null;
  outcome: string;
  exitCode: number;
  requestId: string | null;
  idempotencyKey: string | null;
  retryAfterSeconds: number | null;
}

interface Friendly {
  summary?: string;
  hints: string[];
}

const LOCAL_USAGE_CODES: ReadonlySet<string> = new Set(["invalid_argument", "not_authenticated", "spending_disabled", "invalid_configuration"]);

const FRIENDLY: Record<string, Friendly> = {
  auth_required: {
    summary: "The API token was rejected or is missing.",
    hints: ["Check CORONIUM_API_TOKEN, or run: coronium login --token <token>"],
  },
  not_authenticated: {
    hints: ["Create a token at dashboard.coronium.io (Account, API Access), then run: coronium login --token <token>"],
  },
  route_not_found: {
    summary: "The API does not have this route. The base URL is wrong or this CLI is out of date.",
    hints: ["Unset CORONIUM_BASE_URL to use https://api.coronium.io/api/v3, or upgrade: npm i -g coronium-cli@latest"],
  },
  invalid_response: {
    summary: "The API answered with something other than the expected JSON.",
    hints: ["Run: coronium status"],
  },
  no_stock: {
    summary: "That plan is out of stock right now.",
    hints: ["See what is in stock: coronium tariffs --country <CC>"],
  },
  out_of_stock: {
    summary: "That plan is out of stock right now.",
    hints: ["See what is in stock: coronium tariffs --country <CC>"],
  },
  insufficient_stock: {
    hints: ["Lower --count or pick another plan: coronium tariffs"],
  },
  tariff_unavailable: {
    hints: ["List plans on sale: coronium tariffs"],
  },
  insufficient_credit: {
    summary: "Not enough account credit for this order.",
    hints: ["Top up at dashboard.coronium.io, then try again."],
  },
  payment_in_progress: {
    summary: "Another payment on this account is still running.",
    hints: ["Wait a few seconds, then check: coronium proxy list"],
  },
  renewal_already_pending: {
    summary: "An earlier renewal of this proxy has not been delivered yet.",
    hints: ["Do not renew again. Check: coronium proxy list"],
  },
  price_changed: {
    hints: ["Run the quote again and approve the new total with --max-total."],
  },
  spending_disabled: {
    hints: ["Turn spending on with: coronium spending on (or set CORONIUM_ALLOW_SPENDING=1)"],
  },
  idempotency_conflict: {
    hints: ["Use a new --key for a new order."],
  },
  incomplete_renewal_quote: {
    hints: ["Check the proxy ids with: coronium proxy list"],
  },
  proxy_not_found: {
    hints: ["List your proxies: coronium proxy list"],
  },
  voucher_invalid: {
    summary: "That voucher is not valid.",
    hints: ["Vouchers are case-sensitive. Check for typos."],
  },
  voucher_already_consumed: {
    summary: "This voucher has already been used.",
    hints: ["If it was yours and you still have the wallet: coronium init --restore"],
  },
};

function friendlyFor(code: string): Friendly | undefined {
  return FRIENDLY[code.toLowerCase()];
}

function exitCodeFor(error: CoroniumError): number {
  if (error.outcome === "unknown") return EXIT_OUTCOME_UNKNOWN;
  if (error.outcome === "refunded_not_charged") return EXIT_REFUNDED;
  if (LOCAL_USAGE_CODES.has(error.code)) return EXIT_USAGE;
  return EXIT_REJECTED;
}

function outcomeHints(error: CoroniumError): string[] {
  const hints: string[] = [];
  if (error.outcome === "unknown") {
    hints.push("The result is unknown: it may have gone through. Check before trying again (coronium proxy list).");
  }
  if (error.outcome === "refunded_not_charged") {
    hints.push("Nothing was charged: the API refunded the order.");
  }
  if (error.isRateLimited && error.retryAfterSeconds !== undefined) {
    hints.push(`Rate limited. Wait ${error.retryAfterSeconds} seconds before trying again.`);
  }
  if (error.isRateLimited && error.retryAfterSeconds === undefined) {
    hints.push("Rate limited. Wait a minute before trying again.");
  }
  if (error.idempotencyKey) hints.push(`Idempotency key: ${error.idempotencyKey}`);
  if (error.requestId) hints.push(`Request id: ${error.requestId}`);
  return hints;
}

export function formatCoroniumError(error: CoroniumError): FormattedError {
  const friendly: Friendly | undefined = friendlyFor(error.code);
  return {
    code: error.code,
    summary: friendly?.summary ?? error.message,
    hints: [...(friendly?.hints ?? []), ...outcomeHints(error)],
    status: error.status ?? null,
    outcome: error.outcome,
    exitCode: exitCodeFor(error),
    requestId: error.requestId ?? null,
    idempotencyKey: error.idempotencyKey ?? null,
    retryAfterSeconds: error.retryAfterSeconds ?? null,
  };
}

export function formatUsageError(error: UsageError): FormattedError {
  return {
    code: "usage",
    summary: error.message,
    hints: error.hints,
    status: null,
    outcome: "rejected",
    exitCode: EXIT_USAGE,
    requestId: null,
    idempotencyKey: null,
    retryAfterSeconds: null,
  };
}

export function formatUnknownError(error: unknown): FormattedError {
  let message: string = String(error);
  if (error instanceof Error) message = error.message;
  return {
    code: "error",
    summary: message,
    hints: [],
    status: null,
    outcome: "rejected",
    exitCode: EXIT_REJECTED,
    requestId: null,
    idempotencyKey: null,
    retryAfterSeconds: null,
  };
}

export function printPretty(formatted: FormattedError): void {
  console.error(`${kleur.red(`error[${formatted.code}]`)} ${formatted.summary}`);
  for (const hint of formatted.hints) console.error(kleur.dim(`  ${hint}`));
}

export function printJsonError(formatted: FormattedError): void {
  console.log(JSON.stringify({ error: formatted }, null, 2));
}
