import kleur from "kleur";
import type { Coronium, WebhookSecret, WebhookSettings, WebhookTestResult } from "coronium-sdk";
import { makeClient } from "../client.js";
import { EXIT_REJECTED, ExitWith, field, isJson, ok, printJson, UsageError, warn, type GlobalOptions } from "../output.js";

export interface WebhookConfirmOptions extends GlobalOptions {
  yes?: boolean;
}

function requireYes(options: WebhookConfirmOptions, what: string): void {
  if (options.yes) return;
  throw new UsageError(`${what} Re-run with --yes to confirm.`);
}

function secretLabel(settings: WebhookSettings): string {
  if (settings.secret?.preview) return settings.secret.preview;
  if (settings.secret?.exists) return "set";
  return "none";
}

function printSettings(settings: WebhookSettings): void {
  field("url", settings.webhook_url);
  field("enabled", settings.enabled);
  field("auto replace", settings.auto_replace_dead_proxies ?? "unknown");
  field("secret", secretLabel(settings));
}

export async function webhookShowCommand(options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const settings: WebhookSettings = await client.webhook.get();
  if (isJson(options)) {
    printJson(settings);
    return;
  }
  console.log(kleur.bold("Webhook"));
  printSettings(settings);
}

export async function webhookSetCommand(url: string, options: WebhookConfirmOptions): Promise<void> {
  requireYes(options, "Setting a webhook also turns on automatic replacement of dead proxies (new host and credentials).");
  const client: Coronium = await makeClient({ requireToken: true });
  const settings: WebhookSettings = await client.webhook.set(url);
  if (isJson(options)) {
    printJson(settings);
    return;
  }
  ok("Webhook saved.");
  printSettings(settings);
}

export async function webhookDeleteCommand(options: WebhookConfirmOptions): Promise<void> {
  requireYes(options, "Removing the webhook also turns off automatic replacement of dead proxies.");
  const client: Coronium = await makeClient({ requireToken: true });
  const settings: WebhookSettings = await client.webhook.delete();
  if (isJson(options)) {
    printJson(settings);
    return;
  }
  ok("Webhook removed.");
}

export async function webhookRotateSecretCommand(options: WebhookConfirmOptions): Promise<void> {
  requireYes(options, "The current signing secret stops working immediately.");
  const client: Coronium = await makeClient({ requireToken: true });
  const secret: WebhookSecret = await client.webhook.rotateSecret();
  if (isJson(options)) {
    printJson(secret);
    return;
  }
  ok("New signing secret (shown once, store it now):");
  console.log(`  ${secret.secret}`);
}

export async function webhookTestCommand(options: GlobalOptions): Promise<void> {
  const client: Coronium = await makeClient({ requireToken: true });
  const result: WebhookTestResult = await client.webhook.test();
  if (isJson(options)) {
    printJson(result);
  } else if (result.delivered) {
    ok(`Test event delivered (HTTP ${result.status_code}, ${result.latency_ms ?? "?"} ms).`);
  } else {
    warn(`Test event not delivered: ${result.error ?? `HTTP ${result.status_code}`}`);
  }
  if (!result.delivered) throw new ExitWith(EXIT_REJECTED);
}
