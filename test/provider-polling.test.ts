import assert from "node:assert/strict";
import test from "node:test";
import { providersToPoll } from "../src/provider-polling.ts";
import { createProviderConfig, DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";

const settingsWith = (edit: (s: StatuslineSettings) => void) => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.providers.order = ["anthropic", "zai"];
  settings.providers.records.anthropic = { ...createProviderConfig(), enabled: true };
  settings.providers.records.zai = { ...createProviderConfig(), enabled: false };
  edit(settings);
  return settings;
};

test("polls enabled rows plus the active provider while its session quota is visible", () => {
  assert.deepEqual(providersToPoll(settingsWith(() => {}), "openai-codex"), ["anthropic", "openai-codex"]);
  assert.deepEqual(providersToPoll(settingsWith(() => {}), "anthropic"), ["anthropic"], "deduplicated");
  assert.deepEqual(providersToPoll(settingsWith(() => {}), undefined), ["anthropic"]);
});

test("polls nothing when neither rows nor the session quota can show", () => {
  const off = (s: StatuslineSettings) => { s.providers.enabled = false; s.segments.session = false; };
  assert.deepEqual(providersToPoll(settingsWith(off), "anthropic"), []);
  assert.deepEqual(providersToPoll(settingsWith((s) => { s.enabled = false; }), "anthropic"), [], "footer off");
});

test("the active provider's session override wins over the global toggle", () => {
  const forcedOn = settingsWith((s) => {
    s.providers.enabled = false;
    s.segments.session = false;
    s.providers.records.zai!.activeModel.session = "on";
  });
  assert.deepEqual(providersToPoll(forcedOn, "zai"), ["zai"]);
  const forcedOff = settingsWith((s) => {
    s.providers.enabled = false;
    s.providers.records.zai!.activeModel.session = "off";
  });
  assert.deepEqual(providersToPoll(forcedOff, "zai"), []);
});
