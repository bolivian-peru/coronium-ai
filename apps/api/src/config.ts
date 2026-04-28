// Centralized config. All env-var reads happen here. Fail loudly at boot if
// anything required is missing.

import { config as dotenv } from "dotenv";
import { z } from "zod";

dotenv();

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5050),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_PATH: z.string().default("./data/coronium.db"),

  UPSTREAM_API_URL: z.string().url().default("https://api.coronium.io/api/agent"),
  UPSTREAM_API_TOKEN: z.string().min(1).optional(),

  DEFAULT_DAILY_CAP_USD: z.coerce.number().positive().default(50),
  DEFAULT_SESSION_CAP_USD: z.coerce.number().positive().default(5),
  TENANT_DAILY_CAP_USD: z.coerce.number().positive().default(500),

  RATE_LIMIT_PER_KEY_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(60),

  CORS_ORIGINS: z
    .string()
    .default("https://coronium.ai,https://dashboard.coronium.io")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),

  TRIAL_CREDIT_USD: z.coerce.number().nonnegative().default(0.5),
});

export type Config = z.infer<typeof Schema>;

let _config: Config | undefined;

export function loadConfig(): Config {
  if (_config) return _config;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[config] invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  _config = parsed.data;
  return _config;
}

export const config = loadConfig();
