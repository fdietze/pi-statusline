import assert from "node:assert/strict";
import test from "node:test";
import { createDraft, resetSelected, resetProvider, resetSection, resetAll, assertNoAliasing } from "../src/settings/state.ts";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig } from "../src/settings/defaults.ts";
import { CURRENT_VERSION } from "../src/settings/schema.ts";

test("state: createDraft creates structuredClone deep copy", () => {
  const original = DEFAULT_STATUSLINE_SETTINGS;
  const draft = createDraft(original);

  // Different objects
  assert.notStrictEqual(draft, original);
  assert.notStrictEqual(draft.providers, original.providers);
  assert.notStrictEqual(draft.layout, original.layout);
  assert.notStrictEqual(draft.separators, original.separators);
  assert.notStrictEqual(draft.segments, original.segments);
  assert.notStrictEqual(draft.bars, original.bars);
  assert.notStrictEqual(draft.thresholds, original.thresholds);
  assert.notStrictEqual(draft.icons, original.icons);
  assert.notStrictEqual(draft.preview, original.preview);

  // Same values
  assert.deepEqual(draft, original);
});

test("state: mutating draft does not change source or DEFAULT_STATUSLINE_SETTINGS", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);

  // Mutate draft
  draft.enabled = false;
  draft.providers.enabled = false;
  draft.providers.order.push("new-provider");
  draft.layout.providerRows = "inline";
  draft.separators.main = "|";
  draft.segments.project = false;
  draft.bars.width = 20;
  draft.thresholds.contextWarn = 70;
  draft.icons.style = "ascii";
  draft.preview.mode = "narrow";

  // Original unchanged
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.enabled, true);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.providers.enabled, true);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.providers.order.length, 0);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.layout.providerRows, "newline");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.separators.main, " >");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.segments.project, true);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.bars.width, 12);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.thresholds.contextWarn, 80);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.icons.style, "emoji");
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.preview.mode, "current");
});

test("state: no aliasing between draft and source", () => {
  const original = DEFAULT_STATUSLINE_SETTINGS;
  const draft = createDraft(original);

  assertNoAliasing(original, draft);
});

test("state: no aliasing with DEFAULT_STATUSLINE_SETTINGS", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  assertNoAliasing(DEFAULT_STATUSLINE_SETTINGS, draft);
});

test("state: resetSelected changes draft only", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  const originalEnabled = draft.enabled;

  resetSelected(draft, "enabled");
  assert.equal(draft.enabled, true); // Default is true
  assert.equal(draft.enabled, originalEnabled); // No change since default matches
});

test("state: resetSelected nested path", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  draft.separators.main = "|";

  resetSelected(draft, "separators.main");
  assert.equal(draft.separators.main, " >"); // Default
});

test("state: resetProvider changes draft only", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  const providerId = "test-provider";

  // Add a provider
  draft.providers.records[providerId] = createProviderConfig();
  draft.providers.records[providerId].enabled = false;
  draft.providers.records[providerId].displayMode = "custom";

  resetProvider(draft, providerId);

  // Reset to defaults
  assert.equal(draft.providers.records[providerId].enabled, true);
  assert.equal(draft.providers.records[providerId].displayMode, "default");
  assert.deepEqual(draft.providers.records[providerId].windows, {});
});

test("state: resetProvider non-existent is no-op", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  resetProvider(draft, "non-existent");
  // Should not throw
});

test("state: resetSection changes draft only", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  draft.separators.main = "|";
  draft.separators.preset = "Custom";

  resetSection(draft, "separators");

  assert.equal(draft.separators.main, " >");
  assert.equal(draft.separators.preset, "Default");
});

test("state: resetSection preserves version and __unknown", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  draft.version = 5 as typeof draft.version;
  draft.__unknown = { custom: "field" };

  resetSection(draft, "separators");

  assert.equal(draft.version, 5);
  assert.deepEqual(draft.__unknown, { custom: "field" });
});

test("state: resetAll changes draft only", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  draft.enabled = false;
  draft.providers.enabled = false;
  draft.layout.providerRows = "inline";
  draft.separators.main = "|";
  draft.segments.project = false;
  draft.bars.width = 20;
  draft.thresholds.contextWarn = 70;
  draft.icons.style = "ascii";
  draft.preview.mode = "narrow";

  resetAll(draft);

  assert.equal(draft.enabled, true);
  assert.equal(draft.providers.enabled, true);
  assert.equal(draft.layout.providerRows, "newline");
  assert.equal(draft.separators.main, " >");
  assert.equal(draft.segments.project, true);
  assert.equal(draft.bars.width, 12);
  assert.equal(draft.thresholds.contextWarn, 80);
  assert.equal(draft.icons.style, "emoji");
  assert.equal(draft.preview.mode, "current");
});

test("state: resetAll preserves version and __unknown", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  draft.version = 3 as typeof draft.version;
  draft.__unknown = { preserved: true };

  resetAll(draft);

  assert.equal(draft.version, 3);
  assert.deepEqual(draft.__unknown, { preserved: true });
});

test("state: reset ops on draft don't affect DEFAULT_STATUSLINE_SETTINGS", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);

  resetSelected(draft, "enabled");
  resetProvider(draft, "test");
  resetSection(draft, "providers");
  resetAll(draft);

  // Defaults unchanged
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.enabled, true);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.providers.enabled, true);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.layout.providerRows, "newline");
});

test("state: resetSelected default value does not alias the singleton", () => {
  const draft = createDraft(DEFAULT_STATUSLINE_SETTINGS);
  resetSelected(draft, "bars");
  draft.bars.width = 999;
  assert.equal(draft.bars.width, 999);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.bars.width, 12, "resetSelected must clone default object values");
});