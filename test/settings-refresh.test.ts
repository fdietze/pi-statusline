import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_CACHE_AGE_MS,
  resolveProviderRefreshPolicy,
  resolveRefreshEligibility,
  resolveRefreshHealth,
} from "../src/settings/refresh.ts";
import { createProviderConfig, DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
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

test("policy: maxAge floored at MIN_CACHE_AGE_MS", () => {
  const s = settingsWith({
    providers: { ...DEFAULT_STATUSLINE_SETTINGS.providers, defaults: { ...DEFAULT_STATUSLINE_SETTINGS.providers.defaults, maxCacheAgeMs: 100 } },
  });
  const policy = resolveProviderRefreshPolicy(s, "anthropic", officialCap);
  assert.equal(policy.maxAgeMs, MIN_CACHE_AGE_MS);
});

test("policy: passes through defaults when in range", () => {
  const policy = resolveProviderRefreshPolicy(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap);
  assert.equal(policy.maxAgeMs, 300_000);
  assert.equal(policy.useCache, true);
  assert.equal(policy.keepAfterFailure, true);
});

test("eligibility: requires global providers enabled", () => {
  const s = settingsWith({ providers: { ...DEFAULT_STATUSLINE_SETTINGS.providers, enabled: false } });
  assert.equal(resolveRefreshEligibility(s, "anthropic", officialCap, { providerEnabled: true, isActive: false }), false);
});

test("eligibility: requires the provider's own row enabled (unless refreshDisabledProvider)", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap, { providerEnabled: false, isActive: false }), false);
  const allow = settingsWith({ providers: { ...DEFAULT_STATUSLINE_SETTINGS.providers, defaults: { ...DEFAULT_STATUSLINE_SETTINGS.providers.defaults, refreshDisabledProvider: true } } });
  assert.equal(resolveRefreshEligibility(allow, "anthropic", officialCap, { providerEnabled: false, isActive: false }), true);
});

test("eligibility: unsupported provider (no adapter) is never eligible -> no network call", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, "openrouter", unsupportedCap, { providerEnabled: true, isActive: false }), false);
});

test("eligibility: unauthenticated provider is never eligible", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, "anthropic", unauthCap, { providerEnabled: true, isActive: false }), false);
});

test("eligibility: supported authenticated enabled provider is eligible", () => {
  assert.equal(resolveRefreshEligibility(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap, { providerEnabled: true, isActive: false }), true);
});

test("health: unknown when never refreshed", () => {
  const policy = resolveProviderRefreshPolicy(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap);
  const health = resolveRefreshHealth(undefined, Date.now(), policy);
  assert.equal(health.state, "unknown");
  assert.ok(health.reason);
});

test("health: fresh within maxAge", () => {
  const policy = resolveProviderRefreshPolicy(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap);
  const now = Date.now();
  assert.equal(resolveRefreshHealth(now - 60_000, now, policy).state, "fresh");
});

test("health: stale after maxAge retains last value when keepAfterFailure", () => {
  const policy = resolveProviderRefreshPolicy(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap);
  const now = Date.now();
  const health = resolveRefreshHealth(now - policy.maxAgeMs - 1_000, now, policy);
  assert.equal(health.state, "stale");
});

test("health: sanitized reasons never leak credential fragments", () => {
  const policy = resolveProviderRefreshPolicy(DEFAULT_STATUSLINE_SETTINGS, "anthropic", officialCap);
  const now = Date.now();
  const reasons = [
    resolveRefreshHealth(undefined, now, policy).reason,
    resolveRefreshHealth(now - policy.maxAgeMs - 1_000, now, policy).reason,
  ];
  for (const reason of reasons) {
    assert.ok(reason);
    assert.ok(!/sk-|Bearer|authorization|token|key/i.test(reason!), "reason must not leak a credential fragment");
  }
});

test("policy: sparse provider overrides resolve over globals and stay bounded", () => {
  const s = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  s.providers.records.dynamic = {
    ...createProviderConfig(),
    missingDataPolicy: "warning",
    refresh: { maxCacheAgeMs: 20_000, useCache: false, refreshDisabledProvider: true },
  };
  const policy = resolveProviderRefreshPolicy(s, "dynamic", officialCap);
  assert.deepEqual(policy, {
    maxAgeMs: 20_000, useCache: false, keepAfterFailure: true,
    refreshWhileActive: true, refreshDisabledProvider: true,
  });
});

test("eligibility uses sparse provider refresh overrides", () => {
  const s = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  s.providers.records.dynamic = {
    ...createProviderConfig(), enabled: false,
    refresh: { refreshDisabledProvider: true, refreshWhileActive: false },
  };
  assert.equal(resolveRefreshEligibility(s, "dynamic", officialCap, { providerEnabled: false, isActive: false }), true);
  assert.equal(resolveRefreshEligibility(s, "dynamic", officialCap, { providerEnabled: true, isActive: true }), false);
});
