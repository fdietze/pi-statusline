import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  resolveSegmentVisibility,
  resolveOrder,
  resolveBarConfig,
  composeFooterLine,
  type RuntimeSnapshot,
  type ResolutionContext,
} from "../src/settings/resolve.ts";
import { renderPreview, PREVIEW_FIXTURES } from "../src/settings/preview.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import type { StatuslineSettings, SegmentId, ActiveModelToggle } from "../src/settings/schema.ts";
import type { ProviderCapability } from "../src/settings/providers/capabilities.ts";

function settingsWith(overrides: Partial<StatuslineSettings>): StatuslineSettings {
  return { ...DEFAULT_STATUSLINE_SETTINGS, ...overrides } as StatuslineSettings;
}

const localCapability: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "local",
  quotaSupport: "none", quotaReliability: "none",
  localSpeed: true, hostedSpeed: false, tokenLedger: false, costLedger: false,
};
const subCapability: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "subscription",
  quotaSupport: "official", quotaReliability: "high",
  localSpeed: false, hostedSpeed: true, tokenLedger: false, costLedger: false,
};

function localRuntime(extra: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    cwd: "/home/user/project",
    model: { id: "qwen2.5-coder", provider: "ollama", reasoning: true },
    activeProvider: "ollama",
    thinkingLevel: "medium",
    contextUsage: { percent: 55, tokens: 550_000, contextWindow: 1_000_000 },
    throughput: { inputRate: 850, outputRate: 62 },
    ...extra,
  };
}

test("resolution: effort self-hides for non-reasoning models", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime({ model: { id: "x", reasoning: false }, thinkingLevel: "off" }) };
  const vis = resolveSegmentVisibility(DEFAULT_STATUSLINE_SETTINGS, ctx);
  assert.equal(vis.effort, false, "non-reasoning model must not show effort");
});

test("resolution: context self-hides when percent is null (post-compaction)", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime({ contextUsage: { percent: null as unknown as number, tokens: null, contextWindow: 200_000 } }) };
  const vis = resolveSegmentVisibility(DEFAULT_STATUSLINE_SETTINGS, ctx);
  assert.equal(vis.context, false);
});

test("resolution: session self-hides without quota support", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime() };
  assert.equal(resolveSegmentVisibility(DEFAULT_STATUSLINE_SETTINGS, ctx).session, false);
  const subCtx: ResolutionContext = {
    capability: subCapability,
    runtime: localRuntime({ sessionWindows: [{ label: "5h", used: 0.23 }] }),
  };
  assert.equal(resolveSegmentVisibility(DEFAULT_STATUSLINE_SETTINGS, subCtx).session, true);
});

test("resolution: throughput self-hides without a measured rate", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime({ throughput: {} }) };
  assert.equal(resolveSegmentVisibility(DEFAULT_STATUSLINE_SETTINGS, ctx).throughput, false);
});

test("resolution: activeModel tri-state 'off' overrides global on", () => {
  const s = settingsWith({
    providers: {
      ...DEFAULT_STATUSLINE_SETTINGS.providers,
      records: {
        ollama: {
          enabled: true, displayMode: "default", windows: {},
          activeModel: { effort: "off" } as Record<SegmentId, ActiveModelToggle>,
          supportedOverrides: [],
        },
      },
    },
  });
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime() };
  assert.equal(resolveSegmentVisibility(s, ctx).effort, false);
});

test("resolution: activeModel tri-state 'on' overrides global off", () => {
  const s = settingsWith({
    segments: { ...DEFAULT_STATUSLINE_SETTINGS.segments, time: false },
    providers: {
      ...DEFAULT_STATUSLINE_SETTINGS.providers,
      records: {
        ollama: {
          enabled: true, displayMode: "default", windows: {},
          activeModel: { time: "on" } as Record<SegmentId, ActiveModelToggle>,
          supportedOverrides: [],
        },
      },
    },
  });
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime({ activeMs: 120_000 }) };
  assert.equal(resolveSegmentVisibility(s, ctx).time, true);
});

test("resolution: 'default' inherits global", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime() };
  const vis = resolveSegmentVisibility(DEFAULT_STATUSLINE_SETTINGS, ctx);
  // model is global-on, applicable, no override => inherits on.
  assert.equal(vis.model, true);
});

test("resolution: order validates and falls back to defaults when empty/invalid", () => {
  assert.deepEqual(resolveOrder(DEFAULT_STATUSLINE_SETTINGS).segmentOrder, ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"]);
  const bad = settingsWith({ layout: { ...DEFAULT_STATUSLINE_SETTINGS.layout, segmentOrder: ["bogus" as SegmentId] } });
  assert.deepEqual(resolveOrder(bad).segmentOrder, ["project", "model", "effort", "extensions", "context", "session", "throughput", "time"]);
});

test("resolution: resolveBarConfig passes through and bounds bar settings", () => {
  const bar = resolveBarConfig(DEFAULT_STATUSLINE_SETTINGS);
  assert.equal(bar.width, 12);
  assert.equal(bar.fill, "█");
  assert.equal(bar.showPercent, true);
  const tiny = settingsWith({ bars: { ...DEFAULT_STATUSLINE_SETTINGS.bars, width: 0, fill: "" } });
  const resolved = resolveBarConfig(tiny);
  assert.equal(resolved.width, 2, "width clamped to min 2");
  assert.equal(resolved.fill, "█", "empty fill falls back to default");
});

test("resolution: composeFooterLine never exceeds the requested width", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime() };
  for (const width of [40, 60, 80, 120]) {
    const line = composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, ctx, width);
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} > ${width}`);
  }
});

test("resolution: trailing spacing stays inside the requested width budget", () => {
  const settings = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  settings.separators.trailingSpacing = 3;
  const line = composeFooterLine(settings, { capability: localCapability, runtime: localRuntime() }, 5);
  assert.ok(visibleWidth(line) <= 5, `${visibleWidth(line)} > 5`);
  assert.equal(line.slice(-3), "   ");
});

test("preview: produces a labelled, width-bounded line for each fixture mode", () => {
  for (const mode of ["local", "subscription", "api", "narrow"] as const) {
    const width = mode === "narrow" ? 40 : 100;
    const lines = renderPreview({ settings: DEFAULT_STATUSLINE_SETTINGS, mode, width });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /preview$/);
    assert.ok(visibleWidth(lines[1]) <= width, `${mode}: ${visibleWidth(lines[1])} > ${width}`);
  }
});

test("preview: parity — equals composeFooterLine for the same fixture/settings", () => {
  const fixture = PREVIEW_FIXTURES.subscription;
  const ctx: ResolutionContext = { capability: fixture.capability, runtime: fixture.snapshot };
  const preview = renderPreview({ settings: DEFAULT_STATUSLINE_SETTINGS, mode: "subscription", width: 100 })[1];
  const direct = composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, ctx, 100);
  assert.equal(preview, direct);
});

test("preview: representative U8 draft presentation settings alter the shared resolver immediately", () => {
  const line = (settings: StatuslineSettings, mode: "local" | "subscription" = "local") => renderPreview({ settings, mode, width: 160 })[1];
  const baseline = line(DEFAULT_STATUSLINE_SETTINGS);

  const separators = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  separators.separators.main = " | ";
  assert.notEqual(line(separators), baseline);

  const layout = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  layout.layout.segmentOrder = [...layout.layout.segmentOrder].reverse();
  assert.notEqual(line(layout), baseline);

  const bars = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  bars.bars.width = 3;
  assert.notEqual(line(bars, "subscription"), line(DEFAULT_STATUSLINE_SETTINGS, "subscription"));

  const ascii = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  ascii.icons.style = "ascii";
  const none = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  none.icons.style = "none";
  const nerd = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  nerd.icons.style = "nerdfont";
  assert.notEqual(line(ascii), line(none));
  assert.notEqual(line(nerd), line(ascii));

  const provider = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  provider.icons.providers.ollama = { mode: "custom", value: "LOCAL" };
  assert.notEqual(line(provider), baseline);
});

test("preview: is pure — does not mutate fixtures or settings", () => {
  const beforeSettings = JSON.stringify(DEFAULT_STATUSLINE_SETTINGS);
  const beforeFixture = JSON.stringify(PREVIEW_FIXTURES.subscription);
  renderPreview({ settings: DEFAULT_STATUSLINE_SETTINGS, mode: "subscription", width: 80 });
  renderPreview({ settings: DEFAULT_STATUSLINE_SETTINGS, mode: "local", width: 40 });
  assert.equal(JSON.stringify(DEFAULT_STATUSLINE_SETTINGS), beforeSettings);
  assert.equal(JSON.stringify(PREVIEW_FIXTURES.subscription), beforeFixture);
});

// U11 gap-fill: parity for every mode, not just subscription.
test("preview: parity — equals composeFooterLine for all four fixture modes", () => {
  for (const mode of ["local", "subscription", "api", "narrow"] as const) {
    const width = mode === "narrow" ? 40 : 100;
    const fixture = PREVIEW_FIXTURES[mode];
    const ctx: ResolutionContext = { capability: fixture.capability, runtime: fixture.snapshot };
    const preview = renderPreview({ settings: DEFAULT_STATUSLINE_SETTINGS, mode, width })[1];
    const direct = composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, ctx, width);
    assert.equal(preview, direct, `${mode}: preview diverged from composeFooterLine`);
  }
});

// Context threshold settings now drive the context segment's color role (the footer never had
// text markers); verify the role flips at the configured warn/crit percentages via a themed paint.
test("resolution: context threshold color role changes at warn and crit percentages", () => {
  const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` } as never;
  const ctx = (percent: number): ResolutionContext => ({
    capability: localCapability,
    runtime: localRuntime({ contextUsage: { percent, tokens: percent * 1_000, contextWindow: 100_000 } }),
  });
  // Below warn (default 80): success.
  const safe = composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, ctx(79), 200, theme);
  assert.ok(safe.includes("<success>"), `expected success below warn, got: ${safe}`);
  // At/above warn (80) but below crit (95): warning.
  const warn = composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, ctx(80), 200, theme);
  assert.ok(warn.includes("<warning>"), `expected warning at warn, got: ${warn}`);
  // At/above crit (95): error.
  const crit = composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, ctx(95), 200, theme);
  assert.ok(crit.includes("<error>"), `expected error at crit, got: ${crit}`);
});

// U11 gap-fill: icon-style content — ascii emits letter codes; none produces no symbol prefix.
test("resolution: icon style ascii emits letter codes; none produces no symbol prefix", () => {
  const ctx: ResolutionContext = { capability: localCapability, runtime: localRuntime() };
  const ascii = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  ascii.icons.style = "ascii";
  const asciiLine = composeFooterLine(ascii, ctx, 200);
  // ascii preset: project='P', model='M', thinking='T', context='C', throughput='R'. Each icon is
  // followed by a space (matching the live footer's `📁 project` spacing).
  assert.ok(asciiLine.includes("P project"), `ascii: expected 'P project' icon+label, got: ${asciiLine}`);
  assert.ok(asciiLine.startsWith("P "), `ascii: expected project 'P' icon, got: ${asciiLine}`);
  assert.ok(asciiLine.includes("T medium"), `ascii: expected thinking 'T' icon, got: ${asciiLine}`);

  const none = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  none.icons.style = "none";
  const noneLine = composeFooterLine(none, ctx, 200);
  // With no icons the plain segment value starts directly — no emoji/unicode/letter prefix.
  assert.ok(!noneLine.includes("📁"), `none: unexpected emoji in: ${noneLine}`);
  assert.ok(!noneLine.includes("🤖"), `none: unexpected emoji in: ${noneLine}`);
  // The project basename still appears, just without a symbol in front.
  assert.ok(noneLine.includes("project"), `none: expected project basename in: ${noneLine}`);
});
