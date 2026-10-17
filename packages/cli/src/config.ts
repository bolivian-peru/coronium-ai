import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface CliConfig {
  /** Stored API token. Named api_key for compatibility with 0.x config files. */
  api_key?: string;
  base_url?: string;
  email?: string;
  /** Spending commands (buy, renew) are refused unless this is true. */
  allow_spending?: boolean;
}

function configDir(): string {
  return join(homedir(), ".coronium");
}

export function configPath(): string {
  return join(configDir(), "config.toml");
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed: string = value.trim();
  if (trimmed === "") return undefined;
  return trimmed;
}

/** CORONIUM_API_TOKEN wins, then the 0.x name CORONIUM_API_KEY, then the config file. */
export function getApiToken(config: CliConfig): string | undefined {
  return nonEmpty(process.env.CORONIUM_API_TOKEN) ?? nonEmpty(process.env.CORONIUM_API_KEY) ?? nonEmpty(config.api_key);
}

export function getBaseUrl(config: CliConfig): string | undefined {
  return nonEmpty(process.env.CORONIUM_BASE_URL) ?? nonEmpty(config.base_url);
}

/** Spending is on only when CORONIUM_ALLOW_SPENDING=1 or `coronium spending on` was run. */
export function isSpendingAllowed(config: CliConfig): boolean {
  const fromEnv: string = (process.env.CORONIUM_ALLOW_SPENDING ?? "").trim().toLowerCase();
  if (fromEnv === "1" || fromEnv === "true") return true;
  return config.allow_spending === true;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function loadConfig(): Promise<CliConfig> {
  let text: string;
  try {
    text = await readFile(configPath(), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
  return parse(text) as CliConfig;
}

// TOML has no null or undefined, so unset keys are dropped before writing.
function definedEntries(config: CliConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export async function saveConfig(config: CliConfig): Promise<string> {
  const path: string = configPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, stringify(definedEntries(config)), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
