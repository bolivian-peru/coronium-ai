import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface CliConfig {
  api_key?: string;
  base_url?: string;
  email?: string;
}

const CONFIG_DIR = join(homedir(), ".coronium");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

export function getApiKey(cfg: CliConfig): string | undefined {
  return process.env.CORONIUM_API_KEY || cfg.api_key;
}

export function getBaseUrl(cfg: CliConfig): string | undefined {
  return process.env.CORONIUM_BASE_URL || cfg.base_url;
}

export async function loadConfig(): Promise<CliConfig> {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    const parsed = parse(text);
    return parsed as CliConfig;
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
}

export async function saveConfig(cfg: CliConfig): Promise<string> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, stringify(cfg as any), { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
  return CONFIG_PATH;
}

export const CONFIG_FILE = CONFIG_PATH;
