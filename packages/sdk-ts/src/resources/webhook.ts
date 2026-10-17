import { createHmac, timingSafeEqual } from "node:crypto";
import { CoroniumError } from "../errors.js";
import { ROUTES } from "../routes.js";
import { objectBody, type Transport } from "../transport.js";
import type { WebhookSecret, WebhookSettings, WebhookTestResult } from "../types.js";

const MAX_URL_LENGTH: number = 500;

function assertWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CoroniumError({ code: "invalid_argument", message: "Webhook URL is not a valid URL." });
  }
  if (parsed.protocol !== "https:") {
    throw new CoroniumError({ code: "invalid_argument", message: "Webhook URL must use https." });
  }
  if (url.length > MAX_URL_LENGTH) {
    throw new CoroniumError({ code: "invalid_argument", message: `Webhook URL must be at most ${MAX_URL_LENGTH} characters.` });
  }
}

function assertSecret(body: unknown): WebhookSecret {
  const secret: WebhookSecret = objectBody<WebhookSecret>(body, "Webhook secret", "unknown");
  if (typeof secret.secret !== "string" || secret.secret === "") {
    throw new CoroniumError({
      code: "invalid_response",
      message: "The API did not return the new secret. Rotate again only after checking webhook settings.",
      outcome: "unknown",
    });
  }
  return secret;
}

export class WebhookResource {
  constructor(private readonly transport: Transport) {}

  async get(): Promise<WebhookSettings> {
    const result = await this.transport.call<unknown>(ROUTES.webhookGet);
    return objectBody<WebhookSettings>(result.body, "Webhook settings");
  }

  /**
   * Set the webhook URL (https). Enabling a webhook also turns on automatic
   * replacement of dead proxies, which gives those proxies a new host and new
   * credentials. Deliveries are signed with the account secret.
   */
  async set(url: string): Promise<WebhookSettings> {
    assertWebhookUrl(url);
    // Always send the key: the API treats a missing webhook_url as "disable".
    const result = await this.transport.call<unknown>(ROUTES.webhookSet, { body: { webhook_url: url } });
    return objectBody<WebhookSettings>(result.body, "Webhook settings", "unknown");
  }

  /** Disable the webhook, which also turns off automatic dead-proxy replacement. */
  async delete(): Promise<WebhookSettings> {
    const result = await this.transport.call<unknown>(ROUTES.webhookDelete);
    return objectBody<WebhookSettings>(result.body, "Webhook settings", "unknown");
  }

  /** Issue a new signing secret. It is returned once; the old one stops working. */
  async rotateSecret(): Promise<WebhookSecret> {
    const result = await this.transport.call<unknown>(ROUTES.webhookRotateSecret, { body: {} });
    return assertSecret(result.body);
  }

  /** Send a signed test event. `delivered: false` carries the reason in `error`. */
  async test(): Promise<WebhookTestResult> {
    const result = await this.transport.call<unknown>(ROUTES.webhookTest, { body: {}, allowErrorBody: true });
    return objectBody<WebhookTestResult>(result.body, "Webhook test");
  }
}

/**
 * Check an `X-Coronium-Signature` header (hex HMAC-SHA256 of the raw body,
 * optionally prefixed with `sha256=`) in constant time.
 */
export function verifyWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string, secret: string): boolean {
  const received: string = signatureHeader.trim().replace(/^sha256=/i, "");
  const expected: string = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}
