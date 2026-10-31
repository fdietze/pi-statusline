import type { ProviderDescriptor } from "./discovery.ts";
import { getAdapter, sanitizedUnavailableReason, type AdapterSupport } from "./adapters.ts";
import { isLocalEndpoint } from "../../derive.ts";

export type ProviderBilling = "local" | "subscription" | "api" | "unknown";
export type QuotaReliability = "high" | "medium" | "low" | "none";

/**
 * Capability-first provider descriptor (R13, KTD4). Every field is derived from
 * endpoint/auth/model data and the adapter registry — this module NEVER branches
 * on a provider id. Only adapters.ts knows provider ids.
 */
export interface ProviderCapability {
  available: boolean;
  authenticated: boolean;
  modelCount: number;
  billing: ProviderBilling;
  quotaSupport: AdapterSupport;
  quotaReliability: QuotaReliability;
  /** Sanitized, UI-safe reason when something is unavailable (never a secret/raw error). */
  unavailableReason?: string;
}

export interface CapabilityInputs {
  /** True when the provider authenticates via OAuth (subscription billing signal). */
  oauth?: boolean;
  /** Injectable locality test (defaults to the shared isLocalEndpoint). */
  isLocal?: (baseUrl?: string) => boolean;
}

const RELIABILITY: Record<AdapterSupport, QuotaReliability> = {
  official: "high",
  "best-effort": "medium",
  none: "none",
};

/**
 * Derive a provider's capability from its descriptor and auth/endpoint signals.
 * Billing is inferred structurally: local endpoint => local; OAuth => subscription;
 * available+authenticated hosted => api; otherwise unknown.
 */
export function deriveCapability(
  descriptor: ProviderDescriptor,
  inputs: CapabilityInputs = {},
): ProviderCapability {
  const isLocal = inputs.isLocal ?? isLocalEndpoint;
  const adapter = getAdapter(descriptor.id);
  const quotaReliability = RELIABILITY[adapter.support];

  // Billing from endpoint/auth/model data, NOT from the provider id.
  const hasLocalEndpoint = descriptor.models.some((model) => isLocal(model.baseUrl));
  const oauth = inputs.oauth === true;
  let billing: ProviderBilling;
  if (hasLocalEndpoint) billing = "local";
  else if (oauth) billing = "subscription";
  else if (descriptor.available && descriptor.authenticated) billing = "api";
  else billing = "unknown";

  let unavailableReason: string | undefined;
  if (!descriptor.available) unavailableReason = "provider not available";
  else if (!descriptor.authenticated) unavailableReason = "authentication required";
  else if (adapter.support === "none") unavailableReason = sanitizedUnavailableReason(descriptor.id);

  return {
    available: descriptor.available,
    authenticated: descriptor.authenticated,
    modelCount: descriptor.models.length,
    billing,
    quotaSupport: adapter.support,
    quotaReliability,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}
