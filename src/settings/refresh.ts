import type { StatuslineSettings } from "./schema.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";

/** Whether the provider's latest usage is fresh (src/providers.ts hides stale usage). */
export interface RefreshHealth {
  state: "fresh" | "unknown";
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
