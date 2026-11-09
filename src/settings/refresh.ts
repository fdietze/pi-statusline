import type { StatuslineSettings } from "./schema.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";

export type RefreshHealthState = "fresh" | "stale" | "unknown";

export interface RefreshHealth {
  state: RefreshHealthState;
  /** Sanitized reason for stale/unknown (never a secret or raw error). */
  reason?: string;
}

/**
 * Whether "Refresh usage now" applies: requires global tracking, the provider's own row, and
 * adapter support. Unsupported/unauthenticated providers are never eligible, so they make no
 * network call.
 */
export function resolveRefreshEligibility(
  settings: StatuslineSettings,
  capability: ProviderCapability,
  providerEnabled: boolean,
): boolean {
  return settings.providers.enabled
    && providerEnabled
    && capability.available
    && capability.authenticated
    && capability.quotaSupport !== "none";
}
