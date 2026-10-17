import kleur from "kleur";

export interface GlobalOptions {
  json?: boolean;
}

/** Exit codes, documented in the README. */
export const EXIT_OK: number = 0;
export const EXIT_REJECTED: number = 1;
export const EXIT_USAGE: number = 2;
export const EXIT_OUTCOME_UNKNOWN: number = 3;
export const EXIT_REFUNDED: number = 4;

/** A problem with how the command was called (missing flag, spending off, no token). */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** A command finished but must not report success (for example an unverified purchase). */
export class ExitWith extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = "ExitWith";
  }
}

export function isJson(options: GlobalOptions): boolean {
  return options.json === true;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function ok(message: string): void {
  console.log(`${kleur.green("✓")} ${message}`);
}

export function warn(message: string): void {
  console.log(`${kleur.yellow("!")} ${message}`);
}

/** One aligned "label  value" line. */
export function field(label: string, value: unknown): void {
  console.log(`  ${kleur.dim(label.padEnd(16))} ${formatValue(value)}`);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return kleur.dim("none");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function usd(amount: number | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "unknown";
  return `$${amount.toFixed(2)}`;
}

export function formatDate(milliseconds: number | null | undefined): string {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0) return "unknown";
  return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function parseUsd(raw: string | undefined, flag: string): number {
  const value: number = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flag} must be a positive USD amount, for example ${flag} 49.00`);
  }
  return value;
}

export function parseCount(raw: string | undefined, flag: string): number {
  const value: number = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag} must be a whole number of at least 1.`);
  }
  return value;
}
