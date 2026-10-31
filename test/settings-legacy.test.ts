import assert from "node:assert/strict";
import test from "node:test";
import { mergeSettings, DEFAULT_SETTINGS } from "../src/settings/legacy.ts";

test("mergeSettings: valid legacy input preserved", () => {
  const result = mergeSettings({
    footerEnabled: false,
    segments: { throughput: false, project: true, model: true, effort: true, context: true, session: false, time: true },
    extras: { branch: false, nerdFont: true, cost: true, sessionElapsed: false, lastTurn: false, pending: false },
    providerTracking: {
      enabled: false,
      selected: { anthropic: true },
      order: ["anthropic"],
      metrics: { usage: false, percent: true, reset: true },
      overrides: { anthropic: { usage: false } },
    },
  });
  assert.equal(result.footerEnabled, false);
  assert.equal(result.segments.session, false);
  assert.equal(result.extras.nerdFont, true);
  assert.equal(result.providerTracking.enabled, false);
  assert.deepEqual(result.providerTracking.selected, { anthropic: true });
  assert.deepEqual(result.providerTracking.order, ["anthropic"]);
  assert.equal(result.providerTracking.metrics.usage, false);
  assert.deepEqual(result.providerTracking.overrides, { anthropic: { usage: false } });
});

test("mergeSettings: partial/missing fields fall back to defaults", () => {
  const result = mergeSettings({ footerEnabled: false, extras: { cost: true } });
  assert.equal(result.footerEnabled, false);
  assert.equal(result.extras.cost, true);
  assert.equal(result.extras.branch, DEFAULT_SETTINGS.extras.branch);
  assert.deepEqual(result.segments, DEFAULT_SETTINGS.segments);
  assert.deepEqual(result.providerTracking, DEFAULT_SETTINGS.providerTracking);
});

test("mergeSettings: invalid types coerced to defaults", () => {
  const result = mergeSettings({
    footerEnabled: "yes",
    segments: { session: "off", project: null },
    extras: { branch: 1, nerdFont: false },
    providerTracking: {
      enabled: "true",
      selected: { anthropic: "yes", openai: true },
      order: [42, "openai", "   "],
      metrics: { usage: "yes", percent: false, reset: true },
      overrides: { anthropic: { usage: "yes" }, "   ": { usage: true } },
    },
  });
  // footerEnabled invalid → default true
  assert.equal(result.footerEnabled, true);
  // segment invalid → default
  assert.equal(result.segments.session, DEFAULT_SETTINGS.segments.session);
  assert.equal(result.segments.project, DEFAULT_SETTINGS.segments.project);
  // extras: invalid branch → default, valid nerdFont kept
  assert.equal(result.extras.branch, DEFAULT_SETTINGS.extras.branch);
  assert.equal(result.extras.nerdFont, false);
  // providerTracking: invalid enabled → default true
  assert.equal(result.providerTracking.enabled, true);
  // selected: only valid boolean kept
  assert.deepEqual(result.providerTracking.selected, { openai: true });
  // order: non-string and blank filtered
  assert.deepEqual(result.providerTracking.order, ["openai"]);
  // metrics: invalid usage → default true; valid percent/reset kept
  assert.equal(result.providerTracking.metrics.usage, true);
  assert.equal(result.providerTracking.metrics.percent, false);
  // overrides: invalid value and blank key dropped
  assert.deepEqual(result.providerTracking.overrides, {});
});

test("mergeSettings: undefined/null input returns all defaults", () => {
  assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings("not an object"), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(42), DEFAULT_SETTINGS);
});

test("mergeSettings: duplicate providers in order deduplicated", () => {
  const result = mergeSettings({
    providerTracking: { order: ["anthropic", "openai", "anthropic"] },
  });
  assert.deepEqual(result.providerTracking.order, ["anthropic", "openai"]);
});
