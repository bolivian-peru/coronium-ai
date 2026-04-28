#!/usr/bin/env node
import { Command } from "commander";
import kleur from "kleur";
import { CoroniumError } from "coronium-sdk";
import { initCommand } from "./commands/init.js";
import { balanceCommand } from "./commands/balance.js";
import { depositCommand } from "./commands/deposit.js";
import { tariffsCommand } from "./commands/tariffs.js";
import {
  proxyGetCommand,
  proxyListCommand,
  proxyRotateCommand,
  proxyReplaceCommand,
  proxyReleaseCommand,
} from "./commands/proxy.js";

const program = new Command();

program
  .name("coronium")
  .description("Mobile 4G/5G proxies — pay-per-hour USDC. https://coronium.ai")
  .version("0.1.0-alpha.0")
  .option("--json", "emit machine-readable JSON instead of pretty output");

program
  .command("init")
  .description("Create an account and store the API key in ~/.coronium/config.toml")
  .option("--email <email>", "optional email, for receipts only")
  .option("--api-key <key>", "skip account creation; just store an existing key")
  .action((opts, cmd) => initCommand({ ...opts, ...cmd.optsWithGlobals() }));

program
  .command("balance")
  .description("Show USDC balance and spend caps")
  .action((_opts, cmd) => balanceCommand(cmd.optsWithGlobals()));

program
  .command("deposit")
  .description("Get a USDC deposit address (Base / Tron / Ethereum)")
  .option("--chain <chain>", "base | tron | ethereum", "base")
  .option("--amount <usd>", "pre-create an invoice + QR for this USD amount")
  .action((opts, cmd) => depositCommand({ ...opts, ...cmd.optsWithGlobals() }));

program
  .command("tariffs")
  .description("List available proxy plans")
  .option("--country <iso2>", "filter by ISO-2 country code (e.g. US, GB, DE)")
  .option("--carrier <name>", "filter by carrier (e.g. tmobile, verizon)")
  .option("--type <type>", "filter by 4g | 5g")
  .action((opts, cmd) => tariffsCommand({ ...opts, ...cmd.optsWithGlobals() }));

const proxy = program.command("proxy").description("Manage proxies (the hero verbs)");

proxy
  .command("get")
  .description("Buy a proxy")
  .requiredOption("--country <iso2>", "ISO-2 country code")
  .option("--type <type>", "4g | 5g", "5g")
  .option("--carrier <name>", "specific carrier (omit to let us pick)")
  .option("--qty <n>", "quantity (1-50)", "1")
  .option("--ttl <duration>", "subscription length, e.g. 1h, 8h, 24h, 7d, 30d")
  .option("--rotation <interval>", "auto-rotate interval, e.g. 10m, 1h")
  .option("--sticky", "keep same IP across requests (carrier-dependent)")
  .option("--cost-cap-cents <n>", "override per-call spend cap (cents)")
  .action((opts, cmd) => proxyGetCommand({ ...opts, ...cmd.optsWithGlobals() }));

proxy
  .command("list")
  .description("List your active proxies")
  .action((_opts, cmd) => proxyListCommand(cmd.optsWithGlobals()));

proxy
  .command("rotate <id>")
  .description("Rotate the IP on a proxy (verified — never reports false success)")
  .action((id, _opts, cmd) => proxyRotateCommand(id, cmd.optsWithGlobals()));

proxy
  .command("replace <id>")
  .description("Replace a stuck proxy with a fresh modem in the same country/carrier")
  .action((id, _opts, cmd) => proxyReplaceCommand(id, cmd.optsWithGlobals()));

proxy
  .command("release <id>")
  .description("Release a proxy (charged through end-of-current-hour)")
  .action((id, _opts, cmd) => proxyReleaseCommand(id, cmd.optsWithGlobals()));

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof CoroniumError) {
    console.error(kleur.red(`error[${e.code}]`) + ` ${e.message}`);
    process.exit(1);
  }
  if (e instanceof Error) console.error(kleur.red("error") + ` ${e.message}`);
  else console.error(kleur.red("error"), e);
  process.exit(1);
});
