// Thin HTTP helpers for the auth-related endpoints the CLI hits. Distinct
// from the SDK because these are unauthenticated (no bearer key yet) and
// use SIWE message bodies, not the typed-resource shape.

import { CoroniumError } from "coronium-sdk";
import { getBaseUrl, loadConfig } from "./config.js";

export interface RedeemChallengeResponse {
  siwe_message: string;
  nonce: string;
  expires_at: string;
}

export interface RedeemSuccess {
  account_id: string;
  api_key: string;
  wallet_address: string;
  wallet_chain: "evm";
  deposit_addresses: { evm_native: string; usdc_base: string };
  balance_usd: number;
  daily_spend_cap_usd: number;
}

export interface RotateSuccess {
  account_id: string;
  api_key: string;
  wallet_address: string;
}

const DEFAULT_BASE_URL = "https://api.coronium.ai/v1";

async function getBase(): Promise<string> {
  const cfg = await loadConfig();
  return (getBaseUrl(cfg) ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const base = await getBase();
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!res.ok) {
    const code = parsed?.code || `HTTP_${res.status}`;
    const msg = parsed?.message || `${path} → ${res.status}`;
    throw new CoroniumError(res.status, parsed, msg);
  }
  return parsed as T;
}

export const api = {
  redeemChallenge: (input: { voucher: string; wallet_address: string }) =>
    post<RedeemChallengeResponse>("/account/redeem-challenge", input),

  redeem: (input: { siwe_message: string; signature: string }) =>
    post<RedeemSuccess>("/account/redeem", input),

  rotateChallenge: (input: { wallet_address: string }) =>
    post<RedeemChallengeResponse>("/account/key/rotate-challenge", input),

  rotate: (input: { siwe_message: string; signature: string }) =>
    post<RotateSuccess>("/account/key/rotate", input),
};
