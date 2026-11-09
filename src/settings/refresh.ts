import type { MissingDataPolicy, StatuslineSettings } from "./schema.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";

/** Floor for the configurable cache age. The poll cadence is fixed in src/providers.ts. */
export const MIN_CACHE_AGE_MS = 10_000;

/** Per-provider refresh/cache policy resolved from settings (R18). */
export interface RefreshPolicy {
  maxAgeMs: number;
  useCache: boolean;
  keepAfterFailure: boolean;
  refreshWhileActive: boolean;
  refreshDisabledProvider: boolean;
}

export interface EligibilityInputs {
  /** Whether this provider's own row/tracking is enabled. */
  providerEnabled: boolean;
  /** Whether this provider is the currently active model. */
  isActive: boolean;
}

export type RefreshHealthState = "fresh" | "stale" | "unknown";

export interface RefreshHealth {
  state: RefreshHealthState;
  /** Sanitized reason for stale/unknown (never a secret or raw error). */
  reason?: string;
}

/** Merge provider defaults with sparse per-provider overrides, then bound the result. */
export function resolveProviderRefreshPolicy(
  settings: StatuslineSettings,
  providerId: string,
  _capability?: ProviderCapability,
): RefreshPolicy {
  const defaults = settings.providers.defaults;
  const override = settings.providers.records[providerId]?.refresh;
  const requestedMaxAge = override?.maxCacheAgeMs ?? defaults.maxCacheAgeMs;
  const maxAgeMs = Number.isFinite(requestedMaxAge)
    ? Math.min(604_800_000, Math.max(MIN_CACHE_AGE_MS, Math.floor(requestedMaxAge)))
    : MIN_CACHE_AGE_MS;
  return {
    maxAgeMs,
    useCache: override?.useCache ?? defaults.useCache,
    keepAfterFailure: override?.keepAfterFailure ?? defaults.keepAfterFailure,
    refreshWhileActive: override?.refreshWhileActive ?? defaults.refreshWhileActive,
    refreshDisabledProvider: override?.refreshDisabledProvider ?? defaults.refreshDisabledProvider,
  };
}

export function resolveProviderMissingDataPolicy(
  settings: StatuslineSettings,
  providerId: string,
): MissingDataPolicy {
  return settings.providers.records[providerId]?.missingDataPolicy ?? settings.providers.defaults.missingDataPolicy;
}

/**
 * Refresh eligibility (R18): requires global tracking, the provider's own row, adapter
 * support, and policy permission. Unsupported/unauthenticated providers are never eligible,
 * so they make no network call.
 */
export function resolveRefreshEligibility(
  settings: StatuslineSettings,
  _providerId: string,
  capability: ProviderCapability,
  inputs: EligibilityInputs,
): boolean {
  const policy = resolveProviderRefreshPolicy(settings, _providerId, capability);
  if (!settings.providers.enabled) return false;
  if (!inputs.providerEnabled && !policy.refreshDisabledProvider) return false;
  if (!capability.available || !capability.authenticated) return false;
  if (capability.quotaSupport === "none") return false;
  if (inputs.isActive && !policy.refreshWhileActive) return false;
  return true;
}

/**
 * Sanitized health from the last successful refresh timestamp (R18, KTD7). Fresh within
 * maxAge; stale after maxAge (last value retained when keepAfterFailure); unknown when never
 * refreshed. Reasons are UI-safe and contain no credential fragments.
 */
export function resolveRefreshHealth(
  previousFreshAt: number | undefined,
  now: number,
  policy: RefreshPolicy,
): RefreshHealth {
  if (previousFreshAt === undefined || !Number.isFinite(previousFreshAt)) {
    return { state: "unknown", reason: "no usage data yet" };
  }
  const age = now - previousFreshAt;
  if (age <= policy.maxAgeMs) return { state: "fresh" };
  return policy.keepAfterFailure
    ? { state: "stale", reason: "usage data is stale" }
    : { state: "unknown", reason: "usage data is stale" };
}
