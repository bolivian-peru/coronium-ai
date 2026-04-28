// EIP-4361 (Sign-In with Ethereum) helpers — challenge construction +
// verification. We use Spruce's `siwe` lib for parsing/validation and `viem`
// for signature recovery (siwe@2 already does this internally; we keep the
// import explicit for clarity).
//
// Domain pinning: the SIWE message MUST contain our exact domain. Cross-app
// signature replay would otherwise be trivial (someone signs a SIWE message
// for `evil.com` that includes our voucher resource → we'd accept it).

import { SiweMessage } from "siwe";
import { config } from "../config.js";

export interface ChallengeInput {
  voucher_id: string;
  wallet_address: string;          // 0x… (mixed case OK, we normalize)
  nonce: string;
  expires_at_iso: string;
  issued_at_iso: string;
  purpose: "redeem" | "rotate";
}

export const SIWE_DOMAIN = "api.coronium.ai";
export const SIWE_URI = "https://api.coronium.ai/v1/account/redeem";
export const SIWE_BASE_CHAIN_ID = 8453; // Base mainnet

const STATEMENTS: Record<ChallengeInput["purpose"], (id: string) => string> = {
  redeem: (id) => `Create a Coronium account by redeeming voucher ${id}.`,
  rotate: (id) => `Rotate API key for Coronium account bound to wallet (voucher ${id}).`,
};

export function buildSiweMessage(input: ChallengeInput): string {
  const msg = new SiweMessage({
    domain: SIWE_DOMAIN,
    address: input.wallet_address,
    statement: STATEMENTS[input.purpose](input.voucher_id),
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_BASE_CHAIN_ID,
    nonce: input.nonce,
    issuedAt: input.issued_at_iso,
    expirationTime: input.expires_at_iso,
    resources: [`urn:coronium:voucher:${input.voucher_id}`],
  });
  return msg.prepareMessage();
}

export interface VerifiedSiwe {
  address: string;          // 0x… lowercased
  voucher_id: string | null;// extracted from resources, null if absent
  nonce: string;
  issued_at: string;
  expiration_time?: string;
  domain: string;
  uri: string;
}

export class SiweError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SiweError";
    this.code = code;
  }
}

export async function verifySiwe(message: string, signature: string): Promise<VerifiedSiwe> {
  let parsed: SiweMessage;
  try {
    parsed = new SiweMessage(message);
  } catch (e: any) {
    throw new SiweError("SIWE_PARSE_ERROR", `Could not parse SIWE message: ${e?.message || e}`);
  }

  // Domain pinning — reject anything not aimed at us.
  if (parsed.domain !== SIWE_DOMAIN) {
    throw new SiweError("SIWE_DOMAIN_MISMATCH", `Expected domain ${SIWE_DOMAIN}, got ${parsed.domain}`);
  }
  if (parsed.uri !== SIWE_URI) {
    throw new SiweError("SIWE_URI_MISMATCH", `Expected uri ${SIWE_URI}, got ${parsed.uri}`);
  }
  if (parsed.chainId !== SIWE_BASE_CHAIN_ID) {
    throw new SiweError("SIWE_CHAIN_MISMATCH", `Expected chain ${SIWE_BASE_CHAIN_ID}, got ${parsed.chainId}`);
  }
  if (parsed.version !== "1") {
    throw new SiweError("SIWE_VERSION_MISMATCH", `Unsupported SIWE version ${parsed.version}`);
  }

  // Verify signature recovers to declared address.
  let result;
  try {
    result = await parsed.verify({ signature });
  } catch (e: any) {
    // siwe@2 throws on bad signatures rather than returning success:false.
    // Distinguish "signature didn't recover" from genuine internal errors.
    const msg = String(e?.message || e?.error?.type || e);
    if (/signature|invalid|recovered/i.test(msg)) {
      throw new SiweError("SIWE_INVALID_SIGNATURE", msg);
    }
    throw new SiweError("SIWE_VERIFY_ERROR", `Verification threw: ${msg}`);
  }
  if (!result.success) {
    throw new SiweError("SIWE_INVALID_SIGNATURE", result.error?.type || "signature did not verify");
  }

  // Extract voucher resource.
  let voucher_id: string | null = null;
  for (const r of parsed.resources ?? []) {
    const m = r.match(/^urn:coronium:voucher:(.+)$/);
    if (m) voucher_id = m[1]!;
  }

  return {
    address: parsed.address.toLowerCase(),
    voucher_id,
    nonce: parsed.nonce,
    issued_at: parsed.issuedAt!,
    expiration_time: parsed.expirationTime,
    domain: parsed.domain,
    uri: parsed.uri,
  };
}

export function generateNonce(): string {
  // 32 random hex chars = 16 bytes of entropy. SIWE spec requires alnum.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Node fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require("node:crypto");
    bytes.set(randomBytes(16));
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidEvmAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

// Suppress unused warning for config — it'll be used when we make domain configurable.
void config;
