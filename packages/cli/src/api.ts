// Thin HTTP helpers for the auth-related endpoints the CLI hits. Distinct
// from the SDK because these are unauthenticated (no bearer key yet) and
// use SIWE message bodies, not the typed-resource shape.
//
// The backend lives at /api/v3 on the main Coronium API. Wallet signup is
// a two-step SIWE flow:
//   1. POST /wallet-challenge { wallet_address, voucher }
//      → { message, nonce, expires_in_s }
//   2. POST /wallet-signup { wallet_address, voucher, message, signature }
//      → { api_token, user_id, wallet_address, balance_usd }
// Key rotation mirrors the same shape under /wallet-key/rotate*.
//
// We translate at this layer so commands/init.ts continues to use the
// abstract RedeemChallengeResponse / RedeemSuccess types — backend shape
// changes don't propagate to call sites.

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

const DEFAULT_BASE_URL = "https://api.coronium.io/api/v3";

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
    const msg = parsed?.error || parsed?.message || `${path} → ${res.status}`;
    throw new CoroniumError(res.status, parsed, msg);
  }
  return parsed as T;
}

interface BackendChallenge {
  message: string;
  nonce: string;
  expires_in_s: number;
}

interface BackendSignup {
  api_token: string;
  user_id: string;
  wallet_address: string;
  balance_usd: number;
}

interface BackendRotate {
  api_token: string;
}

export const api = {
  redeemChallenge: async (input: { voucher: string; wallet_address: string }): Promise<RedeemChallengeResponse> => {
    const r = await post<BackendChallenge>("/wallet-challenge", input);
    return {
      siwe_message: r.message,
      nonce: r.nonce,
      expires_at: new Date(Date.now() + r.expires_in_s * 1000).toISOString(),
    };
  },

  redeem: async (input: { siwe_message: string; signature: string; wallet_address: string; voucher: string }): Promise<RedeemSuccess> => {
    const r = await post<BackendSignup>("/wallet-signup", {
      wallet_address: input.wallet_address,
      voucher: input.voucher,
      message: input.siwe_message,
      signature: input.signature,
    });
    return {
      account_id: r.user_id,
      api_key: r.api_token,
      wallet_address: r.wallet_address,
      wallet_chain: "evm",
      deposit_addresses: { evm_native: r.wallet_address, usdc_base: r.wallet_address },
      balance_usd: r.balance_usd,
      daily_spend_cap_usd: r.balance_usd, // until billing tier exists, daily cap == voucher credit
    };
  },

  rotateChallenge: async (input: { wallet_address: string; api_key: string }): Promise<RedeemChallengeResponse> => {
    const base = await getBase();
    const res = await fetch(`${base}/wallet-key/rotate-challenge?auth_token=${encodeURIComponent(input.api_key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new CoroniumError(res.status, parsed, parsed?.error || `${res.status}`);
    }
    return {
      siwe_message: parsed.message,
      nonce: parsed.nonce,
      expires_at: new Date(Date.now() + parsed.expires_in_s * 1000).toISOString(),
    };
  },

  rotate: async (input: { siwe_message: string; signature: string; wallet_address: string; api_key: string }): Promise<RotateSuccess> => {
    const base = await getBase();
    const res = await fetch(`${base}/wallet-key/rotate?auth_token=${encodeURIComponent(input.api_key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: input.siwe_message, signature: input.signature }),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new CoroniumError(res.status, parsed, parsed?.error || `${res.status}`);
    }
    const r = parsed as BackendRotate;
    return { account_id: "", api_key: r.api_token, wallet_address: input.wallet_address };
  },
};
