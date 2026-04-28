import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Smoke test: ensure the built MCP entrypoint registers all 8 tools the
// spec promises. We parse the dist file as text rather than importing it
// (importing would attempt to start the MCP transport and bail on missing
// CORONIUM_API_KEY).

const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const source = readFileSync(distPath, "utf8");

describe("coronium-mcp", () => {
  it("registers all 8 tools by name", () => {
    const expected = [
      "balance_get",
      "deposit_address",
      "tariff_list",
      "proxy_get",
      "proxy_list",
      "proxy_rotate",
      "proxy_replace",
      "proxy_release",
    ];
    for (const name of expected) {
      expect(source).toContain(`name: "${name}"`);
    }
  });

  it("declares CORONIUM_API_KEY as required env", () => {
    expect(source).toContain("CORONIUM_API_KEY");
  });

  it("exports a stdio transport", () => {
    expect(source).toMatch(/StdioServerTransport/);
  });
});
