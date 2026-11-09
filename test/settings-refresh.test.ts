import assert from "node:assert/strict";
import test from "node:test";
import { resolveRefreshEligibility } from "../src/settings/refresh.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";
import type { ProviderCapability } from "../src/settings/providers/capabilities.ts";

function settingsWith(overrides: Partial<StatuslineSettings>): StatuslineSettings {
  return { ...DEFAULT_STATUSLINE_SETTINGS, ...overrides } as StatuslineSettings;
}

const officialCap: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "subscription",
  quotaSupport: "official", quotaReliability: "high",
};
const unsupportedCap: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "api",
  quotaSupport: "none", quotaReliability: "none",
  unavailableReason: "usage unavailable",
};
const unauthCap: ProviderCapability = {
  available: false, authenticated: false, modelCount: 0, billing: "unknown",
  quotaSupport: "official", quotaReliability: "high",
  unavailableReason: "authentication required",
};

test("eligibility: requires global providers enabled", () => {
  const s = settingsWith({ providers: { ...DEFAULT_STATUSLINE_SETTINGS.providers, enabled: false } });
  assert.equal(resolveRefreshEligibility(s, officialCap, true), false);
});

test("eligibility: requires the provider's own row enabled", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, officialCap, false), false);
});

test("eligibility: unsupported provider (no adapter) is never eligible -> no network call", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, unsupportedCap, true), false);
});

test("eligibility: unauthenticated provider is never eligible", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, unauthCap, true), false);
});

test("eligibility: supported authenticated enabled provider is eligible", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, officialCap, true), true);
});
