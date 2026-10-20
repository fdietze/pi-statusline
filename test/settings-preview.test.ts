import assert from "node:assert/strict";
import test from "node:test";
import { renderPreview } from "../src/settings/preview.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { updateProviderWindow } from "../src/settings/provider-ui.ts";
import type { ProviderUiContext } from "../src/settings/provider-ui.ts";
import type { ResolutionContext } from "../src/settings/resolve.ts";
import type { ProviderCapability } from "../src/settings/providers/capabilities.ts";
import type { RateLimitWindow } from "../src/ratelimit.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";

const subscriptionCap: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "subscription",
  quotaSupport: "official", quotaReliability: "high", localSpeed: false, hostedSpeed: true, tokenLedger: false, costLedger: false,
};

const anthropicWindows: RateLimitWindow[] = [
  { key: "five-hour", label: "5h", used: 0.23, resetAt: 3_600_000 },
  { key: "weekly", label: "wk", used: 0.41, resetAt: 86_400_000 },
];
const codexWindows: RateLimitWindow[] = [{ key: "primary", label: "1h", used: 0.3, resetAt: 3_600_000 }];

const providers: ProviderUiContext = {
  descriptors: [
    { id: "anthropic", displayName: "Claude", provenance: ["available"], available: true, authenticated: true, models: [{ provider: "anthropic" }] },
    { id: "openai-codex", displayName: "OpenAI Codex", provenance: ["available"], available: true, authenticated: true, models: [{ provider: "openai-codex" }] },
  ],
  capabilities: { anthropic: subscriptionCap, "openai-codex": subscriptionCap },
  windows: { anthropic: anthropicWindows, "openai-codex": codexWindows },
  activeProvider: "anthropic",
};

// Live session is Anthropic; the preview must reflect the draft against this real data.
function liveContext(): ResolutionContext {
  return {
    capability: subscriptionCap,
    runtime: {
      cwd: "/home/user/project",
      activeProvider: "anthropic",
      model: { id: "claude-sonnet-4-5", provider: "anthropic", reasoning: true },
      thinkingLevel: "high",
      contextUsage: { percent: 30, tokens: 60_000, contextWindow: 200_000 },
      sessionWindows: anthropicWindows,
      activeMs: 0,
      elapsedMs: 60_000,
      lastTurnMs: 5_000,
    },
  };
}

function previewLines(settings: StatuslineSettings, selectedProviderId?: string): string[] {
  return renderPreview({ settings, mode: "current", width: 200, current: liveContext(), providers, selectedProviderId });
}

test("preview reflects the live session, including the provider-tracking rows", () => {
  const lines = previewLines(DEFAULT_STATUSLINE_SETTINGS);
  assert.equal(lines[0], "Current session preview");
  assert.ok(lines.length > 2, `preview must render the main line plus provider rows: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((line) => line.includes("anthropic") && line.includes("5h")), `anthropic row with 5h window expected: ${JSON.stringify(lines)}`);
});

test("preview reflects the per-window 'visible' toggle before saving", () => {
  const on = previewLines(DEFAULT_STATUSLINE_SETTINGS).join("\n");
  assert.ok(on.includes("5h"), `visible 5h must appear: ${on}`);

  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  updateProviderWindow(draft, "anthropic", "five-hour", { visible: false });
  const off = previewLines(draft).join("\n");
  assert.equal(off.includes("5h"), false, `turning 5h visible off must remove it from the preview: ${off}`);
  assert.ok(off.includes("wk"), `sibling window must remain: ${off}`);
});

test("preview refocuses on the provider whose detail is being edited", () => {
  // The live session is Anthropic, but the user opened the OpenAI Codex detail screen.
  const lines = previewLines(DEFAULT_STATUSLINE_SETTINGS, "openai-codex");
  assert.equal(lines[0], "OpenAI Codex preview", `label must switch to the edited provider: ${lines[0]}`);
  const joined = lines.join("\n");
  // The refocused main line carries the edited provider's model, not the live Anthropic model.
  assert.ok(joined.includes("OpenAI Codex"), `edited provider must appear: ${joined}`);
  assert.equal(joined.includes("claude-sonnet-4-5"), false, `live Anthropic model must not dominate the edited-provider preview: ${joined}`);
});

test("preview reflects draft extras (session elapsed) before saving", () => {
  // Extras off (default): the time segment omits the elapsed annotation.
  const off = previewLines(DEFAULT_STATUSLINE_SETTINGS).join("\n");
  assert.equal(off.includes("elapsed"), false, `sessionElapsed off must hide elapsed: ${off}`);

  const on = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  on.extras.sessionElapsed = true;
  const onJoined = previewLines(on).join("\n");
  assert.ok(onJoined.includes("elapsed"), `sessionElapsed on must show elapsed in the preview: ${onJoined}`);
});

test("preview immediately reflects the draft master enabled toggle", () => {
  const disabled = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  disabled.enabled = false;
  assert.deepEqual(previewLines(disabled), ["Current session preview", "Statusline disabled"]);
});

test("current preview forwards the session and host names to the same bounded footer renderer", async () => {
  const { composeFooterLine } = await import("../src/settings/resolve.ts");
  const { renderMainLine } = await import("../src/render.ts");
  const runtime = { cwd: "/project", sessionName: "Preview title", hostname: "previewhost", extensionStatuses: [{ key: "mcp", value: "MCP 2/2" }] };
  for (const width of [12, 40, 100]) {
    assert.equal(composeFooterLine(DEFAULT_STATUSLINE_SETTINGS, { runtime }, width),
      renderMainLine(DEFAULT_STATUSLINE_SETTINGS, runtime, width));
  }
});

test("fixture previews show a fixed host name before the project", () => {
  for (const mode of ["local", "subscription", "api"] as const) {
    const [, main] = renderPreview({ settings: DEFAULT_STATUSLINE_SETTINGS, mode, width: 200, current: liveContext(), providers });
    assert.ok(main!.startsWith("workstation 📁 project"), main);
  }
});
