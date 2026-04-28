// Account lifecycle routes — wallet-bound + voucher-gated.
//
// Flow:
//   1. POST /v1/account/redeem-challenge { voucher, wallet_address }
//        → { siwe_message, nonce, expires_at }
//   2. Client signs siwe_message with their EVM wallet (via wallet_address's privkey)
//   3. POST /v1/account/redeem { siwe_message, signature }
//        → { account_id, api_key, wallet_address, deposit_addresses, balance_usd, daily_spend_cap_usd }
//
// Plus the account-recovery endpoint:
//   POST /v1/account/key/rotate-challenge { wallet_address }
//   POST /v1/account/key/rotate { siwe_message, signature }
//
// Domain pinning (the SIWE message MUST be aimed at api.coronium.ai with
// chainId 8453) prevents cross-app signature replay.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAddress } from "viem";
import { config } from "../config.js";
import { genId } from "../lib/ids.js";
import { generateKey } from "../lib/keys.js";
import {
  buildSiweMessage,
  generateNonce,
  isValidEvmAddress,
  verifySiwe,
  SiweError,
} from "../lib/siwe.js";
import { insertAccount, getAccount, getAccountByWallet } from "../db/accounts.js";
import { insertApiKey, revokeKey } from "../db/api-keys.js";
import { db } from "../db/index.js";
import { consumeVoucher, getVoucher, isRedeemable } from "../db/vouchers.js";
import { consumeChallenge, getChallenge, insertChallenge } from "../db/challenges.js";
import { upstream, UpstreamError } from "../upstream/client.js";
import { logger } from "../logger.js";

const RedeemChallengeBody = z.object({
  voucher: z.string().min(8).max(80),
  wallet_address: z.string().refine(isValidEvmAddress, "must be a 0x-prefixed 40-hex EVM address"),
});

const RedeemBody = z.object({
  siwe_message: z.string().min(50).max(4000),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "must be 0x + 130 hex chars (65 bytes)"),
});

const RotateChallengeBody = z.object({
  wallet_address: z.string().refine(isValidEvmAddress, "must be a 0x-prefixed 40-hex EVM address"),
});

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function accountRoutes(fastify: FastifyInstance) {
  // ─── 1. Issue a SIWE challenge for voucher redemption ─────────────────
  fastify.post("/account/redeem-challenge", async (req, reply) => {
    const body = RedeemChallengeBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: body.error.issues[0]?.message });
    }
    let walletChecksummed: string;
    try {
      walletChecksummed = getAddress(body.data.wallet_address);
    } catch {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "wallet_address is not a valid EVM address" });
    }
    const wallet = walletChecksummed.toLowerCase();
    const voucherId = body.data.voucher;

    const voucher = getVoucher(voucherId);
    if (!voucher) {
      return reply.code(404).send({ code: "VOUCHER_NOT_FOUND", message: "Unknown voucher" });
    }
    const ok = isRedeemable(voucher);
    if (!ok.ok) return reply.code(409).send(ok);

    // Reject if a wallet that's already an account tries to redeem again.
    const existing = getAccountByWallet(wallet);
    if (existing) {
      return reply.code(409).send({
        code: "WALLET_ALREADY_REGISTERED",
        message: "This wallet is already linked to an account; use /account/key/rotate-challenge to recover an API key",
      });
    }

    const now = Date.now();
    const nonce = generateNonce();
    const expiresAtMs = now + CHALLENGE_TTL_MS;

    const issuedAtIso = new Date(now).toISOString();
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    const message = buildSiweMessage({
      voucher_id: voucherId,
      wallet_address: walletChecksummed, // SIWE/EIP-55 requires checksummed form
      nonce,
      issued_at_iso: issuedAtIso,
      expires_at_iso: expiresAtIso,
      purpose: "redeem",
    });

    insertChallenge({
      nonce,
      voucher_id: voucherId,
      wallet_address: wallet,
      expires_at: expiresAtMs,
      consumed_at: null,
      created_at: now,
    });

    return reply.code(200).send({
      siwe_message: message,
      nonce,
      expires_at: expiresAtIso,
    });
  });

  // ─── 2. Redeem the signed challenge → mint account + API key ──────────
  fastify.post("/account/redeem", async (req, reply) => {
    const body = RedeemBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: body.error.issues[0]?.message });
    }

    let siwe;
    try {
      siwe = await verifySiwe(body.data.siwe_message, body.data.signature);
    } catch (e) {
      if (e instanceof SiweError) return reply.code(400).send({ code: e.code, message: e.message });
      throw e;
    }

    if (!siwe.voucher_id) {
      return reply.code(400).send({ code: "VOUCHER_MISSING", message: "SIWE message lacks voucher resource" });
    }

    // Look up the issued challenge by nonce.
    const ch = getChallenge(siwe.nonce);
    if (!ch) {
      return reply.code(400).send({ code: "CHALLENGE_UNKNOWN", message: "Nonce was not issued by us" });
    }
    if (ch.voucher_id !== siwe.voucher_id) {
      return reply.code(400).send({ code: "CHALLENGE_VOUCHER_MISMATCH", message: "Nonce belongs to a different voucher" });
    }
    if (ch.wallet_address !== siwe.address) {
      return reply.code(400).send({ code: "CHALLENGE_ADDRESS_MISMATCH", message: "Nonce was issued for a different wallet" });
    }

    const now = Date.now();
    if (!consumeChallenge(siwe.nonce, now)) {
      return reply.code(409).send({ code: "CHALLENGE_USED", message: "Nonce already consumed or expired" });
    }

    const voucher = getVoucher(siwe.voucher_id);
    if (!voucher) {
      return reply.code(500).send({ code: "INTERNAL", message: "Voucher disappeared between challenge and redeem" });
    }
    const okV = isRedeemable(voucher, now);
    if (!okV.ok) return reply.code(409).send(okV);

    // Mint upstream user (best-effort — same fallback as before).
    let upstreamUserId: string | undefined;
    let depositAddr: string;
    try {
      const u = await upstream.createUser({ email: undefined });
      upstreamUserId = u.id;
      depositAddr = u.deposit_address_usdc_base ?? siwe.address; // fall back to user's own EVM addr
    } catch (e) {
      if (!(e instanceof UpstreamError && e.code === "UPSTREAM_NOT_CONFIGURED")) {
        logger.error({ err: e }, "redeem: upstream createUser failed; continuing with self-custody address");
      }
      depositAddr = siwe.address;
    }

    const accountId = genId("acc");
    const dailyCap = voucher.daily_cap_cents ?? Math.round(config.DEFAULT_DAILY_CAP_USD * 100);
    const sessionCap = voucher.session_cap_cents ?? Math.round(config.DEFAULT_SESSION_CAP_USD * 100);

    const { full, prefix, hash } = generateKey();
    const apiKeyId = genId("key");

    // Atomic: insert account + key + consume voucher in one tx.
    const tx = db().transaction(() => {
      insertAccount({
        id: accountId,
        email: null,
        created_at: now,
        deposit_addr: depositAddr,
        daily_cap_cents: dailyCap,
        session_cap_cents: sessionCap,
        upstream_user_id: upstreamUserId ?? null,
        wallet_address: siwe.address,
        wallet_chain: "evm",
        deleted_at: null,
      });
      insertApiKey({
        id: apiKeyId,
        account_id: accountId,
        prefix,
        key_hash: hash,
        label: "default",
        created_at: now,
        last_used_at: null,
        revoked_at: null,
      });
      consumeVoucher(siwe.voucher_id!, accountId, now);
    });
    try {
      tx();
    } catch (e: any) {
      logger.error({ err: e }, "redeem transaction failed");
      return reply.code(500).send({ code: "REDEEM_FAILED", message: e?.message || "Could not redeem" });
    }

    return reply.code(201).send({
      account_id: accountId,
      api_key: full,
      wallet_address: siwe.address,
      wallet_chain: "evm",
      deposit_addresses: {
        evm_native: siwe.address,                   // user's own — receives USDC on Base/Arbitrum/Optimism
        usdc_base: depositAddr,                     // server-managed (legacy escrow path; same as own address if upstream not configured)
      },
      balance_usd: voucher.initial_credit_cents / 100,
      daily_spend_cap_usd: dailyCap / 100,
    });
  });

  // ─── 3. Issue a SIWE challenge for API-key rotation (recovery) ────────
  fastify.post("/account/key/rotate-challenge", async (req, reply) => {
    const body = RotateChallengeBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: body.error.issues[0]?.message });
    }
    let walletChecksummed: string;
    try {
      walletChecksummed = getAddress(body.data.wallet_address);
    } catch {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "wallet_address is not a valid EVM address" });
    }
    const wallet = walletChecksummed.toLowerCase();
    const account = getAccountByWallet(wallet);
    if (!account) {
      return reply.code(404).send({ code: "WALLET_NOT_REGISTERED", message: "No account is bound to this wallet" });
    }

    const now = Date.now();
    const nonce = generateNonce();
    const expiresAtMs = now + CHALLENGE_TTL_MS;

    const message = buildSiweMessage({
      voucher_id: `rotate-${account.id}`,           // synthetic resource for tagging — not a real voucher
      wallet_address: walletChecksummed,
      nonce,
      issued_at_iso: new Date(now).toISOString(),
      expires_at_iso: new Date(expiresAtMs).toISOString(),
      purpose: "rotate",
    });

    insertChallenge({
      nonce,
      voucher_id: `rotate-${account.id}`,
      wallet_address: wallet,
      expires_at: expiresAtMs,
      consumed_at: null,
      created_at: now,
    });

    return reply.code(200).send({
      siwe_message: message,
      nonce,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
  });

  // ─── 4. Rotate the API key ────────────────────────────────────────────
  fastify.post("/account/key/rotate", async (req, reply) => {
    const body = RedeemBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: body.error.issues[0]?.message });
    }

    let siwe;
    try {
      siwe = await verifySiwe(body.data.siwe_message, body.data.signature);
    } catch (e) {
      if (e instanceof SiweError) return reply.code(400).send({ code: e.code, message: e.message });
      throw e;
    }

    const account = getAccountByWallet(siwe.address);
    if (!account) {
      return reply.code(404).send({ code: "WALLET_NOT_REGISTERED", message: "No account bound to this wallet" });
    }
    if (siwe.voucher_id !== `rotate-${account.id}`) {
      return reply.code(400).send({ code: "CHALLENGE_PURPOSE_MISMATCH", message: "Challenge was not issued for key rotation" });
    }

    const ch = getChallenge(siwe.nonce);
    if (!ch || ch.wallet_address !== siwe.address) {
      return reply.code(400).send({ code: "CHALLENGE_UNKNOWN", message: "Nonce not issued or address mismatch" });
    }

    const now = Date.now();
    if (!consumeChallenge(siwe.nonce, now)) {
      return reply.code(409).send({ code: "CHALLENGE_USED", message: "Nonce already consumed or expired" });
    }

    // Revoke all existing keys, mint a fresh one.
    const { full, prefix, hash } = generateKey();
    const newKeyId = genId("key");
    const tx = db().transaction(() => {
      const existing = db()
        .prepare("SELECT id FROM api_keys WHERE account_id = ? AND revoked_at IS NULL")
        .all(account.id) as Array<{ id: string }>;
      for (const k of existing) revokeKey(k.id, now);
      insertApiKey({
        id: newKeyId,
        account_id: account.id,
        prefix,
        key_hash: hash,
        label: "rotated",
        created_at: now,
        last_used_at: null,
        revoked_at: null,
      });
    });
    try {
      tx();
    } catch (e: any) {
      logger.error({ err: e }, "rotate transaction failed");
      return reply.code(500).send({ code: "ROTATE_FAILED", message: e?.message || "Could not rotate" });
    }

    return reply.code(200).send({
      account_id: account.id,
      api_key: full,
      wallet_address: account.wallet_address,
      revoked_count: db()
        .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ? AND revoked_at = ?")
        .get(account.id, now) as { n: number } extends { n: number } ? number : number,
    });
  });

  // The legacy POST /account/create is **removed** — it was never wallet-bound
  // and would let anyone mint accounts. To create an account, use vouchers.
  // The unauthenticated path that the SDK still calls (`account.create`) needs
  // to migrate to the redeem-challenge / redeem flow.
  void getAccount; // silence unused
}
