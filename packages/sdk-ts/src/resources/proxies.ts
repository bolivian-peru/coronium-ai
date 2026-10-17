import { CoroniumError } from "../errors.js";
import { ROUTES } from "../routes.js";
import { toRotationResult } from "../rotation.js";
import { dataArray, isObject, objectBody, type Transport } from "../transport.js";
import type {
  OwnedProxy,
  ProxyTestResult,
  ReplacedProxy,
  ReplaceResult,
  RestartResponse,
  RotationResult,
  RotationStatus,
  WhitelistResult,
} from "../types.js";

export interface WaitOptions {
  /** Give up after this long. Default 120 seconds. */
  timeoutMs?: number;
  /** Delay between status reads. Default 5 seconds. */
  intervalMs?: number;
}

export interface OpenVpnOptions {
  /** Ask for a TCP profile instead of the default. */
  proto?: "tcp";
}

const DEFAULT_WAIT_TIMEOUT_MS: number = 120_000;
const DEFAULT_WAIT_INTERVAL_MS: number = 5_000;
const MAX_WHITELIST_ENTRIES: number = 100;
const FINAL_ROTATION_STATES: ReadonlySet<string> = new Set(["done", "failed", "idle"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

function matchesProxy(proxy: OwnedProxy, identifier: string): boolean {
  if (String(proxy._id).toLowerCase() === identifier.toLowerCase()) return true;
  return proxy.name === identifier || proxy.portId === identifier;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

// The test route reports failures as 2xx bodies with an `error` string, either
// at the top level or inside `data`.
function toTestResult(body: unknown): ProxyTestResult {
  const top: Record<string, unknown> = isObject(body) ? body : {};
  const data: Record<string, unknown> = isObject(top.data) ? top.data : {};
  const error: string | null = stringOrNull(top.error) ?? stringOrNull(data.error);
  const answered: boolean = isObject(top.data) && error === null;
  return {
    ok: answered,
    extIp: stringOrNull(data.extIp) ?? stringOrNull(data.ext_ip),
    error,
    requestTime: numberOrNull(top.requestTime) ?? numberOrNull(data.requestTime),
    response: body,
  };
}

function toReplaceResult(body: unknown): ReplaceResult {
  const response: Record<string, unknown> = objectBody<Record<string, unknown>>(body, "Replace", "unknown");
  if (response.result !== "ok") {
    throw new CoroniumError({
      code: "invalid_response",
      message: "Replace did not confirm the swap. Check your proxy list before trying again.",
      outcome: "unknown",
      suggestedAction: "list_proxies",
      details: response,
    });
  }
  let newModem: ReplacedProxy | null = null;
  if (isObject(response.newModem)) newModem = response.newModem as ReplacedProxy;
  return {
    oldModemId: stringOrNull(response.oldModemId),
    newModemId: stringOrNull(response.newModemId),
    newModem,
  };
}

function assertWhitelist(ips: string[]): void {
  if (ips.length > MAX_WHITELIST_ENTRIES) {
    throw new CoroniumError({ code: "invalid_argument", message: `At most ${MAX_WHITELIST_ENTRIES} whitelist entries.` });
  }
  for (const ip of ips) {
    if (typeof ip !== "string" || ip.trim() === "" || /\s/.test(ip.trim())) {
      throw new CoroniumError({ code: "invalid_argument", message: `Not a valid IP entry: "${ip}".` });
    }
  }
}

export class ProxiesResource {
  constructor(
    private readonly transport: Transport,
    private readonly actionTimeoutMs: number,
  ) {}

  /** Proxies you own, with credentials. Treat the result as secret. */
  async list(): Promise<OwnedProxy[]> {
    const result = await this.transport.call<unknown>(ROUTES.proxiesList);
    return dataArray<OwnedProxy>(result.body, "Owned proxies");
  }

  /** One owned proxy by id, exact name or port id. Throws `proxy_not_found`. */
  async get(identifier: string): Promise<OwnedProxy> {
    const proxies: OwnedProxy[] = await this.list();
    const match: OwnedProxy | undefined = proxies.find((proxy: OwnedProxy): boolean => matchesProxy(proxy, identifier));
    if (!match) {
      throw new CoroniumError({ code: "proxy_not_found", message: `No proxy "${identifier}" in this account.`, suggestedAction: "list_proxies" });
    }
    return match;
  }

  /**
   * Ask the carrier for a new IP. Existing connections drop for roughly 10 to 60
   * seconds. Returns `rotating` when the provider works asynchronously: poll
   * `rotationStatus` or `waitForRotation`, never resubmit. A 429 means wait for
   * `retryAfterSeconds`.
   */
  async rotate(modemId: string): Promise<RotationResult> {
    const result = await this.transport.call<unknown>(ROUTES.proxyRestart, {
      params: { id: modemId },
      body: {},
      timeoutMs: this.actionTimeoutMs,
    });
    return toRotationResult(objectBody<RestartResponse>(result.body, "Rotation", "unknown"));
  }

  async rotationStatus(modemId: string): Promise<RotationStatus> {
    const result = await this.transport.call<unknown>(ROUTES.proxyRotationStatus, { params: { id: modemId } });
    return objectBody<RotationStatus>(result.body, "Rotation status");
  }

  /** Poll rotation status until it is done, failed or idle, or the timeout passes. */
  async waitForRotation(modemId: string, options: WaitOptions = {}): Promise<RotationStatus> {
    const deadline: number = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const interval: number = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    let status: RotationStatus = await this.rotationStatus(modemId);
    while (!FINAL_ROTATION_STATES.has(String(status.state)) && Date.now() < deadline) {
      await sleep(interval);
      status = await this.rotationStatus(modemId);
    }
    return status;
  }

  /**
   * Rotate with a proxy's rotation token (no API token needed). The token URL is
   * a GET that rotates on every fetch, so never paste it where link previews run.
   */
  async rotateByToken(rotationToken: string): Promise<RotationResult> {
    const result = await this.transport.call<unknown>(ROUTES.proxyRotateByToken, {
      params: { token: rotationToken },
      timeoutMs: this.actionTimeoutMs,
    });
    return toRotationResult(objectBody<RestartResponse>(result.body, "Rotation", "unknown"));
  }

  /**
   * Swap a proxy for a different modem. Irreversible: the proxy gets a new host
   * and new credentials, and the default quota is 2 replacements per 24 hours.
   */
  async replace(modemId: string): Promise<ReplaceResult> {
    const result = await this.transport.call<unknown>(ROUTES.proxyReplace, {
      params: { id: modemId },
      body: {},
      timeoutMs: this.actionTimeoutMs,
    });
    return toReplaceResult(result.body);
  }

  /**
   * Download the OpenVPN profile (plain text, contains secrets). Side effects
   * depend on the provider: some issue a new certificate on every call and some
   * allow a single download.
   */
  async openvpn(modemId: string, options: OpenVpnOptions = {}): Promise<string> {
    const result = await this.transport.call<unknown>(ROUTES.proxyOpenVpn, {
      params: { id: modemId },
      query: { proto: options.proto },
      text: true,
    });
    if (typeof result.body !== "string") {
      throw new CoroniumError({ code: "invalid_response", message: "OpenVPN did not return a profile file." });
    }
    return result.body;
  }

  /** Run the API's connectivity check. `ok: false` carries the reported error. */
  async test(modemId: string): Promise<ProxyTestResult> {
    const result = await this.transport.call<unknown>(ROUTES.proxyTest, {
      params: { id: modemId },
      body: {},
      timeoutMs: this.actionTimeoutMs,
      allowErrorBody: true,
    });
    return toTestResult(result.body);
  }

  /**
   * Replace the IP whitelist. Supported on Coronium Node proxies only; other
   * proxies answer `route_not_found` or 404.
   */
  async setWhitelist(modemId: string, ips: string[]): Promise<WhitelistResult> {
    assertWhitelist(ips);
    const whiteList: string[] = ips.map((ip: string): string => ip.trim());
    const result = await this.transport.call<unknown>(ROUTES.proxySetWhitelist, {
      params: { id: modemId },
      body: { white_list: whiteList },
    });
    return objectBody<WhitelistResult>(result.body, "Whitelist", "unknown");
  }
}
