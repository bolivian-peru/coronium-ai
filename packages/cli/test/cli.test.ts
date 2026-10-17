// Behaviour tests: the built CLI runs as a child process with an isolated HOME
// against the loopback /api/v3 replica. Nothing reaches production.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIXTURE_TOKEN,
  installCatalog,
  SAMPLE_PROXY,
  startFixtureServer,
  type FixtureServer,
} from "../../sdk-ts/test/support/fixture-server.js";

const CLI: string = new URL("../dist/index.js", import.meta.url).pathname;
const TARIFF_ID: string = "61effbaf5a33f238ac15a911"; // US T-Mobile 7-day, $49, stock 2

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

let server: FixtureServer;
let home: string;

function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NO_COLOR: "1",
    CORONIUM_BASE_URL: server.baseUrl,
    CORONIUM_API_TOKEN: FIXTURE_TOKEN,
    ...env,
  };
  return new Promise((resolve: (result: RunResult) => void): void => {
    execFile("node", [CLI, ...args], { env: childEnv }, (error, stdout: string, stderr: string): void => {
      let code: number = 0;
      if (error) code = typeof error.code === "number" ? error.code : 1;
      resolve({ stdout, stderr, code });
    });
  });
}

function paymentPosts(): number {
  return server.requests.filter((request) => request.path.startsWith("/payment/buy") || request.path.startsWith("/payment/renew-")).length;
}

beforeEach(async () => {
  server = await startFixtureServer();
  installCatalog(server);
  server.on("GET /account/proxies", () => ({ body: { data: [SAMPLE_PROXY] } }));
  server.on("GET /account", () => ({ body: { _id: "u1", login: "ana", accountCredit: 120, btc: { balance: 0 }, usdt: { balance: 0 } } }));
  home = await mkdtemp(join(tmpdir(), "coronium-cli-"));
});

afterEach(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true });
});

describe("basics", () => {
  it("--version prints the package version and contract id", async () => {
    const result: RunResult = await run(["--version"]);
    expect(result.stdout.trim()).toMatch(/^1\.0\.0 \(contract v3@/);
  });

  it("--help lists the real commands and no dead links", async () => {
    const result: RunResult = await run(["--help"]);
    for (const command of ["login", "init", "key:rotate", "balance", "tariffs", "stock", "proxy", "buy", "renew", "tickets", "webhook"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).not.toContain("coronium.ai/free");
    expect(result.stdout).not.toMatch(/[\u2013\u2014]/);
  });

  it("refuses resource commands without a token (exit 2)", async () => {
    const result: RunResult = await run(["balance"], { CORONIUM_API_TOKEN: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/CORONIUM_API_TOKEN|coronium login/);
  });

  it("refuses the removed `proxy get` with a migration hint (exit 2)", async () => {
    const result: RunResult = await run(["proxy", "get", "--country", "US"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("coronium buy");
  });

  it("login --token verifies and stores the token with mode 0600", async () => {
    const result: RunResult = await run(["login", "--token", FIXTURE_TOKEN], { CORONIUM_API_TOKEN: "" });
    expect(result.code).toBe(0);
    const path: string = join(home, ".coronium", "config.toml");
    expect(await readFile(path, "utf8")).toContain(FIXTURE_TOKEN);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const after: RunResult = await run(["balance"], { CORONIUM_API_TOKEN: "" });
    expect(after.stdout).toContain("$120.00");
  });

  it("status --json reports a healthy API and a valid token", async () => {
    const result: RunResult = await run(["status", "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.api.ok).toBe(true);
    expect(parsed.auth.ok).toBe(true);
    expect(parsed.spending_enabled).toBe(false);
    expect(result.code).toBe(0);
  });
});

describe("no fake success", () => {
  it("every command fails loudly when the base URL points at routes that do not exist", async () => {
    const wrongBase: string = server.baseUrl.replace("/api/v3", "/api/v9");
    for (const args of [["balance"], ["proxy", "list"], ["tariffs"], ["status"]]) {
      const result: RunResult = await run(args, { CORONIUM_BASE_URL: wrongBase });
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.stdout, args.join(" ")).not.toContain("✓");
    }
  });

  it("an HTML 200 is an error, not data", async () => {
    server.on("GET /account/proxies", () => ({ text: "<h1>API Server</h1>", contentType: "text/html" }));
    const result: RunResult = await run(["proxy", "list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid_response");
  });

  it("never puts the token in a URL", async () => {
    await run(["balance"]);
    await run(["proxy", "list"]);
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) expect(request.url).not.toContain(FIXTURE_TOKEN);
  });
});

describe("proxies", () => {
  it("prints usable, encoded connection URLs", async () => {
    const result: RunResult = await run(["proxy", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("http://user01:p%40ss%20word@198.51.100.7:8001");
    expect(result.stdout).toContain("socks5://user01:p%40ss%20word@198.51.100.7:9001");
  });

  it("prints rotating for a 202 and exits 0", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({ status: 202, body: { result: "ok", accepted: true, rotated: false, pending: true } }));
    const result: RunResult = await run(["proxy", "rotate", "us_tmobile_01"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rotating");
    expect(result.stdout).not.toContain("✓");
  });

  it("exits 1 when the IP did not change", async () => {
    server.on("POST /modems/:modem_id/restart", () => ({ body: { result: "ok", rotated: false, ip: "1.1.1.1" } }));
    const result: RunResult = await run(["proxy", "rotate", "us_tmobile_01"]);
    expect(result.code).toBe(1);
  });

  it("replace needs --yes", async () => {
    const result: RunResult = await run(["proxy", "replace", "us_tmobile_01"]);
    expect(result.code).toBe(2);
    expect(server.requests.some((request) => request.path.endsWith("/replace"))).toBe(false);
  });

  it("exits 1 when the connectivity check fails", async () => {
    server.on("POST /modems/:modem_id/test", () => ({ body: { error: "Modem unavailable!" } }));
    const result: RunResult = await run(["proxy", "test", "us_tmobile_01"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Modem unavailable!");
  });
});

describe("spending", () => {
  const buyArgs: string[] = ["buy", "--tariff", TARIFF_ID, "--count", "2", "--funding", "account_credit"];

  it("is off by default: shows the price, charges nothing, exits 2", async () => {
    const result: RunResult = await run([...buyArgs, "--max-total", "98", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("$98.00");
    expect(result.stderr).toContain("Spending is off");
    expect(paymentPosts()).toBe(0);
  });

  it("requires --max-total and --yes even with spending on", async () => {
    const env: Record<string, string> = { CORONIUM_ALLOW_SPENDING: "1" };
    const noMax: RunResult = await run([...buyArgs, "--yes"], env);
    expect(noMax.code).toBe(2);
    const noYes: RunResult = await run([...buyArgs, "--max-total", "98"], env);
    expect(noYes.code).toBe(2);
    expect(noYes.stdout).toContain("$98.00");
    expect(paymentPosts()).toBe(0);
  });

  it("refuses a stale total with price_changed and charges nothing", async () => {
    const result: RunResult = await run([...buyArgs, "--max-total", "90", "--yes"], { CORONIUM_ALLOW_SPENDING: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("price_changed");
    expect(paymentPosts()).toBe(0);
  });

  it("buys when every gate is present", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({
      body: { result: "ok", charged_usd: 98, data: [SAMPLE_PROXY, { ...SAMPLE_PROXY, _id: "x2", name: "us_tmobile_02" }] },
    }));
    const result: RunResult = await run([...buyArgs, "--max-total", "98", "--yes"], { CORONIUM_ALLOW_SPENDING: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Charged $98.00");
    expect(paymentPosts()).toBe(1);
  });

  it("exits 3 when the outcome is unknown", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({ status: 500, body: { error: "provisioning failed" } }));
    const result: RunResult = await run([...buyArgs, "--max-total", "98", "--yes"], { CORONIUM_ALLOW_SPENDING: "1" });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Check before trying again");
  });

  it("exits 4 when the order was refunded", async () => {
    server.on("POST /payment/buy-with-account-credit", () => ({ status: 503, body: { error: "Out of stock", code: "no_stock", refunded: true } }));
    const result: RunResult = await run([...buyArgs, "--max-total", "98", "--yes"], { CORONIUM_ALLOW_SPENDING: "1" });
    expect(result.code).toBe(4);
  });

  it("`spending on` persists the opt-in", async () => {
    const on: RunResult = await run(["spending", "on"]);
    expect(on.code).toBe(0);
    const status: RunResult = await run(["spending", "status", "--json"]);
    expect(JSON.parse(status.stdout).spending_enabled).toBe(true);
  });
});
