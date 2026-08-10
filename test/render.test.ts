import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { renderMainLine, resolveWindowDisplay, renderProviderRows, providerHasRow, sourceRenders, type ProviderRowSource } from "../src/render.ts";
import type { RateLimitWindow } from "../src/ratelimit.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";

const fiveHour: RateLimitWindow = { key: "five-hour", label: "5h", used: 0.23, resetAt: 9_000 };
const weekly: RateLimitWindow = { key: "weekly", label: "wk", used: 0.41 };

function settingsWith(provider: string, windows: Record<string, Partial<StatuslineSettings["providers"]["records"][string]["windows"][string]>>): StatuslineSettings {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  if (!draft.providers.order.includes(provider)) draft.providers.order.push(provider);
  const record = (draft.providers.records[provider] ??= {
    enabled: true, displayMode: "default", windows: {}, activeModel: {} as never, supportedOverrides: [],
  });
  for (const [key, override] of Object.entries(windows)) {
    record.windows[key] = { visible: true, label: "", showBar: true, showPercent: true, showReset: true, resetFormat: "countdown", showUsed: true, showRemaining: true, showZero: false, width: 12, ...override };
  }
  return draft;
}

test("resolveWindowDisplay: falls back to global bars defaults when no per-window config exists", () => {
  const display = resolveWindowDisplay(DEFAULT_STATUSLINE_SETTINGS, "anthropic", fiveHour);
  assert.equal(display.visible, true);
  assert.equal(display.label, "5h", "absent label config keeps the adapter label");
  assert.equal(display.showBar, true);
  assert.equal(display.showPercent, DEFAULT_STATUSLINE_SETTINGS.bars.showPercent);
  assert.equal(display.width, DEFAULT_STATUSLINE_SETTINGS.bars.width);
});

test("resolveWindowDisplay: per-window config overrides globals", () => {
  const s = settingsWith("anthropic", { "five-hour": { visible: false, label: "5hr", showBar: false, showPercent: false, width: 5 } });
  const display = resolveWindowDisplay(s, "anthropic", fiveHour);
  assert.equal(display.visible, false);
  assert.equal(display.label, "5hr", "custom label overrides adapter label");
  assert.equal(display.showBar, false);
  assert.equal(display.showPercent, false);
  assert.equal(display.width, 5);
});

test("renderProviderRows: hides windows whose per-window visible flag is off", () => {
  const on = settingsWith("anthropic", {});
  const rows = renderProviderRows(on, [{ provider: "anthropic", windows: [fiveHour, weekly] }], undefined, 0);
  const joined = rows.join("\n");
  assert.ok(joined.includes("5h"), `visible default kept 5h: ${joined}`);
  assert.ok(joined.includes("wk"), `visible default kept wk: ${joined}`);

  const off = settingsWith("anthropic", { "five-hour": { visible: false } });
  const rowsOff = renderProviderRows(off, [{ provider: "anthropic", windows: [fiveHour, weekly] }], undefined, 0);
  const joinedOff = rowsOff.join("\n");
  assert.equal(joinedOff.includes("5h"), false, `invisible 5h must not render: ${joinedOff}`);
  assert.ok(joinedOff.includes("wk"), `sibling window still renders: ${joinedOff}`);
});

test("renderProviderRows: honors per-window showBar / showReset / label", () => {
  const s = settingsWith("anthropic", { "five-hour": { showBar: false, showReset: false, label: "FIVE" } });
  const [line] = renderProviderRows(s, [{ provider: "anthropic", windows: [{ ...fiveHour, resetAt: 9_000 }] }], undefined, 0);
  assert.ok(line!.includes("FIVE"), `custom label renders: ${line}`);
  assert.equal(line!.includes("↻"), false, `showReset off hides the reset countdown`);
  assert.equal(line!.includes("%"), false, `showBar off hides the bar (and its percent)`);
});

test("renderProviderRows: placeholder renders when a provider has no windows yet", () => {
  const rows = renderProviderRows(DEFAULT_STATUSLINE_SETTINGS, [{ provider: "anthropic", windows: [], placeholder: "5h — wk —" }], undefined, 0);
  assert.deepEqual(rows, ["anthropic 5h — wk —"]);
});

test("renderProviderRows: returns nothing when provider tracking is disabled", () => {
  const disabled = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  disabled.providers.enabled = false;
  const rows = renderProviderRows(disabled, [{ provider: "anthropic", windows: [fiveHour] }], undefined, 0);
  assert.deepEqual(rows, []);
});

test("providerHasRow / sourceRenders: a placeholder row counts (main line hides its quota)", () => {
  const placeholderSource: ProviderRowSource = { provider: "anthropic", windows: [], placeholder: "5h — wk —" };
  assert.equal(sourceRenders(DEFAULT_STATUSLINE_SETTINGS, placeholderSource), true);
  assert.equal(providerHasRow(DEFAULT_STATUSLINE_SETTINGS, [placeholderSource], "anthropic"), true);
  assert.equal(providerHasRow(DEFAULT_STATUSLINE_SETTINGS, [placeholderSource], "openai-codex"), false);
});

test("providerHasRow: an invisible-only window does not count as a row", () => {
  const hidden = settingsWith("anthropic", { "five-hour": { visible: false }, weekly: { visible: false } });
  const source: ProviderRowSource = { provider: "anthropic", windows: [fiveHour, weekly] };
  assert.equal(sourceRenders(hidden, source), false);
  assert.equal(providerHasRow(hidden, [source], "anthropic"), false);
});

test("renderMainLine applies active-provider segment overrides", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.providers.records.anthropic = {
    enabled: true,
    displayMode: "custom",
    windows: {},
    activeModel: { ...Object.fromEntries(Object.keys(settings.segments).map((id) => [id, "default"])), project: "off" } as never,
    supportedOverrides: ["project"],
  };

  const line = renderMainLine(settings, {
    cwd: "/tmp/project",
    model: { id: "claude", provider: "anthropic", reasoning: false },
    contextUsage: { percent: 20, tokens: 20_000, contextWindow: 100_000 },
  }, 200);

  assert.equal(line.includes("project"), false);
  assert.ok(line.includes("claude"));
});

test("default separator leaves space before each following emoji segment", () => {
  const line = renderMainLine(DEFAULT_STATUSLINE_SETTINGS, {
    cwd: "/tmp/nixos",
    gitBranch: "main",
    model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true },
    thinkingLevel: "high",
    contextUsage: { percent: 13.2, tokens: 36_000, contextWindow: 272_000 },
    subscription: true,
    meter: { activeMs: 60_000 },
  }, 200);

  assert.ok(line.includes("nixos > main"), line);
  for (const glyph of ["🤖", "🧠", "🪟", "⏳"]) {
    assert.ok(line.includes(` > ${glyph}`), `missing separator space before ${glyph}: ${line}`);
    assert.equal(line.includes(`>${glyph}`), false, `separator touches ${glyph}: ${line}`);
  }
});

test("bar thresholds and truecolor toggle control rendered colors", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.bars.warnAt = 40;
  settings.bars.critAt = 80;
  settings.bars.truecolor = false;
  const theme = {
    fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
    getColorMode: () => "truecolor",
  } as never;

  const line = renderMainLine(settings, {
    cwd: "/tmp/project",
    model: { id: "claude", provider: "anthropic", reasoning: false },
    sessionWindows: [{ key: "five-hour", label: "5h", used: 0.5 }],
  }, 200, theme);

  assert.ok(line.includes("<warning>"), line);
  assert.equal(line.includes("\x1b[38;2;"), false, line);
});

test("configured separator spacing and narrow drop priority affect the line", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.separators.main = "|";
  settings.separators.padding = "~";
  settings.separators.spacingBefore = 1;
  settings.separators.spacingAfter = 2;
  settings.layout.narrowPriority = ["context", "time", "throughput", "session", "effort", "model", "project"];
  const snapshot = {
    cwd: "/tmp/project",
    model: { id: "claude", provider: "anthropic", reasoning: true },
    thinkingLevel: "high",
    contextUsage: { percent: 20, tokens: 20_000, contextWindow: 100_000 },
  };

  const wide = renderMainLine(settings, snapshot, 200);
  assert.ok(wide.includes("~ |  "), wide);
  const narrow = renderMainLine(settings, snapshot, 35);
  assert.equal(narrow.includes("20.0%"), false, narrow);
  assert.ok(narrow.includes("project") || narrow.includes("claude"), narrow);
});
