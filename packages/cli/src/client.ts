import { Coronium } from "coronium-sdk";
import { getApiToken, getBaseUrl, isSpendingAllowed, loadConfig, type CliConfig } from "./config.js";
import { UsageError } from "./output.js";
import { CLI_VERSION } from "./version.js";

export interface ClientOptions {
  /** Fail with a usage error when no token is configured. */
  requireToken: boolean;
  /** Pass the spending opt-in through to the SDK. */
  spending?: boolean;
  /** Use this token instead of the configured one. */
  token?: string;
}

function missingToken(): UsageError {
  return new UsageError("No API token configured.", [
    "Create one at dashboard.coronium.io (Account, API Access), then run: coronium login --token <token>",
    "Or set CORONIUM_API_TOKEN in your environment.",
  ]);
}

export async function makeClient(options: ClientOptions): Promise<Coronium> {
  const config: CliConfig = await loadConfig();
  const token: string | undefined = options.token ?? getApiToken(config);
  if (options.requireToken && !token) throw missingToken();
  return new Coronium({
    token,
    baseUrl: getBaseUrl(config),
    allowSpending: options.spending === true && isSpendingAllowed(config),
    userAgent: `coronium-cli/${CLI_VERSION}`,
  });
}
