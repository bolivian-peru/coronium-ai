#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Coronium, CoroniumError, CoroniumStockOutError } from "@coronium/sdk-ts";
import { z } from "zod";

const apiKey = process.env.CORONIUM_API_KEY;
if (!apiKey) {
  console.error(
    "[coronium-mcp] CORONIUM_API_KEY is required. Get one at https://coronium.ai or run `npx -y @coronium/cli init`.",
  );
  process.exit(2);
}

const baseUrl = process.env.CORONIUM_BASE_URL;
const sessionCapCents = process.env.CORONIUM_COST_CAP_CENTS
  ? Number(process.env.CORONIUM_COST_CAP_CENTS)
  : undefined;

const client = new Coronium({
  apiKey,
  baseUrl,
  costCapCents: sessionCapCents,
  userAgent: "coronium-mcp/0.1.0",
});

// ─── Tool schemas (Zod, mirroring openapi.yaml) ────────────────────────────

const balanceGetSchema = z.object({});

const depositAddressSchema = z.object({
  chain: z.enum(["base", "tron", "ethereum"]).optional().describe("Chain for the deposit address. Default: base."),
  amount_usd: z.number().positive().optional().describe("Optional — pre-creates an invoice + QR for this USD amount."),
});

const tariffListSchema = z.object({
  country: z.string().length(2).optional().describe("ISO-2 country code, e.g. US, GB, DE."),
  carrier: z.string().optional().describe("Carrier name, e.g. tmobile, verizon, three."),
  type: z.enum(["4g", "5g"]).optional(),
});

const proxyGetSchema = z.object({
  country: z.string().length(2).describe("ISO-2 country code, e.g. US, GB, DE."),
  type: z.enum(["4g", "5g"]).optional().describe("Default 5g."),
  carrier: z.string().optional().describe("Specific carrier (omit to let us pick)."),
  qty: z.number().int().min(1).max(50).optional().describe("Quantity, 1-50. Default 1."),
  ttl: z.string().optional().describe("Subscription length, e.g. 1h, 8h, 24h, 7d, 30d."),
  rotation: z.string().optional().describe("Auto-rotation interval, e.g. 10m, 1h. Omit for manual."),
  sticky: z.boolean().optional().describe("Keep same IP across requests (carrier-dependent)."),
  cost_cap_cents: z.number().int().positive().optional().describe("Override per-call spend cap, in cents."),
});

const proxyListSchema = z.object({});

const proxyIdSchema = z.object({
  id: z.string().describe("Proxy id, e.g. px_01HX8A9R3K2Q."),
});

const tools = [
  {
    name: "balance_get",
    description: "Get USDC balance, hours-at-current-burn, and spend caps for the authenticated account.",
    inputSchema: zodToJsonSchema(balanceGetSchema),
  },
  {
    name: "deposit_address",
    description: "Get a USDC deposit address (Base / Tron / Ethereum). Optionally pre-create an invoice with QR.",
    inputSchema: zodToJsonSchema(depositAddressSchema),
  },
  {
    name: "tariff_list",
    description: "List available proxy plans, optionally filtered by country, carrier, or 4g/5g.",
    inputSchema: zodToJsonSchema(tariffListSchema),
  },
  {
    name: "proxy_get",
    description:
      "Buy one or more mobile proxies. Stock-validated before charging. Returns full credentials (host, ports, username, password). 409 STOCK_OUT includes `suggestion.available_now` with alternatives.",
    inputSchema: zodToJsonSchema(proxyGetSchema),
  },
  {
    name: "proxy_list",
    description: "List your active proxies.",
    inputSchema: zodToJsonSchema(proxyListSchema),
  },
  {
    name: "proxy_rotate",
    description:
      "Rotate the IP on a proxy. Verified — returns the new IP only after Coronium confirms it changed externally. 409 CARRIER_NO_OP if the carrier didn't release; try `proxy_replace` instead.",
    inputSchema: zodToJsonSchema(proxyIdSchema),
  },
  {
    name: "proxy_replace",
    description:
      "Replace a stuck proxy with a fresh modem in the same country/carrier. Atomic: old released, new assigned, credentials returned.",
    inputSchema: zodToJsonSchema(proxyIdSchema),
  },
  {
    name: "proxy_release",
    description: "Release a proxy. Charged through end-of-current-hour, no proration.",
    inputSchema: zodToJsonSchema(proxyIdSchema),
  },
];

const server = new Server(
  { name: "coronium", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "balance_get": {
        balanceGetSchema.parse(args);
        return ok(await client.balance.get());
      }
      case "deposit_address": {
        const input = depositAddressSchema.parse(args);
        return ok(await client.deposit.address(input));
      }
      case "tariff_list": {
        const input = tariffListSchema.parse(args);
        return ok(await client.tariffs.list(input));
      }
      case "proxy_get": {
        const input = proxyGetSchema.parse(args);
        const { cost_cap_cents, ...buy } = input;
        return ok(await client.proxies.buy(buy, { costCapCents: cost_cap_cents }));
      }
      case "proxy_list": {
        proxyListSchema.parse(args);
        return ok(await client.proxies.list());
      }
      case "proxy_rotate": {
        const { id } = proxyIdSchema.parse(args);
        return ok(await client.proxies.rotate(id));
      }
      case "proxy_replace": {
        const { id } = proxyIdSchema.parse(args);
        return ok(await client.proxies.replace(id));
      }
      case "proxy_release": {
        const { id } = proxyIdSchema.parse(args);
        await client.proxies.release(id);
        return ok({ id, released: true });
      }
      default:
        return errText(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return mapError(e);
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error("[coronium-mcp] failed to connect:", e);
  process.exit(1);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errText(text: string, isError: boolean) {
  return {
    isError,
    content: [{ type: "text" as const, text }],
  };
}

function mapError(e: unknown) {
  if (e instanceof CoroniumStockOutError) {
    return errText(
      JSON.stringify(
        { code: e.code, message: e.message, suggestions: e.suggestions },
        null,
        2,
      ),
      true,
    );
  }
  if (e instanceof CoroniumError) {
    return errText(JSON.stringify({ code: e.code, message: e.message, status: e.status }, null, 2), true);
  }
  if (e instanceof z.ZodError) {
    return errText(JSON.stringify({ code: "INVALID_INPUT", issues: e.issues }, null, 2), true);
  }
  if (e instanceof Error) return errText(e.message, true);
  return errText(String(e), true);
}

function zodToJsonSchema(schema: z.ZodType<any>): Record<string, unknown> {
  // Hand-rolled translation for the small set of types we use. The official
  // zod-to-json-schema package would pull in a heavy dep; the schemas here
  // are tiny and stable.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType<any>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    const out: Record<string, unknown> = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length) out.required = required;
    return out;
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string" };
    const desc = (schema as any)._def?.description;
    if (desc) out.description = desc;
    const checks = (schema as any)._def?.checks ?? [];
    for (const c of checks) {
      if (c.kind === "length") {
        out.minLength = c.value;
        out.maxLength = c.value;
      }
    }
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: "number" };
    const desc = (schema as any)._def?.description;
    if (desc) out.description = desc;
    const checks = (schema as any)._def?.checks ?? [];
    if (checks.some((c: any) => c.kind === "int")) out.type = "integer";
    for (const c of checks) {
      if (c.kind === "min") out.minimum = c.value;
      if (c.kind === "max") out.maximum = c.value;
    }
    return out;
  }
  if (schema instanceof z.ZodBoolean) {
    const out: Record<string, unknown> = { type: "boolean" };
    const desc = (schema as any)._def?.description;
    if (desc) out.description = desc;
    return out;
  }
  if (schema instanceof z.ZodEnum) {
    const out: Record<string, unknown> = { type: "string", enum: schema.options };
    const desc = (schema as any)._def?.description;
    if (desc) out.description = desc;
    return out;
  }
  return { type: "string" };
}
