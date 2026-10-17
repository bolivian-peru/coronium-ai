#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { CONTRACT_ID, CoroniumError } from "coronium-sdk";
import { balanceCommand, paymentCommand } from "./commands/account.js";
import { loginCommand, logoutCommand } from "./commands/auth.js";
import { countriesCommand, quoteBuyCommand, quoteRenewCommand, stockCommand, tariffsCommand } from "./commands/catalog.js";
import { initCommand } from "./commands/init.js";
import { keyRotateCommand } from "./commands/key.js";
import {
  proxyGetRemoved,
  proxyListCommand,
  proxyOpenVpnCommand,
  proxyReplaceCommand,
  proxyRotateCommand,
  proxyRotationStatusCommand,
  proxyShowCommand,
  proxyTestCommand,
  proxyWhitelistCommand,
} from "./commands/proxy.js";
import { buyCommand, renewCommand, spendingSetCommand } from "./commands/spending.js";
import { statusCommand } from "./commands/status.js";
import {
  ticketArchiveCommand,
  ticketCreateCommand,
  ticketReplyCommand,
  ticketShowCommand,
  ticketsListCommand,
} from "./commands/tickets.js";
import { walletDecryptCommand, walletEncryptCommand } from "./commands/wallet.js";
import {
  webhookDeleteCommand,
  webhookRotateSecretCommand,
  webhookSetCommand,
  webhookShowCommand,
  webhookTestCommand,
} from "./commands/webhook.js";
import {
  formatCoroniumError,
  formatUnknownError,
  formatUsageError,
  printJsonError,
  printPretty,
  type FormattedError,
} from "./format-error.js";
import { EXIT_OK, EXIT_USAGE, ExitWith, UsageError } from "./output.js";
import { CLI_VERSION } from "./version.js";

type Options = Record<string, unknown>;

/** Merge a command's own options with the global ones (such as --json). */
function withGlobals(command: Command): Options {
  return command.optsWithGlobals() as Options;
}

const program: Command = new Command();

// Throw instead of exiting so usage errors get exit code 2. Subcommands inherit this.
program.exitOverride();

program
  .name("coronium")
  .description("Manage Coronium dedicated 4G/5G mobile proxies from your shell.")
  .version(`${CLI_VERSION} (contract ${CONTRACT_ID})`)
  .option("--json", "print machine-readable JSON")
  .addHelpText(
    "after",
    [
      "",
      "Authentication: set CORONIUM_API_TOKEN or run `coronium login --token <token>`.",
      "Create a token at dashboard.coronium.io (Account, API Access).",
      "",
      "Exit codes: 0 ok, 1 rejected, 2 usage, 3 outcome unknown (check before retrying), 4 refunded.",
      "",
    ].join("\n"),
  );

// ----- auth -----
program
  .command("login")
  .description("Store an API token (verified against the API unless --no-verify)")
  .option("--token <token>", "API token; omit to be prompted")
  .option("--no-verify", "store without checking the token")
  .action((_options: Options, command: Command) => loginCommand(withGlobals(command)));

program
  .command("logout")
  .description("Remove the stored API token")
  .action((_options: Options, command: Command) => logoutCommand(withGlobals(command)));

program
  .command("init")
  .description("Wallet-bound sign-up with a voucher, restore from a wallet, or store a token")
  .option("--voucher <code>", "voucher code (cor_v1_...); also reads CORONIUM_VOUCHER")
  .option("--restore", "restore an existing account from your wallet")
  .option("--no-prompt", "headless mode: fail instead of prompting")
  .option("--print-mnemonic", "include a newly generated mnemonic in the output")
  .option("--wallet-from <source>", "new, mnemonic or privkey")
  .option("--email <email>", "optional email tag")
  .option("--api-key <token>", "just store an existing API token (same as login --no-verify)")
  .action((_options: Options, command: Command) => initCommand(withGlobals(command)));

program
  .command("key:rotate")
  .description("Get a new API token by signing a challenge with your wallet")
  .action((_options: Options, command: Command) => keyRotateCommand(withGlobals(command)));

program
  .command("wallet:encrypt")
  .description("Encrypt ~/.coronium/wallet.json with a passphrase (AES-256-GCM, scrypt)")
  .action((_options: Options, command: Command) => walletEncryptCommand(withGlobals(command)));

program
  .command("wallet:decrypt")
  .description("Decrypt the wallet file back to plaintext")
  .action((_options: Options, command: Command) => walletDecryptCommand(withGlobals(command)));

program
  .command("status")
  .description("Check the API, your token and local setup")
  .action((_options: Options, command: Command) => statusCommand(withGlobals(command)));

// ----- account -----
program
  .command("balance")
  .description("Show account credit and BTC/USDT balances")
  .option("--crypto", "also list deposit addresses (creates deposit wallets on first use)")
  .action((_options: Options, command: Command) => balanceCommand(withGlobals(command)));

program
  .command("payment <id>")
  .description("Show the status of a payment")
  .action((id: string, _options: Options, command: Command) => paymentCommand(id, withGlobals(command)));

// ----- catalog -----
program
  .command("countries")
  .description("List countries and carriers")
  .action((_options: Options, command: Command) => countriesCommand(withGlobals(command)));

program
  .command("tariffs")
  .description("List plans in stock with prices")
  .option("--country <cc>", "ISO-2 country code, for example US")
  .option("--carrier <name>", "carrier name, for example verizon")
  .action((_options: Options, command: Command) => tariffsCommand(withGlobals(command)));

program
  .command("stock")
  .description("Show proxies in stock by country, carrier and region")
  .option("--country <cc>", "ISO-2 country code")
  .option("--carrier-id <id>", "carrier id from `coronium countries --json`")
  .action((_options: Options, command: Command) => stockCommand(withGlobals(command)));

const quote: Command = program.command("quote").description("Price an order without paying");

quote
  .command("buy")
  .description("Price new proxies: plan price x count")
  .requiredOption("--tariff <id>", "plan id from `coronium tariffs`")
  .option("--count <n>", "number of proxies", "1")
  .action((_options: Options, command: Command) => quoteBuyCommand(withGlobals(command)));

quote
  .command("renew <items...>")
  .description("Price a renewal; items are <proxy id>:<days> (1 to 90)")
  .option("--coupon <code>", "coupon code")
  .action((items: string[], _options: Options, command: Command) => quoteRenewCommand(items, withGlobals(command)));

// ----- proxies -----
const proxy: Command = program.command("proxy").description("Manage the proxies you own");

proxy
  .command("list")
  .description("List your proxies with HTTP and SOCKS5 URLs")
  .action((_options: Options, command: Command) => proxyListCommand(withGlobals(command)));

proxy
  .command("show <id>")
  .description("Show one proxy (id, name or port id)")
  .action((id: string, _options: Options, command: Command) => proxyShowCommand(id, withGlobals(command)));

proxy
  .command("rotate <id>")
  .description("Get a new IP from the carrier (connections drop briefly)")
  .option("--wait", "wait for an asynchronous rotation to finish")
  .action((id: string, _options: Options, command: Command) => proxyRotateCommand(id, withGlobals(command)));

proxy
  .command("rotation-status <id>")
  .description("Show the state of the last rotation")
  .action((id: string, _options: Options, command: Command) => proxyRotationStatusCommand(id, withGlobals(command)));

proxy
  .command("replace <id>")
  .description("Swap for another modem: new host and credentials (needs --yes)")
  .option("--yes", "confirm")
  .action((id: string, _options: Options, command: Command) => proxyReplaceCommand(id, withGlobals(command)));

proxy
  .command("openvpn <id>")
  .description("Download the OpenVPN profile (contains secrets)")
  .option("--tcp", "TCP profile")
  .option("--out <file>", "write to a file (mode 0600) instead of stdout")
  .action((id: string, _options: Options, command: Command) => proxyOpenVpnCommand(id, withGlobals(command)));

proxy
  .command("test <id>")
  .description("Run the API's connectivity check")
  .action((id: string, _options: Options, command: Command) => proxyTestCommand(id, withGlobals(command)));

proxy
  .command("whitelist <id> [ips...]")
  .description("Replace the IP whitelist, Coronium Node proxies only (needs --yes)")
  .option("--yes", "confirm")
  .action((id: string, ips: string[], _options: Options, command: Command) => proxyWhitelistCommand(id, ips, withGlobals(command)));

proxy
  .command("get", { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => proxyGetRemoved());

// ----- spending -----
program
  .command("buy")
  .description("CHARGES MONEY. Buy proxies; needs spending on, --max-total and --yes")
  .requiredOption("--tariff <id>", "plan id from `coronium tariffs`")
  .option("--count <n>", "number of proxies", "1")
  .option("--funding <source>", "account_credit or btc")
  .option("--max-total <usd>", "the most you approve for this order")
  .option("--yes", "place the order")
  .option("--coupon <code>", "coupon code")
  .option("--key <idempotency-key>", "reuse only to reconcile the same order")
  .action((_options: Options, command: Command) => buyCommand(withGlobals(command)));

program
  .command("renew <items...>")
  .description("CHARGES MONEY. Renew proxies (<id>:<days>); needs spending on, --max-total and --yes")
  .option("--funding <source>", "account_credit or btc")
  .option("--max-total <usd>", "the most you approve for this renewal")
  .option("--yes", "place the order")
  .option("--coupon <code>", "coupon code")
  .option("--key <idempotency-key>", "reuse only to reconcile the same order")
  .action((items: string[], _options: Options, command: Command) => renewCommand(items, withGlobals(command)));

program
  .command("spending <state>")
  .description("Turn buy and renew on or off: on, off or status (off by default)")
  .action((state: string, _options: Options, command: Command) => spendingSetCommand(state, withGlobals(command)));

// ----- tickets -----
const tickets: Command = program.command("tickets").description("Support tickets");

tickets
  .command("list")
  .option("--status <status>", "open, pending, resolved or closed")
  .option("--limit <n>", "1 to 100")
  .action((_options: Options, command: Command) => ticketsListCommand(withGlobals(command)));

tickets
  .command("show <id>")
  .action((id: string, _options: Options, command: Command) => ticketShowCommand(id, withGlobals(command)));

tickets
  .command("create")
  .requiredOption("--subject <text>", "short summary")
  .requiredOption("--message <text>", "what happened")
  .option("--category <name>", "category, default general")
  .option("--proxy <id...>", "related proxy ids")
  .action((_options: Options, command: Command) => ticketCreateCommand(withGlobals(command)));

tickets
  .command("reply <id> <message>")
  .action((id: string, message: string, _options: Options, command: Command) => ticketReplyCommand(id, message, withGlobals(command)));

tickets
  .command("archive <id>")
  .description("Hide a ticket from your list (does not close it)")
  .action((id: string, _options: Options, command: Command) => ticketArchiveCommand(id, withGlobals(command)));

// ----- webhook -----
const webhook: Command = program.command("webhook").description("Account webhook for proxy events");

webhook
  .command("show")
  .action((_options: Options, command: Command) => webhookShowCommand(withGlobals(command)));

webhook
  .command("set <url>")
  .description("Set the https URL; also turns on automatic dead-proxy replacement (needs --yes)")
  .option("--yes", "confirm")
  .action((url: string, _options: Options, command: Command) => webhookSetCommand(url, withGlobals(command)));

webhook
  .command("delete")
  .description("Remove the webhook (needs --yes)")
  .option("--yes", "confirm")
  .action((_options: Options, command: Command) => webhookDeleteCommand(withGlobals(command)));

webhook
  .command("rotate-secret")
  .description("Issue a new signing secret, shown once (needs --yes)")
  .option("--yes", "confirm")
  .action((_options: Options, command: Command) => webhookRotateSecretCommand(withGlobals(command)));

webhook
  .command("test")
  .description("Send a signed test event")
  .action((_options: Options, command: Command) => webhookTestCommand(withGlobals(command)));

function formatError(error: unknown): FormattedError {
  if (error instanceof CoroniumError) return formatCoroniumError(error);
  if (error instanceof UsageError) return formatUsageError(error);
  return formatUnknownError(error);
}

const COMMANDER_SUCCESS_CODES: ReadonlySet<string> = new Set(["commander.helpDisplayed", "commander.version", "commander.help"]);

function handleFailure(error: unknown): void {
  if (error instanceof ExitWith) {
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof CommanderError) {
    // Commander has already printed its message.
    process.exitCode = COMMANDER_SUCCESS_CODES.has(error.code) ? EXIT_OK : EXIT_USAGE;
    return;
  }
  const formatted: FormattedError = formatError(error);
  if (process.argv.includes("--json")) {
    printJsonError(formatted);
  } else {
    printPretty(formatted);
  }
  process.exitCode = formatted.exitCode;
}

program
  .parseAsync(process.argv)
  .then((): void => {
    if (process.exitCode === undefined) process.exitCode = EXIT_OK;
  })
  .catch(handleFailure);
