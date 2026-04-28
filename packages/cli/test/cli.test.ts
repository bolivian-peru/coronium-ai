import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const CLI = new URL("../dist/index.js", import.meta.url).pathname;

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await exec("node", [CLI, ...args], { env: { ...process.env, NO_COLOR: "1" } });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.code ?? 1 };
  }
}

describe("coronium-cli", () => {
  it("--version prints semver", async () => {
    const r = await run(["--version"]);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help lists every command including key:rotate", async () => {
    const r = await run(["--help"]);
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("key:rotate");
    expect(r.stdout).toContain("balance");
    expect(r.stdout).toContain("deposit");
    expect(r.stdout).toContain("tariffs");
    expect(r.stdout).toContain("proxy");
  });

  it("init --help shows voucher + restore options", async () => {
    const r = await run(["init", "--help"]);
    expect(r.stdout).toContain("--voucher");
    expect(r.stdout).toContain("--restore");
  });

  it("proxy --help shows all subcommands", async () => {
    const r = await run(["proxy", "--help"]);
    expect(r.stdout).toContain("get");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("rotate");
    expect(r.stdout).toContain("replace");
    expect(r.stdout).toContain("release");
  });

  it("balance without API key exits with helpful error", async () => {
    const r = await run(["balance"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/CORONIUM_API_KEY|coronium init/);
  });
});
