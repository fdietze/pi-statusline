import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig, createProviderDefaults } from "../src/settings/defaults.ts";
import { CURRENT_VERSION } from "../src/settings/schema.ts";
import { SEGMENT_ORDER } from "../src/segments.ts";

test("defaults: DEFAULT_STATUSLINE_SETTINGS has expected shape and version", () => {
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.version, CURRENT_VERSION);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.enabled, true);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.providers);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.layout);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.separators);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.segments);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.bars);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.thresholds);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.timing);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.icons);
  assert.ok(DEFAULT_STATUSLINE_SETTINGS.preview);
});

test("defaults: extras reproduces legacy feature-parity defaults", () => {
  assert.deepEqual(DEFAULT_STATUSLINE_SETTINGS.extras, {
    branch: true,
    cost: false,
    sessionElapsed: false,
    lastTurn: false,
    pending: false,
  });
});

test("defaults: segmentOrder matches SEGMENT_ORDER", () => {
  assert.deepEqual(DEFAULT_STATUSLINE_SETTINGS.layout.segmentOrder, SEGMENT_ORDER);
});

test("defaults: narrowPriority drops low-priority segments first, retains context", () => {
  const narrowPriority = DEFAULT_STATUSLINE_SETTINGS.layout.narrowPriority;
  // Current behavior drops ordinary segments first, extension statuses last, and retains context.
  // context is retained (never dropped) so it is NOT in narrowPriority.
  assert.deepEqual([...narrowPriority], ["time", "throughput", "project", "effort", "model", "session", "extensions"]);
  assert.equal(narrowPriority.includes("context"), false, "context must be retained, never dropped");
});

test("defaults: bars rounded width 12 with fill/empty/caps", () => {
  const bars = DEFAULT_STATUSLINE_SETTINGS.bars;
  assert.equal(bars.width, 12);
  assert.equal(bars.fill, "█");
  assert.equal(bars.empty, "░");
  assert.equal(bars.capLeft, "╟");
  assert.equal(bars.capRight, "╢");
  assert.equal(bars.showPercent, true);
  assert.equal(bars.style, "rounded");
});

test("defaults: providerRows newline, thresholds 80/95", () => {
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.layout.providerRows, "newline");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.thresholds.contextWarn, 80);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.thresholds.contextCrit, 95);
});

test("defaults: timing refresh 10000 min, maxCacheAge 300000", () => {
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.timing.refreshIntervalMs, 10000);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.timing.maxCacheAgeMs, 300000);
});

test("defaults: emoji icons and spaced main separator", () => {
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.icons.style, "emoji");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.separators.main, " >");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.separators.spacingAfter, 1);
});

test("defaults: createProviderConfig returns fresh config", () => {
  const config1 = createProviderConfig();
  const config2 = createProviderConfig();
  assert.notStrictEqual(config1, config2);
  assert.equal(config1.enabled, true);
  assert.equal(config1.displayMode, "default");
  assert.deepEqual(config1.windows, {});
  assert.equal(config1.supportedOverrides.length, 8);
});

test("defaults: createWindowConfig returns fresh config", () => {
  const win1 = createWindowConfig();
  const win2 = createWindowConfig();
  assert.notStrictEqual(win1, win2);
  assert.equal(win1.visible, true);
  assert.equal(win1.width, 12);
  assert.equal(win1.resetFormat, "countdown");
});

test("defaults: createProviderDefaults returns fresh defaults", () => {
  const d1 = createProviderDefaults();
  const d2 = createProviderDefaults();
  assert.notStrictEqual(d1, d2);
  assert.equal(d1.refreshIntervalMs, 10000);
  assert.equal(d1.maxCacheAgeMs, 300000);
});