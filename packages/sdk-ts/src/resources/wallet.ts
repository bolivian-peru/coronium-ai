// HTTP half of the wallet (SIWE) sign-up and key rotation. Key generation and
// message signing stay with the caller (the CLI uses viem), so the SDK carries
// no wallet or crypto dependencies.

import { CoroniumError } from "../errors.js";
import { ROUTES } from "../routes.js";
import { objectBody, type Transport } from "../transport.js";
import type { WalletChallenge, WalletRotateResult, WalletSignupResult } from "../types.js";

export interface WalletChallengeInput {
  walletAddress: string;
  voucher: string;
}

export interface WalletSignupInput extends WalletChallengeInput {
  /** The exact SIWE message from `challenge`. */
  message: string;
  signature: string;
}

export interface WalletRotateInput {
  message: string;
  signature: string;
}

function assertChallenge(body: unknown): WalletChallenge {
  const challenge: WalletChallenge = objectBody<WalletChallenge>(body, "Wallet challenge");
  if (typeof challenge.message !== "string" || challenge.message === "") {
    throw new CoroniumError({ code: "invalid_response", message: "Wallet challenge has no message to sign." });
  }
  return challenge;
}

function assertToken<T extends { api_token: string }>(body: unknown, label: string): T {
  const result: T = objectBody<T>(body, label, "unknown");
  if (typeof result.api_token !== "string" || result.api_token === "") {
    throw new CoroniumError({ code: "invalid_response", message: `${label} returned no API token.`, outcome: "unknown" });
  }
  return result;
}

export class WalletResource {
  constructor(private readonly transport: Transport) {}

  /** Step 1 of sign-up: get a SIWE message bound to the wallet and voucher. */
  async challenge(input: WalletChallengeInput): Promise<WalletChallenge> {
    const result = await this.transport.call<unknown>(ROUTES.walletChallenge, {
      body: { wallet_address: input.walletAddress, voucher: input.voucher },
    });
    return assertChallenge(result.body);
  }

  /** Step 2 of sign-up: redeem the voucher with the signed message. Consumes the voucher. */
  async signup(input: WalletSignupInput): Promise<WalletSignupResult> {
    const result = await this.transport.call<unknown>(ROUTES.walletSignup, {
      body: {
        wallet_address: input.walletAddress,
        voucher: input.voucher,
        message: input.message,
        signature: input.signature,
      },
    });
    return assertToken<WalletSignupResult>(result.body, "Wallet sign-up");
  }

  /** Step 1 of key rotation for a wallet-bound account. Needs the current token. */
  async rotateChallenge(): Promise<WalletChallenge> {
    const result = await this.transport.call<unknown>(ROUTES.walletRotateChallenge, { body: {} });
    return assertChallenge(result.body);
  }

  /**
   * Step 2 of key rotation. Returns a new token. Earlier tokens are not revoked
   * by this call, so treat a leaked token as live until it expires.
   */
  async rotate(input: WalletRotateInput): Promise<WalletRotateResult> {
    const result = await this.transport.call<unknown>(ROUTES.walletRotate, {
      body: { message: input.message, signature: input.signature },
    });
    return assertToken<WalletRotateResult>(result.body, "Key rotation");
  }
}
