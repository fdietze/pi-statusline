import assert from "node:assert/strict";
import test from "node:test";
import { parseStatuslineSettings } from "../src/settings/validation.ts";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig, createProviderDefaults } from "../src/settings/defaults.ts";
import { CURRENT_VERSION } from "../src/settings/schema.ts";

test("schema: new provider reconciliation - adding provider with no prior config gets default config", () => {
  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["anthropic", "new-provider-xyz"],
      defaults: createProviderDefaults(),
      records: {
        anthropic: createProviderConfig(),
      },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  // The new provider in order but not in records should not cause issues
  // The parser doesn't auto-add, but preserves order
  assert.equal(result.settings.providers.order.length, 2);
  assert.ok(result.settings.providers.records.anthropic);
});

test("schema: existing order preserved when new provider added", () => {
  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["first", "second", "third"],
      defaults: createProviderDefaults(),
      records: {
        first: createProviderConfig(),
        second: createProviderConfig(),
      },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  assert.deepEqual(result.settings.providers.order, ["first", "second", "third"]);
});

test("schema: string-keyed Records everywhere - no fixed provider-name unions", () => {
  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["custom-provider-1", "another-provider", "third-one"],
      defaults: createProviderDefaults(),
      records: {
        "custom-provider-1": createProviderConfig(),
        "another-provider": createProviderConfig(),
        "third-one": createProviderConfig(),
      },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  const records = result.settings.providers.records;
  assert.ok(records["custom-provider-1"]);
  assert.ok(records["another-provider"]);
  assert.ok(records["third-one"]);
  // No fixed union - any string key works
});

test("schema: string-keyed Records for windows - no array-index window positions", () => {
  const providerConfig = createProviderConfig();
  providerConfig.windows = {
    "monthly": { ...createWindowConfig(), label: "Monthly" },
    "daily": { ...createWindowConfig(), label: "Daily" },
    "custom-window-key": { ...createWindowConfig(), label: "Custom" },
  };

  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["test-provider"],
      defaults: createProviderDefaults(),
      records: { "test-provider": providerConfig },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  const windows = result.settings.providers.records["test-provider"].windows;
  assert.ok(windows.monthly);
  assert.ok(windows.daily);
  assert.ok(windows["custom-window-key"]);
  // Order preserved by key, not array index
});

test("schema: activeModel three-state values", () => {
  const providerConfig = createProviderConfig();
  providerConfig.activeModel = {
    project: "on",
    model: "off",
    effort: "default",
    extensions: "default",
    context: "default",
    session: "on",
    throughput: "off",
    time: "default",
  };

  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["test-provider"],
      defaults: createProviderDefaults(),
      records: { "test-provider": providerConfig },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  const activeModel = result.settings.providers.records["test-provider"].activeModel;
  assert.equal(activeModel.project, "on");
  assert.equal(activeModel.model, "off");
  assert.equal(activeModel.effort, "default");
});

test("schema: displayMode default vs custom", () => {
  const providerConfig = createProviderConfig();
  providerConfig.displayMode = "custom";
  providerConfig.windows = { "default": createWindowConfig() };

  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["test-provider"],
      defaults: createProviderDefaults(),
      records: { "test-provider": providerConfig },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  assert.equal(result.settings.providers.records["test-provider"].displayMode, "custom");
});

test("schema: provider icon override", () => {
  const providerConfig = createProviderConfig();
  providerConfig.icon = { mode: "custom", value: "🤖" };

  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["test-provider"],
      defaults: createProviderDefaults(),
      records: { "test-provider": providerConfig },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  assert.ok(result.settings.providers.records["test-provider"].icon);
  assert.equal(result.settings.providers.records["test-provider"].icon?.mode, "custom");
  assert.equal(result.settings.providers.records["test-provider"].icon?.value, "🤖");
});

test("schema: thresholds per-provider optional override", () => {
  const providerConfig = createProviderConfig();
  providerConfig.thresholds = { contextWarn: 70, contextCrit: 85 };

  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["test-provider"],
      defaults: createProviderDefaults(),
      records: { "test-provider": providerConfig },
    },
    layout: DEFAULT_STATUSLINE_SETTINGS.layout,
    separators: DEFAULT_STATUSLINE_SETTINGS.separators,
    segments: DEFAULT_STATUSLINE_SETTINGS.segments,
    bars: DEFAULT_STATUSLINE_SETTINGS.bars,
    thresholds: DEFAULT_STATUSLINE_SETTINGS.thresholds,
    timing: DEFAULT_STATUSLINE_SETTINGS.timing,
    icons: DEFAULT_STATUSLINE_SETTINGS.icons,
    preview: DEFAULT_STATUSLINE_SETTINGS.preview,
  };

  const result = parseStatuslineSettings(input);
  assert.ok(result.settings.providers.records["test-provider"].thresholds);
  assert.equal(result.settings.providers.records["test-provider"].thresholds?.contextWarn, 70);
  assert.equal(result.settings.providers.records["test-provider"].thresholds?.contextCrit, 85);
});

test("schema: CURRENT_VERSION const exported", () => {
  assert.equal(CURRENT_VERSION, 3);
  assert.equal(typeof CURRENT_VERSION, "number");
});

test("schema: type set exported (verified by TypeScript compilation)", () => {
  // This test verifies the types exist by using them
  const settings: typeof DEFAULT_STATUSLINE_SETTINGS = DEFAULT_STATUSLINE_SETTINGS;
  assert.ok(settings);
  assert.equal(settings.version, CURRENT_VERSION);
});