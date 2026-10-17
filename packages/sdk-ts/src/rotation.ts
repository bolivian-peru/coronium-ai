import { CoroniumError } from "./errors.js";
import type { RestartResponse, RotationResult } from "./types.js";

function isPendingRotation(response: RestartResponse): boolean {
  return response.pending === true || response.accepted === true;
}

/**
 * The restart route reports `rotated: true`. The public token route reports
 * success as `{ result: "ok", new_ip }` with no `rotated` field at all, so both
 * shapes count as a completed rotation.
 */
export function isCompletedRotation(response: RestartResponse): boolean {
  if (response.rotated === true) return true;
  const tokenRouteSuccess: boolean =
    response.rotated === undefined && response.result === "ok" && typeof response.new_ip === "string";
  return tokenRouteSuccess;
}

function firstIp(response: RestartResponse): string | null {
  if (typeof response.new_ip === "string") return response.new_ip;
  if (typeof response.ip === "string") return response.ip;
  if (typeof response.ext_ip === "string") return response.ext_ip;
  return null;
}

export function toRotationResult(response: RestartResponse): RotationResult {
  if (isPendingRotation(response)) {
    return {
      state: "rotating",
      statusUrl: response.status_url ?? null,
      retryAfterSeconds: response.retry_after_seconds ?? null,
      response,
    };
  }
  if (isCompletedRotation(response)) {
    return { state: "done", ip: firstIp(response), response };
  }
  if (response.rotated === false) {
    // The reset ran and connections dropped, but the carrier kept the IP.
    return { state: "unchanged", ip: firstIp(response), message: response.message ?? null, response };
  }
  throw new CoroniumError({
    code: "invalid_response",
    message: "The rotation response did not say whether the IP changed. Check rotation status before another action.",
    outcome: "unknown",
    suggestedAction: "check_rotation_status",
    details: response,
  });
}
