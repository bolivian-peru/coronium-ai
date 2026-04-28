// Thin HTTP client for the existing cor-api-v1 agent endpoint. Every method
// here maps to a real backend endpoint Lauren already uses. We translate
// between the agent-native 7-verb shape and the existing controllers.

import { request } from "undici";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface UpstreamProxy {
  id: string;
  host: string;
  port_http: number;
  port_socks5: number;
  username: string;
  password: string;
  country: string;
  region?: string;
  carrier: string;
  type: "4g" | "5g";
  ip: string;
  os?: string;
  created_at: string;
  expires_at: string;
  rotate_url: string;
  rotation_policy: string;
}

export interface UpstreamUser {
  id: string;
  email?: string;
  balance_usd: number;
  deposit_address_usdc_base?: string;
}

export class UpstreamError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: any;
  constructor(status: number, code: string, message: string, body: any) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

class UpstreamClient {
  async createUser(input: { email?: string }): Promise<UpstreamUser> {
    return this.call("POST", "/users", input);
  }

  async getBalance(upstreamUserId: string): Promise<{ balance_usd: number }> {
    return this.call("GET", `/users/${encodeURIComponent(upstreamUserId)}/balance`);
  }

  async getDepositAddress(input: {
    upstream_user_id: string;
    chain: "base" | "tron" | "ethereum";
    amount_usd?: number;
  }): Promise<{ chain: string; address: string; qr: string; expires_at: string; amount_usd: number | null }> {
    return this.call("POST", "/deposit/address", input);
  }

  async listTariffs(filters: {
    country?: string;
    carrier?: string;
    type?: "4g" | "5g";
  }): Promise<Array<{ id: string; country: string; carrier: string; type: "4g" | "5g"; period_hours: number; price_usd: number; in_stock: boolean }>> {
    const qs = new URLSearchParams();
    if (filters.country) qs.set("country", filters.country);
    if (filters.carrier) qs.set("carrier", filters.carrier);
    if (filters.type) qs.set("type", filters.type);
    return this.call("GET", `/tariffs?${qs.toString()}`);
  }

  async listProxies(upstreamUserId: string): Promise<UpstreamProxy[]> {
    return this.call("GET", `/users/${encodeURIComponent(upstreamUserId)}/proxies`);
  }

  async buyProxy(input: {
    upstream_user_id: string;
    country: string;
    type: "4g" | "5g";
    carrier?: string;
    qty: number;
    ttl?: string;
    rotation?: string;
    sticky?: boolean;
    os?: string;
  }): Promise<UpstreamProxy[]> {
    return this.call("POST", "/proxies", input);
  }

  async releaseProxy(upstreamUserId: string, proxyId: string): Promise<void> {
    await this.call("DELETE", `/users/${encodeURIComponent(upstreamUserId)}/proxies/${encodeURIComponent(proxyId)}`);
  }

  async rotateProxy(upstreamUserId: string, proxyId: string): Promise<{ ip_before: string; ip_after: string; duration_ms: number }> {
    return this.call("POST", `/users/${encodeURIComponent(upstreamUserId)}/proxies/${encodeURIComponent(proxyId)}/rotate`);
  }

  async replaceProxy(upstreamUserId: string, proxyId: string): Promise<UpstreamProxy> {
    return this.call("POST", `/users/${encodeURIComponent(upstreamUserId)}/proxies/${encodeURIComponent(proxyId)}/replace`);
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!config.UPSTREAM_API_TOKEN) {
      throw new UpstreamError(500, "UPSTREAM_NOT_CONFIGURED", "UPSTREAM_API_TOKEN is not set", null);
    }
    const url = config.UPSTREAM_API_URL.replace(/\/$/, "") + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.UPSTREAM_API_TOKEN}`,
      Accept: "application/json",
      "User-Agent": "coronium-api/0.1.0",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const start = Date.now();
    let res;
    try {
      res = await request(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        bodyTimeout: 30_000,
        headersTimeout: 10_000,
      });
    } catch (e: any) {
      logger.error({ err: e?.message, url, method }, "upstream network error");
      throw new UpstreamError(502, "UPSTREAM_UNREACHABLE", "Upstream API unreachable", null);
    }

    const text = await res.body.text();
    const duration = Date.now() - start;
    logger.debug({ method, path, status: res.statusCode, duration }, "upstream call");

    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (res.statusCode === 204) return undefined as T;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return parsed as T;
    }
    const code = parsed?.code || `UPSTREAM_${res.statusCode}`;
    const message = parsed?.message || `upstream ${method} ${path} → ${res.statusCode}`;
    throw new UpstreamError(res.statusCode, code, message, parsed);
  }
}

export const upstream = new UpstreamClient();
