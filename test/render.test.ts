import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { renderMainLine, resolveWindowDisplay, renderProviderRows, providerHasRow, sourceRenders, type ProviderRowSource } from "../src/render.ts";
import type { RateLimitWindow } from "../src/ratelimit.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";
import { parseStatuslineSettings } from "../src/settings/validation.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

test("renderProviderRows: shows explicit over, under, and measured on-pace text", () => {
  const now = 1_000_000;
  const durationMs = 100_000;
  const window = (label: string, used: number): RateLimitWindow => ({
    label,
    used,
    durationMs,
    resetAt: now + durationMs / 2,
  });
  const [line] = renderProviderRows(DEFAULT_STATUSLINE_SETTINGS, [{
    provider: "openai-codex",
    windows: [window("over", 0.56), window("under", 0.44), window("even", 0.506)],
  }], undefined, now);

  assert.ok(line!.includes("≈6pp over"), line);
  assert.ok(line!.includes("≈6pp under"), line);
  assert.ok(line!.includes("≈0.6pp on pace"), line);
  assert.equal(line!.includes("pp/d"), false, line);
});

test("renderProviderRows: shows approximate operational-day usage without a start timestamp", () => {
  const [line] = renderProviderRows(DEFAULT_STATUSLINE_SETTINGS, [{
    provider: "openai-codex",
    windows: [{ ...weekly, dailyUsed: 0.006 }],
  }], undefined, 0);

  assert.ok(line!.includes("≈0.6pp today"), line);
  assert.equal(line!.includes("since"), false, line);
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

test("generic extension statuses preserve order, styling, and display width", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  for (const id of Object.keys(settings.segments)) settings.segments[id as keyof typeof settings.segments] = false;
  settings.segments.extensions = true;
  settings.layout.segmentOrder = ["extensions"];
  settings.layout.narrowPriority = ["extensions"];

  const render = (values: string[], width = 100) => renderMainLine(settings, {
    cwd: "/tmp/project",
    extensionStatuses: values.map((value, index) => ({ key: `status-${index}`, value })),
  }, width);

  assert.equal(render([]), "");
  settings.segments.extensions = false;
  assert.equal(render(["FAST"]), "", "the generic segment honors its visibility setting");
  settings.segments.extensions = true;
  assert.equal(render(["FAST"]), "FAST");
  assert.equal(render(["FAST", "REVIEW"]), "FAST REVIEW");
  assert.equal(render(["  FAST\n\tMODE  ", "", "\r\n"]), "FAST MODE");

  const styled = "\x1b[31mFAST\x1b[0m";
  assert.equal(render([styled]), styled);
  assert.equal(visibleWidth(render([styled])), 4);
  assert.equal(render([styled], 3), "", "extension statuses drop cleanly under width pressure");
});

test("configured extension status keys align right without moving other statuses", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS) as typeof DEFAULT_STATUSLINE_SETTINGS & {
    layout: { rightAlignedExtensionStatuses: string[] };
  };
  for (const id of Object.keys(settings.segments)) settings.segments[id as keyof typeof settings.segments] = false;
  settings.segments.extensions = true;
  settings.layout.segmentOrder = ["extensions"];
  settings.layout.narrowPriority = ["extensions"];
  settings.layout.rightAlignedExtensionStatuses = ["mcp"];

  const styledMcp = "\x1b[36mMCP 3/3\x1b[0m";
  const snapshot = {
    cwd: "/tmp/project",
    extensionStatuses: [
      { key: "fast", value: "fast" },
      { key: "mcp", value: styledMcp },
    ],
  } as never;

  const decoratedFast = "⚡ fast";
  const decoratedMcp = `🔌 ${styledMcp}`;
  const wide = renderMainLine(settings, snapshot, 26);
  assert.equal(wide, `${decoratedFast}${" ".repeat(9)}${decoratedMcp}`);
  assert.equal(visibleWidth(wide), 26);
  assert.equal(renderMainLine(settings, snapshot, 10), decoratedFast, "the right status drops before left content");
  assert.equal(renderMainLine(settings, {
    cwd: "/tmp/project",
    extensionStatuses: [{ key: "mcp", value: styledMcp }],
  } as never, 10), decoratedMcp);

  settings.separators.trailingSpacing = 2;
  const styledWideMcp = "\x1b[36mMCP 🧠\x1b[0m";
  const wideGlyphLine = renderMainLine(settings, {
    cwd: "/tmp/project",
    extensionStatuses: [
      { key: "review", value: "FAST" },
      { key: "mcp", value: styledWideMcp },
    ],
  } as never, 24);
  assert.equal(visibleWidth(wideGlyphLine), 24);
  assert.ok(wideGlyphLine.endsWith(`${styledWideMcp}  `), wideGlyphLine);
});

test("default right cluster strips Ponytail's circle, separates statuses, and drops Ponytail first", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  for (const id of Object.keys(settings.segments)) settings.segments[id as keyof typeof settings.segments] = false;
  settings.segments.extensions = true;
  settings.layout.segmentOrder = ["extensions"];
  settings.layout.narrowPriority = ["extensions"];

  const ponytail = "🐴 \x1b[2mponytail: \x1b[22m🌿 LITE";
  const mcp = "🔌 MCP 0/3";
  const cluster = `${ponytail} > ${mcp}`;

  for (const circle of ["○", "●"]) {
    const snapshot = {
      cwd: "/tmp/project",
      extensionStatuses: [
        { key: "ponytail", value: `\x1b[2m${circle}\x1b[22m ${ponytail}` },
        { key: "mcp", value: "MCP 0/3" },
      ],
    } as never;

    assert.equal(renderMainLine(settings, snapshot, visibleWidth(cluster)), cluster);
    const mcpOnly = renderMainLine(settings, snapshot, visibleWidth(cluster) - 1);
    assert.ok(mcpOnly.endsWith(mcp), mcpOnly);
    assert.equal(mcpOnly.includes("ponytail"), false, mcpOnly);
    assert.doesNotMatch(mcpOnly, /○|●/);
    assert.equal(renderMainLine(settings, snapshot, visibleWidth(mcp) - 1), "");
  }
});

test("right-aligned statuses disappear when the left side already needs responsive dropping", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  for (const id of Object.keys(settings.segments)) settings.segments[id as keyof typeof settings.segments] = false;
  settings.segments.extensions = true;
  settings.segments.context = true;
  settings.layout.segmentOrder = ["extensions", "context"];
  settings.layout.narrowPriority = ["extensions"];

  const baseStatuses = [{ key: "review", value: "LONG-INLINE-STATUS" }];
  const snapshot = {
    cwd: "/tmp/project",
    contextUsage: { percent: 20, tokens: 20_000, contextWindow: 100_000 },
    extensionStatuses: baseStatuses,
  };
  assert.ok(visibleWidth(renderMainLine(settings, snapshot, 200)) > 16);

  const withoutMcp = renderMainLine(settings, snapshot, 16);
  const withMcp = renderMainLine(settings, {
    ...snapshot,
    extensionStatuses: [...baseStatuses, { key: "mcp", value: "MCP 3/3" }],
  }, 16);
  assert.equal(withMcp, withoutMcp);
  assert.equal(withMcp.includes("MCP"), false, withMcp);
});

test("version 1 settings drop migrated statuses atomically at narrow widths", () => {
  const old = structuredClone(DEFAULT_STATUSLINE_SETTINGS) as unknown as Record<string, any>;
  old.version = 1;
  old.layout.segmentOrder = ["project", "model", "effort", "context", "session", "throughput", "time"];
  old.layout.narrowPriority = ["time", "throughput", "project", "effort", "model", "session"];
  delete old.segments.extensions;
  const settings = parseStatuslineSettings(old).settings;

  const line = renderMainLine(settings, {
    cwd: "/tmp/project",
    contextUsage: { percent: 20, tokens: 20_000, contextWindow: 100_000 },
    extensionStatuses: [{ key: "review", value: "\x1b[31mFAST-LONG-STATUS\x1b[0m" }],
  }, 20);

  assert.ok(visibleWidth(line) <= 20, line);
  assert.ok(line.includes("20.0%/100K"), line);
  assert.equal(line.includes("FA"), false, `status must drop as a segment, not truncate: ${line}`);
});

test("Fast status is inline after effort with a Nerd glyph and warning-colored text", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.providers.enabled = false;
  for (const id of Object.keys(settings.segments)) settings.segments[id as keyof typeof settings.segments] = false;
  settings.segments.effort = true;
  settings.segments.extensions = true;
  settings.segments.context = true;
  settings.icons.symbols.fast = "󱐋";
  const theme = {
    fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  } as never;
  const line = renderMainLine(settings, {
    cwd: "/tmp/nixos",
    model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true },
    thinkingLevel: "high",
    contextUsage: { percent: 13.2, tokens: 36_000, contextWindow: 272_000 },
    subscription: true,
    extensionStatuses: [
      { key: "review", value: "REVIEW" },
      { key: "fast", value: "fast" },
      { key: "mcp", value: "MCP 0/3" },
    ],
  }, 200, theme);

  assert.match(line, /<muted>🧠 high<\/muted><dim> > <\/dim>REVIEW 󱐋 <warning>fast<\/warning><dim> > <\/dim>/);
  assert.ok(line.endsWith("🔌 MCP 0/3"), line);
  assert.equal((line.match(/󱐋/g) ?? []).length, 1, line);
  assert.equal((line.match(/🔌/g) ?? []).length, 1, line);
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
  assert.ok(line.includes("🪟 13.2%/272K"), line);
  assert.equal(line.includes("🪟  13.2%/272K"), false, line);
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

test("session name is bold accent at the far right before configured trailing spacing", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.separators.trailingSpacing = 2;
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
  const accented = { ...theme, fg: (role: string, text: string) => role === "accent" ? `\x1b[36m${text}\x1b[39m` : text };
  const line = renderMainLine(settings, { cwd: "/project", sessionName: "Fix login" }, 80, accented);
  assert.ok(line.endsWith("\x1b[36m\x1b[1mFix login\x1b[22m\x1b[39m  "), line);
  assert.equal(visibleWidth(line), 80);
});

test("session name reserves at most half the content width and never overflows Unicode/narrow rows", () => {
  const names = ["A very long session name".repeat(5), "界👩‍💻e\u0301".repeat(12), "👨‍👩‍👦", "x"];
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  for (const trailing of [0, 2, 5]) {
    settings.separators.trailingSpacing = trailing;
    for (let width = 0; width <= 80; width++) {
      const inner = Math.max(0, width - trailing);
      for (const sessionName of names) {
        const named = renderMainLine(settings, { cwd: "/project", sessionName }, width);
        assert.ok(visibleWidth(named) <= width, `${width}: ${named}`);
        // With no left segments, the title's visible suffix cannot exceed its half-row budget.
        const empty = structuredClone(settings);
        for (const key of Object.keys(empty.segments)) empty.segments[key as keyof typeof empty.segments] = false;
        const title = renderMainLine(empty, { cwd: "", sessionName }, width).trim();
        assert.ok(visibleWidth(title) <= Math.floor(inner / 2), `${width}: ${title}`);
      }
    }
  }
});

test("session names are plain single-line text, stripping ANSI/OSC, controls and bidi overrides", () => {
  const dirty = " \x1b[31mRed\x1b[0m\nname\t\x1b]8;;https://evil.example\x07link\x1b]8;;\x1b\\\u202e\x00 ";
  const line = renderMainLine(DEFAULT_STATUSLINE_SETTINGS, { cwd: "", sessionName: dirty }, 80);
  assert.ok(line.endsWith("Red name link"), line);
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u202e]/);
  assert.equal(visibleWidth(line), 80);
});

test("session title survives left segment dropping and follows existing right-aligned statuses", () => {
  const snap = { cwd: "/project", model: { id: "large-model-name" }, sessionName: "Investigate", extensionStatuses: [{ key: "mcp", value: "MCP 2/2" }] };
  const full = renderMainLine(DEFAULT_STATUSLINE_SETTINGS, snap, 150);
  assert.ok(full.indexOf("MCP 2/2") < full.indexOf("Investigate"), full);
  assert.ok(full.endsWith("Investigate"), full);
  const narrow = renderMainLine(DEFAULT_STATUSLINE_SETTINGS, snap, 24);
  assert.ok(narrow.endsWith("Investigate"), narrow);
  assert.equal(narrow.includes("large-model-name"), false);
  assert.equal(visibleWidth(narrow), 24);
});

test("absent, cleared and control-only session names preserve the exact existing layout", () => {
  const snap = { cwd: "/project", extensionStatuses: [{ key: "mcp", value: "MCP 2/2" }] };
  for (let width = 0; width < 100; width++) {
    const unnamed = renderMainLine(DEFAULT_STATUSLINE_SETTINGS, snap, width);
    for (const sessionName of [undefined, "", " \t\r\n", "\x1b[31m\x1b[0m"]) {
      assert.equal(renderMainLine(DEFAULT_STATUSLINE_SETTINGS, { ...snap, sessionName }, width), unnamed);
    }
  }
});
