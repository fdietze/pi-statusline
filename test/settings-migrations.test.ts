import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacySettings } from "../src/settings/migrations.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { CURRENT_VERSION } from "../src/settings/schema.ts";

test("migration: legacy footerEnabled+segments+extras+providerTracking maps to new groups", () => {
  const legacy = {
    footerEnabled: true,
    segments: {
      project: true,
      model: false,
      effort: true,
      context: true,
      session: false,
      throughput: true,
      time: true,
    },
    extras: {
      branch: true,
      nerdFont: true,
      cost: false,
      sessionElapsed: true,
      lastTurn: false,
      pending: true,
    },
    providerTracking: {
      enabled: true,
      selected: { anthropic: true, "openai-codex": false },
      order: ["anthropic", "openai-codex"],
      metrics: { usage: true, percent: false, reset: true },
      overrides: {
        anthropic: { usage: false, percent: true },
      },
    },
  };

  const migrated = migrateLegacySettings(legacy);

  // Global enabled = footerEnabled && providerTracking.enabled
  assert.equal(migrated.enabled, true);

  // Providers group
  assert.ok(migrated.providers);
  assert.equal(migrated.providers?.enabled, true);
  assert.deepEqual(migrated.providers?.order, ["anthropic", "openai-codex"]);
  assert.ok(migrated.providers?.records.anthropic);
  assert.ok(migrated.providers?.records["openai-codex"]);
  assert.equal(migrated.providers?.records.anthropic.enabled, true);
  assert.equal(migrated.providers?.records["openai-codex"].enabled, false);

  // Metrics overrides -> window config
  const anthropicWindow = migrated.providers?.records.anthropic.windows.default;
  assert.ok(anthropicWindow);
  assert.equal(anthropicWindow.showBar, false); // usage: false
  assert.equal(anthropicWindow.showPercent, true); // percent: true
  assert.equal(anthropicWindow.showReset, true); // reset: true (default)

  // A provider WITHOUT overrides inherits the shared metrics (parity: previously lost).
  const codexWindow = migrated.providers?.records["openai-codex"].windows.default;
  assert.ok(codexWindow, "non-overridden provider gets a seeded default window");
  assert.equal(codexWindow?.showBar, true); // shared metrics.usage: true
  assert.equal(codexWindow?.showPercent, false); // shared metrics.percent: false
  assert.equal(codexWindow?.showReset, true); // shared metrics.reset: true

  // Layout
  assert.ok(migrated.layout);
  assert.equal(migrated.layout?.providerRows, "newline");

  // Extras: legacy toggles preserved (nerdFont migrated to icons above)
  assert.deepEqual(migrated.extras, {
    branch: true,
    cost: false,
    sessionElapsed: true,
    lastTurn: false,
    pending: true,
  });
  assert.deepEqual(migrated.layout?.segmentOrder, ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"]);
  assert.deepEqual(migrated.layout?.rightAlignedExtensionStatuses, ["ponytail", "mcp"]);

  // Segments
  assert.ok(migrated.segments);
  assert.equal(migrated.segments?.project, true);
  assert.equal(migrated.segments?.model, false);
  assert.equal(migrated.segments?.effort, true);
  assert.equal(migrated.segments?.extensions, true);
  assert.equal(migrated.segments?.context, true);
  assert.equal(migrated.segments?.session, false);
  assert.equal(migrated.segments?.throughput, true);
  assert.equal(migrated.segments?.time, true);

  // Separators - nerdFont true -> Unicode preset
  assert.ok(migrated.separators);
  assert.equal(migrated.separators?.preset, "Unicode");

  // Icons - nerdFont true -> nerdfont style
  assert.ok(migrated.icons);
  assert.equal(migrated.icons?.style, "nerdfont");
});

test("migration: unknown legacy provider key preserved as disabled/stored record", () => {
  const legacy = {
    footerEnabled: true,
    segments: {},
    extras: {},
    providerTracking: {
      enabled: true,
      selected: {},
      order: ["known-provider", "unknown-legacy-provider"],
      metrics: { usage: true, percent: true, reset: true },
      overrides: {},
    },
  };

  const migrated = migrateLegacySettings(legacy);
  assert.ok(migrated.providers?.records["unknown-legacy-provider"]);
  assert.equal(migrated.providers?.records["unknown-legacy-provider"].enabled, false);
  assert.equal(migrated.providers?.records["known-provider"].enabled, false); // not in selected
});

test("migration: no secret fields copied", () => {
  const legacy = {
    footerEnabled: true,
    segments: {},
    extras: {},
    providerTracking: {
      enabled: true,
      selected: { anthropic: true },
      order: ["anthropic"],
      metrics: { usage: true, percent: true, reset: true },
      overrides: {},
      // These would be secrets in a real legacy config
      apiKeys: { anthropic: "sk-secret123" },
      oauthTokens: { anthropic: "oauth-secret" },
    },
  };

  const migrated = migrateLegacySettings(legacy);
  // Secrets should not appear in migrated settings
  assert.equal((migrated as unknown as Record<string, unknown>).apiKeys, undefined);
  assert.equal((migrated as unknown as Record<string, unknown>).oauthTokens, undefined);
  assert.equal((migrated.providers?.records.anthropic as unknown as Record<string, unknown>)?.apiKey, undefined);
});

test("migration: no fake provider adapter created", () => {
  const legacy = {
    footerEnabled: true,
    segments: {},
    extras: {},
    providerTracking: {
      enabled: true,
      selected: { "fake-adapter-provider": true },
      order: ["fake-adapter-provider"],
      metrics: { usage: true, percent: true, reset: true },
      overrides: {},
    },
  };

  const migrated = migrateLegacySettings(legacy);
  // Provider is preserved as a record but no adapter is created
  assert.ok(migrated.providers?.records["fake-adapter-provider"]);
  // The record is just data - no adapter logic
  assert.equal(typeof migrated.providers?.records["fake-adapter-provider"], "object");
});

test("migration: refresh interval < 10s normalized to 10000 (via defaults)", () => {
  // Legacy had no timing config, so defaults apply
  const legacy = {
    footerEnabled: true,
    segments: {},
    extras: {},
    providerTracking: { enabled: true, selected: {}, order: [], metrics: {}, overrides: {} },
  };

  const migrated = migrateLegacySettings(legacy);
  // Timing comes from defaults
  assert.equal(migrated.timing?.refreshIntervalMs, 10000);
  assert.equal(migrated.timing?.maxCacheAgeMs, 300000);
});

test("migration: explicit save durability - migration returns partial for caller to persist", () => {
  const legacy = {
    footerEnabled: false,
    segments: { project: true, model: true, effort: false, context: true, session: true, throughput: false, time: true },
    extras: { branch: false, nerdFont: false, cost: false, sessionElapsed: false, lastTurn: false, pending: false },
    providerTracking: { enabled: false, selected: {}, order: [], metrics: {}, overrides: {} },
  };

  const migrated = migrateLegacySettings(legacy);
  // Result is Partial<StatuslineSettings> - caller decides to save
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.providers?.enabled, false);
  // Version not set - caller merges with defaults
  assert.equal(migrated.version, undefined);
});

test("migration: output does not alias the singleton defaults", () => {
  const migrated = migrateLegacySettings({}) as Partial<typeof DEFAULT_STATUSLINE_SETTINGS>;
  // Mutating migrated nested objects must not leak into DEFAULT_STATUSLINE_SETTINGS.
  migrated.icons!.symbols["poison"] = "X";
  migrated.icons!.providers["evil"] = { mode: "custom", value: "Y" };
  migrated.separators!.main = "|";
  migrated.timing!.refreshIntervalMs = 1;
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.icons.symbols["poison"], undefined);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.icons.providers["evil"], undefined);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.separators.main, " >");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.timing.refreshIntervalMs, 10000);
});