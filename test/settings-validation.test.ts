import assert from "node:assert/strict";
import test from "node:test";
import { parseStatuslineSettings } from "../src/settings/validation.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { CURRENT_VERSION } from "../src/settings/schema.ts";

test("validation: valid parse - full valid doc round-trips", () => {
  const input = {
    version: CURRENT_VERSION,
    enabled: true,
    providers: {
      enabled: true,
      order: ["anthropic", "openai-codex"],
      defaults: {
        displayMode: "default",
        missingDataPolicy: "cached",
        refreshIntervalMs: 10000,
        maxCacheAgeMs: 300000,
        useCache: true,
        keepAfterFailure: true,
        refreshWhileActive: true,
        refreshDisabledProvider: false,
      },
      records: {
        anthropic: {
          enabled: true,
          displayMode: "default",
          windows: {
            default: {
              visible: true,
              label: "Anthropic",
              showBar: true,
              showPercent: true,
              showReset: true,
              resetFormat: "countdown",
              showUsed: true,
              showRemaining: true,
              showZero: false,
              width: 12,
            },
          },
          activeModel: {
            project: "default",
            model: "default",
            effort: "default",
            extensions: "default",
            context: "default",
            session: "default",
            throughput: "default",
            time: "default",
          },
          supportedOverrides: ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"],
        },
      },
    },
    layout: {
      providerRows: "newline",
      placement: "below",
      maxWidth: 0,
      segmentOrder: ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"],
      narrowPriority: ["time", "throughput", "project", "effort", "model", "session", "extensions"],
      rightAlignedExtensionStatuses: ["mcp"],
    },
    separators: {
      main: " · ",
      projectGit: " ",
      window: " | ",
      provider: "\n",
      iconLabel: "",
      labelValue: " ",
      spacingBefore: 0,
      spacingAfter: 0,
      trailingSpacing: 0,
      padding: "",
      preset: "Default",
    },
    segments: {
      project: true,
      model: true,
      effort: true,
      extensions: true,
      context: true,
      session: true,
      throughput: true,
      time: true,
    },
    bars: {
      width: 12,
      fill: "█",
      empty: "░",
      capLeft: "╟",
      capRight: "╢",
      showPercent: true,
      style: "rounded",
      truecolor: true,
      warnAt: 80,
      critAt: 95,
    },
    thresholds: { contextWarn: 80, contextCrit: 95 },
    timing: { refreshIntervalMs: 10000, maxCacheAgeMs: 300000 },
    icons: {
      style: "emoji",
      symbols: {},
      providers: {},
    },
    preview: { mode: "current" },
  };

  const result = parseStatuslineSettings(input);
  assert.equal(result.readOnly, undefined);
  assert.equal(result.settings.version, CURRENT_VERSION);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.providers.order.length, 2);
  assert.ok(result.settings.providers.records.anthropic);
});

test("validation: version 1 settings gain extension-status ordering and provider controls", () => {
  const input = structuredClone(DEFAULT_STATUSLINE_SETTINGS) as unknown as Record<string, any>;
  input.version = 1;
  input.layout.segmentOrder = ["project", "model", "effort", "context", "session", "throughput", "time"];
  input.layout.narrowPriority = ["time", "throughput", "project", "effort", "model", "session"];
  delete input.segments.extensions;
  input.separators.spacingAfter = 0;
  input.providers.records.example = {
    enabled: true,
    displayMode: "custom",
    windows: {},
    activeModel: { project: "on", context: "off" },
    supportedOverrides: ["project", "model", "effort", "context", "session", "throughput", "time"],
  };

  const result = parseStatuslineSettings(input);
  assert.equal(result.settings.version, CURRENT_VERSION);
  assert.deepEqual(result.settings.layout.segmentOrder, ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"]);
  assert.deepEqual(result.settings.layout.narrowPriority, ["time", "throughput", "project", "effort", "model", "session", "extensions"]);
  assert.equal(result.settings.segments.extensions, true);
  assert.equal(result.settings.separators.spacingAfter, 1, "the old default separator adopts corrected spacing");
  assert.equal(result.settings.providers.records.example.activeModel.extensions, "default");
  assert.deepEqual(result.settings.providers.records.example.supportedOverrides, ["project", "model", "effort", "context", "session", "throughput", "time", "extensions"]);
});

test("validation: version 1 migration preserves customized ordering and zero spacing", () => {
  const input = structuredClone(DEFAULT_STATUSLINE_SETTINGS) as unknown as Record<string, any>;
  input.version = 1;
  input.layout.segmentOrder = ["time", "context", "model"];
  input.layout.narrowPriority = ["model", "time"];
  delete input.segments.extensions;
  input.separators = { ...input.separators, preset: "Custom", main: "|", spacingAfter: 0 };

  const result = parseStatuslineSettings(input);
  assert.deepEqual(result.settings.layout.segmentOrder, ["time", "extensions", "context", "model"]);
  assert.deepEqual(result.settings.layout.narrowPriority, ["model", "time", "extensions"]);
  assert.equal(result.settings.separators.spacingAfter, 0);
});

test("validation: version 2 settings adopt keyed MCP right alignment", () => {
  const input = structuredClone(DEFAULT_STATUSLINE_SETTINGS) as unknown as Record<string, any>;
  input.version = 2;
  delete input.layout.rightAlignedExtensionStatuses;

  const result = parseStatuslineSettings(input);
  assert.equal(result.settings.version, CURRENT_VERSION);
  assert.deepEqual(result.settings.layout.rightAlignedExtensionStatuses, ["mcp"]);
});

test("validation: right-aligned extension keys are sanitized, deduplicated, and may be disabled", () => {
  const configured = parseStatuslineSettings({
    version: CURRENT_VERSION,
    layout: { rightAlignedExtensionStatuses: [" mcp ", "mcp", "review\n", "", 42] },
  });
  assert.deepEqual(configured.settings.layout.rightAlignedExtensionStatuses, ["mcp", "review"]);

  const disabled = parseStatuslineSettings({
    version: CURRENT_VERSION,
    layout: { rightAlignedExtensionStatuses: [] },
  });
  assert.deepEqual(disabled.settings.layout.rightAlignedExtensionStatuses, []);
});

test("validation: invalid - null/undefined falls back to defaults", () => {
  const result = parseStatuslineSettings(null);
  assert.deepEqual(result.settings, DEFAULT_STATUSLINE_SETTINGS);
  assert.equal(result.readOnly, undefined);
});

test("validation: invalid - wrong types fall back to defaults", () => {
  const result = parseStatuslineSettings({ enabled: "yes", providers: "nope", layout: 123 });
  assert.equal(result.settings.enabled, true);
  assert.ok(result.settings.providers.enabled);
  assert.ok(Array.isArray(result.settings.providers.order));
});

test("validation: invalid - out-of-range thresholds normalized", () => {
  const result = parseStatuslineSettings({
    thresholds: { contextWarn: 150, contextCrit: -10 },
  });
  assert.equal(result.settings.thresholds.contextWarn, 80);
  assert.equal(result.settings.thresholds.contextCrit, 95);
});

test("validation: invalid - bad enum values fall back", () => {
  const result = parseStatuslineSettings({
    layout: { providerRows: "invalid", placement: "middle" },
    bars: { style: "fancy" },
    icons: { style: "sparkle" },
    separators: { preset: "Fancy" },
    preview: { mode: "fancy" },
  });
  assert.equal(result.settings.layout.providerRows, "newline");
  assert.equal(result.settings.layout.placement, "below");
  assert.equal(result.settings.bars.style, "rounded");
  assert.equal(result.settings.icons.style, "emoji");
  assert.equal(result.settings.separators.preset, "Default");
  assert.equal(result.settings.preview.mode, "current");
});

test("validation: invalid - impossible order/width/interval normalized", () => {
  const result = parseStatuslineSettings({
    layout: { maxWidth: -5, segmentOrder: [123, null, ""], narrowPriority: ["context", "context"] },
    bars: { width: 0, warnAt: 200, critAt: -5 },
    timing: { refreshIntervalMs: 500, maxCacheAgeMs: 100 },
  });
  assert.equal(result.settings.layout.maxWidth, 0);
  assert.equal(result.settings.bars.width, 1); // clamped to min 1
  assert.equal(result.settings.bars.warnAt, 80);
  assert.equal(result.settings.bars.critAt, 95);
  assert.equal(result.settings.timing.refreshIntervalMs, 10000); // min 10000
  assert.equal(result.settings.timing.maxCacheAgeMs, 10000); // >= refreshIntervalMs

  const inverted = parseStatuslineSettings({ bars: { warnAt: 90, critAt: 20 } });
  assert.equal(inverted.settings.bars.warnAt, 80);
  assert.equal(inverted.settings.bars.critAt, 95);
});

test("validation: hostile input - control chars stripped from display strings", () => {
  const result = parseStatuslineSettings({
    separators: { main: "a\x00b\x1fc\x7f", projectGit: "\x0b\x0c" },
    icons: { symbols: { test: "x\x01y" } },
  });
  assert.equal(result.settings.separators.main, "abc");
  assert.equal(result.settings.separators.projectGit, "");
  assert.equal(result.settings.icons.symbols.test, "xy");
});

test("validation: hostile input - ANSI escapes stripped", () => {
  const result = parseStatuslineSettings({
    separators: { main: "\x1b[31mred\x1b[0m", provider: "\x1b]8;;http://example.com\x1blink\x1b\\" },
    icons: { symbols: { test: "\x1b[1mbold\x1b[0m" } },
  });
  assert.equal(result.settings.separators.main, "red");
  assert.equal(result.settings.separators.provider, "link");
  assert.equal(result.settings.icons.symbols.test, "bold");
});

test("validation: hostile input - bidi overrides stripped", () => {
  const result = parseStatuslineSettings({
    separators: { main: "a\u202Eb\u202Cc", iconLabel: "\u2066\u2069" },
  });
  assert.equal(result.settings.separators.main, "abc");
  assert.equal(result.settings.separators.iconLabel, "");
});

test("validation: hostile input - bare newlines in display strings stripped", () => {
  const result = parseStatuslineSettings({
    separators: { main: "line1\nline2", provider: "a\nb\nc" },
    icons: { symbols: { test: "x\ny" } },
  });
  assert.equal(result.settings.separators.main, "line1line2");
  assert.equal(result.settings.separators.provider, "abc");
  assert.equal(result.settings.icons.symbols.test, "xy");
});

test("validation: unknown preservation - unknown top-level fields in __unknown", () => {
  const result = parseStatuslineSettings({
    version: CURRENT_VERSION,
    enabled: true,
    futureField: "preserved",
    anotherUnknown: { nested: true },
  });
  assert.ok(result.settings.__unknown);
  assert.equal(result.settings.__unknown?.futureField, "preserved");
  assert.deepEqual(result.settings.__unknown?.anotherUnknown, { nested: true });
});

test("validation: unknown preservation - unknown provider fields preserved", () => {
  const result = parseStatuslineSettings({
    version: CURRENT_VERSION,
    providers: {
      records: {
        anthropic: {
          enabled: true,
          displayMode: "default",
          windows: {},
          activeModel: {},
          supportedOverrides: [],
          customProviderField: "kept",
          anotherUnknown: 123,
        },
      },
    },
  });
  const provider = result.settings.providers.records.anthropic;
  const providerUnknown = (provider as unknown as Record<string, unknown>).__unknown as Record<string, unknown> | undefined;
  assert.ok(providerUnknown);
  assert.equal(providerUnknown?.customProviderField, "kept");
  assert.equal(providerUnknown?.anotherUnknown, 123);
});

test("validation: unknown preservation - unknown window fields preserved", () => {
  const result = parseStatuslineSettings({
    version: CURRENT_VERSION,
    providers: {
      records: {
        anthropic: {
          enabled: true,
          displayMode: "default",
          windows: {
            default: {
              visible: true,
              label: "",
              showBar: true,
              showPercent: true,
              showReset: true,
              resetFormat: "countdown",
              showUsed: true,
              showRemaining: true,
              showZero: false,
              width: 12,
              customWindowField: "preserved",
            },
          },
          activeModel: {},
          supportedOverrides: [],
        },
      },
    },
  });
  const window = result.settings.providers.records.anthropic.windows.default;
  const winUnknown = (window as unknown as { __unknown?: Record<string, unknown> }).__unknown;
  assert.ok(winUnknown);
  assert.equal(winUnknown?.customWindowField, "preserved");
});

test("validation: unknown/missing provider - stays as stored record", () => {
  const result = parseStatuslineSettings({
    version: CURRENT_VERSION,
    providers: {
      records: {
        "unknown-provider-xyz": {
          enabled: true,
          displayMode: "default",
          windows: {},
          activeModel: {},
          supportedOverrides: [],
        },
      },
    },
  });
  assert.ok(result.settings.providers.records["unknown-provider-xyz"]);
  assert.equal(result.settings.providers.records["unknown-provider-xyz"].enabled, true);
});

test("validation: future version - returns readOnly true and unchanged", () => {
  const futureVersion = CURRENT_VERSION + 5;
  const input = {
    version: futureVersion,
    enabled: false,
    providers: { enabled: false, order: [], defaults: {}, records: {} },
    layout: { providerRows: "inline", placement: "above", maxWidth: 100, segmentOrder: [], narrowPriority: [] },
    separators: { main: "|", projectGit: "", window: "", provider: "", iconLabel: "", labelValue: "", spacingBefore: 0, spacingAfter: 0, trailingSpacing: 0, padding: "", preset: "Custom" },
    segments: { project: false, model: false, effort: false, context: false, session: false, throughput: false, time: false },
    bars: { width: 20, fill: "#", empty: "-", capLeft: "[", capRight: "]", showPercent: false, style: "block", truecolor: false, warnAt: 50, critAt: 75 },
    thresholds: { contextWarn: 50, contextCrit: 75 },
    timing: { refreshIntervalMs: 5000, maxCacheAgeMs: 10000 },
    icons: { style: "ascii", symbols: {}, providers: {} },
    preview: { mode: "narrow" },
    customFutureField: "should be preserved",
  };

  const result = parseStatuslineSettings(input);
  assert.equal(result.readOnly, true);
  assert.equal(result.settings.version, futureVersion);
  assert.equal(result.settings.enabled, false); // Not normalized to default
  assert.ok(result.settings.__unknown?.customFutureField);
});

test("validation: sparse doc falls back to full defaults (not empty order/segments)", () => {
  const result = parseStatuslineSettings({ version: CURRENT_VERSION });
  assert.deepEqual([...result.settings.layout.segmentOrder], ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"]);
  assert.deepEqual(Object.keys(result.settings.segments).sort(), ["context", "effort", "extensions", "model", "project", "session", "throughput", "time"]);
  assert.deepEqual(result.settings.separators, DEFAULT_STATUSLINE_SETTINGS.separators);
  assert.deepEqual(result.settings.bars, DEFAULT_STATUSLINE_SETTINGS.bars);
  assert.deepEqual(result.settings.thresholds, DEFAULT_STATUSLINE_SETTINGS.thresholds);
  assert.deepEqual(result.settings.timing, DEFAULT_STATUSLINE_SETTINGS.timing);
});

test("validation: null input returns a clone, not the singleton", () => {
  const result = parseStatuslineSettings(null);
  assert.notEqual(result.settings, DEFAULT_STATUSLINE_SETTINGS);
  result.settings.bars.width = 999;
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.bars.width, 12, "mutating parsed null must not touch the singleton");
});

test("validation: hostile provider key yields a single sanitized record", () => {
  const result = parseStatuslineSettings({ providers: { records: { "ev\x1b[31mil": { customField: 1 } } } });
  const keys = Object.keys(result.settings.providers.records);
  assert.deepEqual(keys, ["evil"]);
  assert.ok((result.settings.providers.records.evil as unknown as { __unknown?: Record<string, unknown> }).__unknown?.customField);
});

test("validation: extras parses booleans and falls back to parity defaults", () => {
  const valid = parseStatuslineSettings({ extras: { branch: false, cost: true, sessionElapsed: true, lastTurn: true, pending: true } });
  assert.deepEqual(valid.settings.extras, { branch: false, cost: true, sessionElapsed: true, lastTurn: true, pending: true });

  // Bad types fall back to the parity defaults (branch true, rest false).
  const bad = parseStatuslineSettings({ extras: { branch: "yes", cost: 1, sessionElapsed: null, lastTurn: undefined, pending: "true" } });
  assert.deepEqual(bad.settings.extras, { branch: true, cost: false, sessionElapsed: false, lastTurn: false, pending: false });

  // Missing extras group yields the same parity defaults.
  assert.deepEqual(parseStatuslineSettings({}).settings.extras, DEFAULT_STATUSLINE_SETTINGS.extras);
});
test("validation: sparse provider missing-data and refresh overrides are bounded and preserved", () => {
  const record = parseStatuslineSettings({ providers: { records: { dynamic: {
    missingDataPolicy: "warning",
    refresh: {
      refreshIntervalMs: 5_000,
      maxCacheAgeMs: Number.POSITIVE_INFINITY,
      useCache: false,
      futureRefreshField: "kept",
    },
  } } } }).settings.providers.records.dynamic;
  assert.equal(record.missingDataPolicy, "warning");
  assert.equal(record.refresh?.refreshIntervalMs, 10_000);
  assert.equal(record.refresh?.maxCacheAgeMs, undefined);
  assert.equal(record.refresh?.useCache, false);
  assert.deepEqual(record.refresh?.__unknown, { futureRefreshField: "kept" });
});

test("validation: provider refresh unknown bag is idempotent across reparses", () => {
  const once = parseStatuslineSettings({ providers: { records: { dynamic: {
    refresh: {
      refreshIntervalMs: 20_000,
      __unknown: { alreadyPreserved: "yes" },
      newlyUnknown: 42,
    },
  } } } }).settings;
  assert.deepEqual(once.providers.records.dynamic.refresh?.__unknown, {
    alreadyPreserved: "yes",
    newlyUnknown: 42,
  });

  const twice = parseStatuslineSettings(once).settings;
  assert.deepEqual(twice.providers.records.dynamic.refresh?.__unknown, {
    alreadyPreserved: "yes",
    newlyUnknown: 42,
  });
  assert.equal("__unknown" in (twice.providers.records.dynamic.refresh?.__unknown ?? {}), false);
});
