// Mock implementation of coronium-ai/openapi.yaml. Returns realistic shapes
// for every verb so the CLI/MCP/SDK can be tested end-to-end without standing
// up the real backend. NO persistence, NO real charges, NO real proxies.

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import {
  accounts,
  genApiKey,
  genEthAddress,
  genId,
  genIPv4,
  proxies,
  stock,
  TARIFFS,
  type MockAccount,
  type MockProxy,
} from "./state.js";

const PORT = Number(process.env.PORT || 5050);
const HOST = process.env.HOST || "127.0.0.1";

const app: Express = express();
app.use(express.json({ limit: "64kb" }));

// ─── Auth middleware ────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) return res.status(401).json({ code: "INVALID_KEY", message: "Missing bearer token" });
  const acc = accounts.get(m[1]!);
  if (!acc) return res.status(401).json({ code: "INVALID_KEY", message: "Unknown API key" });
  (req as any).account = acc;
  next();
}

function getCostCap(req: Request): number | undefined {
  const v = req.header("x-cost-cap-cents");
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ─── Routes ────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true, mock: true }));

// 1. POST /v1/account/create
app.post("/v1/account/create", (req, res) => {
  const email = (req.body?.email || "").toString().trim().slice(0, 200) || undefined;
  const acc: MockAccount = {
    account_id: genId("acc"),
    api_key: genApiKey(),
    email,
    balance_usd: 0.5,
    daily_spend_cap_usd: 50,
    spend_today_usd: 0,
    deposit_address_usdc_base: genEthAddress(),
  };
  accounts.set(acc.api_key, acc);
  res.status(201).json({
    account_id: acc.account_id,
    api_key: acc.api_key,
    deposit_address_usdc_base: acc.deposit_address_usdc_base,
    balance_usd: acc.balance_usd,
    daily_spend_cap_usd: acc.daily_spend_cap_usd,
  });
});

// 2. GET /v1/balance
app.get("/v1/balance", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  const ownersProxies = [...proxies.values()].filter((p) => p._ownerKey === acc.api_key);
  const burnPerHour = ownersProxies.reduce((sum, p) => sum + p._hourly_rate_usd, 0);
  const hours = burnPerHour > 0 ? acc.balance_usd / burnPerHour : Infinity;
  res.json({
    usdc: acc.balance_usd.toFixed(2),
    hours_at_current_burn: Number.isFinite(hours) ? hours.toFixed(1) : "infinite",
    active_proxies: ownersProxies.length,
    spend_today_usd: acc.spend_today_usd,
    daily_cap_usd: acc.daily_spend_cap_usd,
    session_cap_usd: 5,
  });
});

// 3. POST /v1/deposit/address
app.post("/v1/deposit/address", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  const chain = (req.body?.chain || "base").toString();
  if (!["base", "tron", "ethereum"].includes(chain)) {
    return res.status(400).json({ code: "INVALID_CHAIN", message: `chain must be base|tron|ethereum, got ${chain}` });
  }
  const address = chain === "base" ? acc.deposit_address_usdc_base : genEthAddress();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  res.json({
    chain,
    address,
    qr: `data:image/png;base64,iVBORw0KGgo=`, // stub
    expires_at: expires,
    amount_usd: req.body?.amount_usd ?? null,
  });
});

// 4. GET /v1/tariffs
app.get("/v1/tariffs", requireAuth, (req, res) => {
  const country = (req.query.country as string | undefined)?.toUpperCase();
  const carrier = (req.query.carrier as string | undefined)?.toLowerCase();
  const type = req.query.type as string | undefined;
  let list = TARIFFS as Array<(typeof TARIFFS)[number]>;
  if (country) list = list.filter((t) => t.country === country);
  if (carrier) list = list.filter((t) => t.carrier.toLowerCase().includes(carrier));
  if (type) list = list.filter((t) => t.type === type);
  res.json(
    list.map((t) => ({
      id: t.id,
      country: t.country,
      carrier: t.carrier,
      type: t.type,
      period_hours: t.period_hours,
      price_usd: t.price_usd,
      in_stock: (stock.get(`${t.country}/${t.carrier}`) ?? 0) > 0,
    })),
  );
});

// 5. GET /v1/proxies
app.get("/v1/proxies", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  res.json([...proxies.values()].filter((p) => p._ownerKey === acc.api_key).map(stripInternal));
});

// 6. POST /v1/proxies   (the hero verb)
app.post("/v1/proxies", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  const body = req.body || {};
  const country = (body.country || "").toString().toUpperCase();
  const type = (body.type || "5g") as "4g" | "5g";
  const carrier = body.carrier ? String(body.carrier) : undefined;
  const qty = Math.max(1, Math.min(50, parseInt(String(body.qty || 1), 10) || 1));
  const ttl = body.ttl ? String(body.ttl) : undefined;
  const rotation = body.rotation ? String(body.rotation) : undefined;
  const sticky = Boolean(body.sticky);
  const os = body.os ? String(body.os) : "";

  if (!country) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "country is required" });
  }

  // Cost cap check first — request-shape only, doesn't depend on state.
  // Compare cap against hourly-rate × qty (the user's committed burn), not
  // the 60-second minimum charge (which is always sub-cent and lets any
  // reasonable cap through).
  const hourly = 0.02;
  const minSeconds = 60;
  const minCost = (hourly / 3600) * minSeconds * qty;
  const hourlyCostCents = hourly * qty * 100;
  const cap = getCostCap(req);
  if (cap !== undefined && hourlyCostCents > cap) {
    return res.status(402).json({
      code: "SPEND_CAP_EXCEEDED",
      message: `Hourly burn ${hourlyCostCents.toFixed(0)}¢ exceeds cap of ${cap}¢`,
    });
  }

  // Find a matching tariff.
  const candidates = TARIFFS.filter((t) => t.country === country && t.type === type)
    .filter((t) => !carrier || t.carrier.toLowerCase().includes(carrier.toLowerCase()));
  if (candidates.length === 0) {
    return res.status(409).json(stockOut(country, carrier));
  }

  // Check stock — pick any candidate with stock.
  const picked = candidates.find((t) => (stock.get(`${t.country}/${t.carrier}`) ?? 0) >= qty);
  if (!picked) {
    return res.status(409).json(stockOut(country, carrier));
  }

  if (acc.balance_usd < minCost) {
    return res.status(402).json({ code: "INSUFFICIENT_BALANCE", message: "Top up to provision a proxy" });
  }

  // Decrement stock, debit balance, mint proxies.
  stock.set(`${picked.country}/${picked.carrier}`, (stock.get(`${picked.country}/${picked.carrier}`) ?? 0) - qty);
  acc.balance_usd -= minCost;
  acc.spend_today_usd += minCost;

  const ttlMs = parseTtl(ttl) ?? 8 * 3600 * 1000;
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const out: MockProxy[] = [];
  for (let i = 0; i < qty; i++) {
    const id = genId("px");
    const p: MockProxy = {
      id,
      host: `gw-${picked.country.toLowerCase()}.coronium.local`,
      port_http: 8000 + Math.floor(Math.random() * 999),
      port_socks5: 5000 + Math.floor(Math.random() * 999),
      username: `u_${Math.random().toString(36).slice(2, 10)}`,
      password: Math.random().toString(36).slice(2, 14),
      country: picked.country,
      region: picked.region,
      carrier: picked.carrier,
      type: picked.type,
      ip: genIPv4(),
      os,
      created_at: new Date().toISOString(),
      expires_at: expires,
      rotate_url: `http://${HOST}:${PORT}/rotate/${id}/tk_${Math.random().toString(36).slice(2)}`,
      price_per_hour_usdc: "0.02",
      rotation_policy: rotation
        ? rotation === "5m"
          ? "every_5m"
          : rotation === "10m"
            ? "every_10m"
            : rotation === "30m"
              ? "every_30m"
              : "every_1h"
        : sticky
          ? "sticky_session"
          : "manual",
      _ownerKey: acc.api_key,
      _hourly_rate_usd: hourly,
      _bought_at_ms: Date.now(),
    };
    proxies.set(id, p);
    out.push(p);
  }

  res.status(201).json(out.map(stripInternal));
});

// 7. DELETE /v1/proxies/:id
app.delete("/v1/proxies/:id", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  const p = proxies.get(req.params.id!);
  if (!p || p._ownerKey !== acc.api_key) {
    return res.status(404).json({ code: "NOT_FOUND", message: "Proxy not found or not yours" });
  }
  proxies.delete(p.id);
  stock.set(`${p.country}/${p.carrier}`, (stock.get(`${p.country}/${p.carrier}`) ?? 0) + 1);
  res.status(204).end();
});

// 8. POST /v1/proxies/:id/rotate
app.post("/v1/proxies/:id/rotate", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  const p = proxies.get(req.params.id!);
  if (!p || p._ownerKey !== acc.api_key) {
    return res.status(404).json({ code: "NOT_FOUND", message: "Proxy not found or not yours" });
  }
  const ipBefore = p.ip;
  // Simulate occasional carrier-no-op (5%).
  if (Math.random() < 0.05) {
    return res
      .status(409)
      .json({ code: "CARRIER_NO_OP", message: "Carrier did not release IP after retries", retries: 3, ip: ipBefore });
  }
  p.ip = genIPv4();
  res.json({ ip_before: ipBefore, ip_after: p.ip, duration_ms: 800 + Math.floor(Math.random() * 2000) });
});

// 9. POST /v1/proxies/:id/replace
app.post("/v1/proxies/:id/replace", requireAuth, (req, res) => {
  const acc = (req as any).account as MockAccount;
  const p = proxies.get(req.params.id!);
  if (!p || p._ownerKey !== acc.api_key) {
    return res.status(404).json({ code: "NOT_FOUND", message: "Proxy not found or not yours" });
  }
  // Atomic: release old, mint new in same country/carrier with same expiry.
  proxies.delete(p.id);
  const id = genId("px");
  const fresh: MockProxy = {
    ...p,
    id,
    ip: genIPv4(),
    username: `u_${Math.random().toString(36).slice(2, 10)}`,
    password: Math.random().toString(36).slice(2, 14),
    rotate_url: `http://${HOST}:${PORT}/rotate/${id}/tk_${Math.random().toString(36).slice(2)}`,
  };
  proxies.set(id, fresh);
  res.json(stripInternal(fresh));
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripInternal(p: MockProxy) {
  const { _ownerKey, _hourly_rate_usd, _bought_at_ms, ...pub } = p;
  return pub;
}

function stockOut(country: string, carrier: string | undefined) {
  const available = TARIFFS
    .filter((t) => (stock.get(`${t.country}/${t.carrier}`) ?? 0) > 0)
    .map((t) => ({ country: t.country, carrier: t.carrier, in_stock: stock.get(`${t.country}/${t.carrier}`) ?? 0 }));
  return {
    code: "STOCK_OUT",
    message: `No proxies in stock for ${country}${carrier ? "/" + carrier : ""}`,
    country,
    carrier,
    suggestion: { available_now: available.slice(0, 5) },
  };
}

function parseTtl(ttl: string | undefined): number | undefined {
  if (!ttl) return undefined;
  const m = ttl.match(/^(\d+)\s*([mhd])$/i);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  return n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

// ─── Boot ──────────────────────────────────────────────────────────────────

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[mock-api] error:", err);
  res.status(500).json({ code: "INTERNAL", message: err?.message || "internal error" });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, HOST, () => {
    console.log(`[mock-api] listening on http://${HOST}:${PORT}`);
    console.log(`[mock-api] CORONIUM_BASE_URL=http://${HOST}:${PORT}/v1`);
  });
}

export { app };
