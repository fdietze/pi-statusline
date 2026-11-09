import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveStatuslineSettings, readStatuslineSettings, type SaveOperations } from "../src/settings/storage.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { CURRENT_VERSION } from "../src/settings/schema.ts";
import { parseStatuslineSettings } from "../src/settings/validation.ts";

test("storage: successful save writes temp+rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const settings = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: false };
    saveStatuslineSettings(settings, path);

    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.enabled, false);
    assert.equal(parsed.version, CURRENT_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: concurrent/different temp names", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const settings1 = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: true };
    const settings2 = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: false };

    saveStatuslineSettings(settings1, path);
    const content1 = readFileSync(path, "utf8");
    assert.equal(JSON.parse(content1).enabled, true);

    saveStatuslineSettings(settings2, path);
    const content2 = readFileSync(path, "utf8");
    assert.equal(JSON.parse(content2).enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: write-failure leaves original untouched and temp cleaned", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const original = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: true };
    saveStatuslineSettings(original, path);
    const originalContent = readFileSync(path, "utf8");

    const failOps: SaveOperations = {
      mkdir: () => {},
      writeFile: () => { throw new Error("write failed"); },
      rename: () => {},
      unlink: (file) => rmSync(file, { force: true }),
    };

    const next = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: false };
    assert.throws(() => saveStatuslineSettings(next, path, failOps), /write failed/);

    // Original file unchanged
    const afterContent = readFileSync(path, "utf8");
    assert.equal(afterContent, originalContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: rename-failure leaves original untouched and temp cleaned", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const original = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: true };
    saveStatuslineSettings(original, path);
    const originalContent = readFileSync(path, "utf8");

    const failOps: SaveOperations = {
      mkdir: () => {},
      writeFile: writeFileSync,
      rename: () => { throw new Error("rename failed"); },
      unlink: (file) => rmSync(file, { force: true }),
    };

    const next = { ...DEFAULT_STATUSLINE_SETTINGS, enabled: false };
    assert.throws(() => saveStatuslineSettings(next, path, failOps), /rename failed/);

    // Original file unchanged
    const afterContent = readFileSync(path, "utf8");
    assert.equal(afterContent, originalContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: read missing file -> defaults (not readOnly)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "nonexistent.json");
  try {
    const result = readStatuslineSettings(path);
    assert.deepEqual(result.settings, DEFAULT_STATUSLINE_SETTINGS);
    assert.equal(result.readOnly, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: read invalid JSON -> defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    writeFileSync(path, "{ invalid json }", "utf8");
    const result = readStatuslineSettings(path);
    assert.deepEqual(result.settings, DEFAULT_STATUSLINE_SETTINGS);
    assert.equal(result.readOnly, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: read valid but invalid types -> normalized defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    writeFileSync(path, JSON.stringify({ enabled: "yes", bars: { width: -5 } }), "utf8");
    const result = readStatuslineSettings(path);
    assert.equal(result.settings.enabled, true);
    assert.equal(result.settings.bars.width, 1);
    assert.equal(result.readOnly, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: read future version -> readOnly true, returned unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const futureVersion = CURRENT_VERSION + 2;
    const futureDoc = {
      version: futureVersion,
      enabled: false,
      providers: { enabled: false, order: [], defaults: {}, records: {} },
      layout: { providerRows: "inline", placement: "above", maxWidth: 100, segmentOrder: [], narrowPriority: [] },
      separators: { main: "|", window: "", provider: "", iconLabel: "", labelValue: "", spacingBefore: 0, spacingAfter: 0, trailingSpacing: 0, padding: "", preset: "Custom" },
      segments: { project: false, model: false, effort: false, context: false, session: false, throughput: false, time: false },
      bars: { width: 20, fill: "#", empty: "-", capLeft: "[", capRight: "]", showPercent: false, style: "block", truecolor: false, warnAt: 50, critAt: 75 },
      thresholds: { contextWarn: 50, contextCrit: 75 },
      icons: { style: "ascii", symbols: {}, providers: {} },
      preview: { mode: "narrow" },
    };
    writeFileSync(path, JSON.stringify(futureDoc), "utf8");

    const result = readStatuslineSettings(path);
    assert.equal(result.readOnly, true);
    assert.equal(result.settings.version, futureVersion);
    assert.equal(result.settings.enabled, false); // Not normalized
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: maxCacheAge below the floor is normalized on save", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const settings = {
      ...DEFAULT_STATUSLINE_SETTINGS,
      providers: {
        ...DEFAULT_STATUSLINE_SETTINGS.providers,
        defaults: { ...DEFAULT_STATUSLINE_SETTINGS.providers.defaults, maxCacheAgeMs: 50 },
      },
    };
    saveStatuslineSettings(settings, path);

    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.providers.defaults.maxCacheAgeMs, 10000); // floor
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: save refuses future version (readOnly)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-storage-"));
  const path = join(dir, "statusline.json");
  try {
    const futureVersion = CURRENT_VERSION + 1;
    const futureSettings = { ...DEFAULT_STATUSLINE_SETTINGS, version: futureVersion } as unknown as import("../src/settings/schema.ts").StatuslineSettings;
    assert.throws(() => saveStatuslineSettings(futureSettings, path), /read-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});