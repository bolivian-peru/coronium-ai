// In-process mock of cor-api-v1's agent endpoint. Lets us exercise the full
// app under test without touching real infrastructure.
//
// Usage in tests:
//   beforeAll(async () => { mock = await startUpstreamMock(); process.env.UPSTREAM_API_URL = mock.url; })
//   afterAll(async () => { await mock.close(); })

import http from "node:http";
import { randomBytes } from "node:crypto";

interface MockState {
  users: Map<string, { id: string; email?: string; balance_usd: number; deposit_address_usdc_base: string }>;
  proxies: Map<string, any>;
}

export async function startUpstreamMock() {
  const state: MockState = { users: new Map(), proxies: new Map() };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

    const send = (status: number, payload?: any) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    const url = new URL(req.url!, "http://x");
    const path = url.pathname;
    const method = req.method!;

    // Auth check.
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) return send(401, { code: "AUTH", message: "missing bearer" });

    if (method === "POST" && path === "/users") {
      const id = "uu_" + randomBytes(6).toString("hex");
      const u = {
        id,
        email: body?.email,
        balance_usd: 0.5,
        deposit_address_usdc_base: "0x" + randomBytes(20).toString("hex"),
      };
      state.users.set(id, u);
      return send(201, u);
    }

    const balanceMatch = path.match(/^\/users\/([^/]+)\/balance$/);
    if (method === "GET" && balanceMatch) {
      const u = state.users.get(balanceMatch[1]!);
      if (!u) return send(404, { code: "NOT_FOUND", message: "user not found" });
      return send(200, { balance_usd: u.balance_usd });
    }

    if (method === "POST" && path === "/deposit/address") {
      const u = state.users.get(body?.upstream_user_id);
      if (!u) return send(404, { code: "NOT_FOUND", message: "user not found" });
      return send(200, {
        chain: body.chain,
        address: u.deposit_address_usdc_base,
        qr: "data:image/png;base64,iVBORw0KGgo=",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        amount_usd: body.amount_usd ?? null,
      });
    }

    if (method === "GET" && path.startsWith("/tariffs")) {
      const country = url.searchParams.get("country");
      const type = url.searchParams.get("type");
      const all = [
        { id: "trf_us_tmobile_5g", country: "US", carrier: "T-Mobile", type: "5g", period_hours: 24, price_usd: 0.48, in_stock: true },
        { id: "trf_de_o2_4g", country: "DE", carrier: "O2", type: "4g", period_hours: 24, price_usd: 0.48, in_stock: true },
      ];
      let list = all;
      if (country) list = list.filter((t) => t.country === country.toUpperCase());
      if (type) list = list.filter((t) => t.type === type);
      return send(200, list);
    }

    const proxyListMatch = path.match(/^\/users\/([^/]+)\/proxies$/);
    if (method === "GET" && proxyListMatch) {
      const userId = proxyListMatch[1]!;
      return send(200, [...state.proxies.values()].filter((p) => p._userId === userId));
    }

    if (method === "POST" && path === "/proxies") {
      const country = String(body?.country || "").toUpperCase();
      if (country === "ZZ") {
        return send(409, {
          code: "STOCK_OUT",
          message: "no proxies",
          country,
          suggestion: { available_now: [{ country: "US", carrier: "T-Mobile", in_stock: 5 }] },
        });
      }
      const out = [];
      for (let i = 0; i < (body.qty ?? 1); i++) {
        const id = "px_" + randomBytes(6).toString("hex").toUpperCase();
        const p = {
          id,
          host: `gw-${country.toLowerCase()}.coronium.local`,
          port_http: 8000 + Math.floor(Math.random() * 999),
          port_socks5: 5000 + Math.floor(Math.random() * 999),
          username: "u_" + randomBytes(4).toString("hex"),
          password: randomBytes(6).toString("hex"),
          country,
          region: country + "-East",
          carrier: "T-Mobile",
          type: body.type ?? "5g",
          ip: `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.1`,
          os: body.os ?? "",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
          rotate_url: `http://localhost/rotate/${id}/tk`,
          rotation_policy: body.rotation ? "every_10m" : "manual",
          _userId: body.upstream_user_id,
        };
        state.proxies.set(id, p);
        out.push(p);
      }
      return send(201, out);
    }

    const proxyDeleteMatch = path.match(/^\/users\/[^/]+\/proxies\/([^/]+)$/);
    if (method === "DELETE" && proxyDeleteMatch) {
      const id = proxyDeleteMatch[1]!;
      if (!state.proxies.has(id)) return send(404, { code: "NOT_FOUND", message: "proxy not found" });
      state.proxies.delete(id);
      return send(204);
    }

    const rotateMatch = path.match(/^\/users\/[^/]+\/proxies\/([^/]+)\/rotate$/);
    if (method === "POST" && rotateMatch) {
      const id = rotateMatch[1]!;
      const p = state.proxies.get(id);
      if (!p) return send(404, { code: "NOT_FOUND", message: "proxy not found" });
      const before = p.ip;
      p.ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 254)}`;
      return send(200, { ip_before: before, ip_after: p.ip, duration_ms: 1200 });
    }

    const replaceMatch = path.match(/^\/users\/[^/]+\/proxies\/([^/]+)\/replace$/);
    if (method === "POST" && replaceMatch) {
      const id = replaceMatch[1]!;
      const p = state.proxies.get(id);
      if (!p) return send(404, { code: "NOT_FOUND", message: "proxy not found" });
      state.proxies.delete(id);
      const fresh = { ...p, id: "px_" + randomBytes(6).toString("hex").toUpperCase(), ip: "10.99.99.99" };
      state.proxies.set(fresh.id, fresh);
      return send(200, fresh);
    }

    return send(404, { code: "NOT_FOUND", message: `mock has no handler for ${method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
