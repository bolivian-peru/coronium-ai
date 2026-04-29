// Map stable error codes from the API → friendlier human-facing copy.
// The structured `code` field stays unchanged for programmatic consumers
// (SDK callers, the platform). This module is purely the human display layer.
//
// Keep messages:
//   - actionable (suggest exactly which command to run next)
//   - blame-free (no "you did X wrong" — just "here's the path forward")
//   - bounded (~3 lines max)

import kleur from "kleur";
import { CoroniumError, CoroniumStockOutError } from "coronium-sdk";

interface Friendly {
  /** Single-line summary, shown after the red "error[CODE]" prefix. */
  summary: string;
  /** Optional follow-up hint(s). Each line is rendered in dim grey. */
  hints?: string[];
}

const MAP: Record<string, (e: CoroniumError) => Friendly> = {
  VOUCHER_NOT_FOUND: () => ({
    summary: "That voucher doesn't exist.",
    hints: [
      "Check for typos. Vouchers are case-sensitive.",
      "Get a fresh voucher at https://coronium.ai/free.",
    ],
  }),

  VOUCHER_CONSUMED: () => ({
    summary: "This voucher's already been used.",
    hints: [
      "If that was you and you lost your account: coronium init --restore  (uses your wallet/seed)",
      "Otherwise, get a new voucher at https://coronium.ai/free",
    ],
  }),

  VOUCHER_EXPIRED: () => ({
    summary: "This voucher expired.",
    hints: ["Get a fresh voucher at https://coronium.ai/free."],
  }),

  WALLET_ALREADY_REGISTERED: () => ({
    summary: "This wallet is already linked to a Coronium account.",
    hints: [
      "To get a fresh API key without spending the voucher: coronium key:rotate",
      "Or restore your existing account: coronium init --restore",
    ],
  }),

  WALLET_NOT_REGISTERED: () => ({
    summary: "No Coronium account exists for this wallet.",
    hints: [
      "If this is your first time: coronium init --voucher cor_v1_…",
      "If you signed up with a different wallet, import that one instead.",
    ],
  }),

  INVALID_KEY: () => ({
    summary: "Your API key isn't valid (expired, revoked, or never existed).",
    hints: [
      "If you have your wallet:    coronium key:rotate",
      "If you have your seed phrase: coronium init --restore",
    ],
  }),

  MISSING_KEY: () => ({
    summary: "No API key is set.",
    hints: [
      "Get a voucher at https://coronium.ai/free, then: coronium init --voucher cor_v1_…",
      "Or set CORONIUM_API_KEY in your environment.",
    ],
  }),

  STOCK_OUT: (e) => {
    const stockErr = e instanceof CoroniumStockOutError ? e : null;
    const summary = "That country/carrier combination is out of stock right now.";
    const hints: string[] = [];
    if (stockErr?.suggestions.length) {
      hints.push("Available alternatives:");
      for (const s of stockErr.suggestions.slice(0, 5)) {
        hints.push(`  • ${s.country} / ${s.carrier} (${s.in_stock} in stock)`);
      }
      hints.push("Re-run with --country " + stockErr.suggestions[0]!.country.toLowerCase() + ".");
    } else {
      hints.push("Check stock with: coronium tariffs --country US --type 5g");
    }
    return { summary, hints };
  },

  SPEND_CAP_EXCEEDED: () => ({
    summary: "This would exceed your spend cap.",
    hints: [
      "Top up by sending USDC to your wallet (run: coronium deposit).",
      "Or override per-call with: --cost-cap-cents 100",
    ],
  }),

  DAILY_CAP_EXCEEDED: () => ({
    summary: "Daily spend cap reached.",
    hints: [
      "Wait until UTC midnight, OR raise your daily cap from the dashboard.",
    ],
  }),

  TENANT_CAP_EXCEEDED: () => ({
    summary: "Coronium tenant-wide daily cap reached. (Rare — usually means everyone is buying at once.)",
    hints: ["Try again in a few minutes, or contact support@coronium.io."],
  }),

  INSUFFICIENT_BALANCE: () => ({
    summary: "Not enough USDC balance for that operation.",
    hints: [
      "Top up with: coronium deposit",
      "Send USDC on Base to your wallet address — it credits within ~10 seconds.",
    ],
  }),

  CARRIER_NO_OP: () => ({
    summary: "Rotation didn't take — the carrier didn't release the IP after retries.",
    hints: ["Try replace instead: coronium proxy replace <id>"],
  }),

  RATE_LIMITED: () => ({
    summary: "You're sending requests too quickly.",
    hints: ["Slow down or back off for a minute."],
  }),

  UPSTREAM_PENDING: () => ({
    summary: "Your account is provisional — Coronium's backend is still wiring up.",
    hints: ["Try again in a moment. If this persists, the agent-native API may not be deployed yet."],
  }),

  UPSTREAM_UNREACHABLE: () => ({
    summary: "Coronium's backend is unreachable from the API server.",
    hints: ["Check https://coronium.ai/status. Try again in a moment."],
  }),
};

export interface FormattedError {
  /** Stable code, e.g. "STOCK_OUT". */
  code: string;
  /** Friendly summary line. */
  summary: string;
  /** Friendly hints, may be empty. */
  hints: string[];
  /** The original raw error message (debug mode). */
  raw_message: string;
  /** HTTP status if relevant. */
  status?: number;
}

/** Build a structured FormattedError. */
export function buildFormatted(e: CoroniumError): FormattedError {
  const handler = MAP[e.code];
  const friendly = handler
    ? handler(e)
    : { summary: e.message || "Request failed.", hints: [] };
  return {
    code: e.code,
    summary: friendly.summary,
    hints: friendly.hints ?? [],
    raw_message: e.message,
    status: e.status,
  };
}

/** Print to stderr with kleur formatting. */
export function printPretty(f: FormattedError): void {
  console.error(kleur.red(`error[${f.code}]`) + " " + f.summary);
  for (const h of f.hints) console.error("  " + kleur.dim(h));
}
