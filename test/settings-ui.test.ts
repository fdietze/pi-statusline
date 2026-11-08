import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import {
  ROOT_ROWS,
  createSettingsUi,
  isDirty,
  renderSettingsUi,
  replaceDraft,
  resetDraft,
  resolveDirtyChoice,
  routeSettingsKey,
  renderSettingsWindow,
} from "../src/settings/ui.ts";
import {
  buildProviderDetail,
  buildProviderScreen,
  cycleActiveModelOverride,
  moveProvider,
  reconcileProviderWindows,
  requestProviderRefresh,
  setProviderDisplayMode,
  setProviderIcon,
  setProviderMissingDataPolicy,
  setProviderRefreshOverrides,
  toggleProvider,
  updateProviderWindow,
  type ProviderUiContext,
} from "../src/settings/provider-ui.ts";
import type { ProviderCapability } from "../src/settings/providers/capabilities.ts";
import { buildSeparatorsScreen } from "../src/settings/separators-screen.ts";
import { buildEmojisScreen, ICON_SYMBOLS } from "../src/settings/emojis-screen.ts";

test("root rows and keyboard routing are exact and deterministic", () => {
  assert.deepEqual(ROOT_ROWS.map(({ label }) => label), ["Statusline & Providers", "Display", "Icons", "Reset all settings to default"]);

  const initial = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  assert.equal(routeSettingsKey(initial, "ArrowUp").state.selected, 0);
  assert.equal(routeSettingsKey(initial, "End").state.selected, ROOT_ROWS.length - 1);
  assert.equal(routeSettingsKey(initial, "x").state, initial);
  const moved = routeSettingsKey(initial, "ArrowDown").state;
  assert.equal(moved.selected, 1);
  assert.equal(routeSettingsKey(initial, "Enter").state.openRow, "providers");
  assert.equal(routeSettingsKey({ ...moved, openRow: "providers" }, "Escape").state.openRow, undefined);
  assert.deepEqual(initial, createSettingsUi(DEFAULT_STATUSLINE_SETTINGS));
});

test("draft creation, replacement, and reset are structured-cloned", () => {
  const source = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  const state = createSettingsUi(source);
  state.draft.layout.segmentOrder.reverse();
  assert.notDeepEqual(state.draft.layout.segmentOrder, source.layout.segmentOrder);

  const replacement = structuredClone(source);
  replacement.enabled = false;
  const replaced = replaceDraft(state, replacement);
  replacement.layout.segmentOrder.reverse();
  assert.notDeepEqual(replaced.draft.layout.segmentOrder, replacement.layout.segmentOrder);
  assert.equal(isDirty(replaced), true);

  replaced.draft.__unknown = { nested: { kept: true } };
  const reset = resetDraft(replaced);
  assert.deepEqual(reset.draft.layout, DEFAULT_STATUSLINE_SETTINGS.layout);
  assert.deepEqual(reset.draft.__unknown, { nested: { kept: true } });
  assert.notEqual(reset.draft.__unknown, replaced.draft.__unknown);
});

test("render uses production preview fixtures and hides preview when narrow without mutation", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const before = structuredClone(state);
  const wide = renderSettingsUi(state, { width: 100, previewMode: "local" });
  assert.ok(wide.includes("Local model preview"));
  assert.ok(wide.length > ROOT_ROWS.length + 1);

  const narrow = renderSettingsUi(state, { width: 79, previewMode: "local" });
  assert.equal(narrow.includes("Local model preview"), false);
  assert.equal(narrow.length, ROOT_ROWS.length + 1);
  assert.deepEqual(state, before);
});

test("dirty Save, Discard, and Cancel preserve state correctly", async () => {
  const initial = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const dirty = replaceDraft(initial, { ...initial.draft, enabled: false });
  const prompted = routeSettingsKey(dirty, "Escape").state;
  assert.equal(prompted.confirmClose, true);

  const cancelled = await resolveDirtyChoice(prompted, "cancel", () => assert.fail("must not save"));
  assert.equal(cancelled.action, "none");
  assert.equal(cancelled.state.draft.enabled, false);

  const discarded = await resolveDirtyChoice(prompted, "discard", () => assert.fail("must not save"));
  assert.equal(discarded.action, "close");
  assert.equal(discarded.state.draft.enabled, true);
  assert.notEqual(discarded.state.draft, discarded.state.original);

  const failed = await resolveDirtyChoice(prompted, "save", async (value) => {
    value.enabled = true;
    throw new Error("disk full");
  });
  assert.equal(failed.action, "confirm-close");
  assert.equal(failed.state.confirmClose, true);
  assert.equal(failed.state.error, "disk full");
  assert.equal(failed.state.draft.enabled, false);
  assert.equal(isDirty(failed.state), true);

  let saved: typeof initial.draft | undefined;
  const succeeded = await resolveDirtyChoice(prompted, "save", (value) => { saved = value; });
  assert.equal(succeeded.action, "close");
  assert.equal(succeeded.state.confirmClose, false);
  assert.equal(isDirty(succeeded.state), false);
  assert.notEqual(saved, succeeded.state.draft);
});

const supportedCapability: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "subscription",
  quotaSupport: "official", quotaReliability: "high",
};
const unavailableCapability: ProviderCapability = {
  available: false, authenticated: false, modelCount: 0, billing: "unknown",
  quotaSupport: "none", quotaReliability: "none",
  unavailableReason: "usage unavailable\u001b[31m",
};
const providerContext: ProviderUiContext = {
  descriptors: [
    { id: "dynamic-a", displayName: "Dynamic A", provenance: ["available"], available: true, authenticated: true, models: [{ provider: "dynamic-a" }] },
    { id: "stored-x", displayName: "Stored X", provenance: ["stored"], available: false, authenticated: false, models: [] },
  ],
  capabilities: { "dynamic-a": supportedCapability, "stored-x": unavailableCapability },
  health: { "dynamic-a": { state: "fresh" }, "stored-x": { state: "unknown" } },
  windows: { "dynamic-a": [{ key: "short", label: "Renamed", used: 0.2 }] },
  activeProvider: "dynamic-a",
};

test("provider screen key routing edits the shared draft and persists provider order", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";

  state = routeSettingsKey(state, "Space", providerContext).state;
  assert.equal(state.draft.enabled, false);
  state = routeSettingsKey(state, "ArrowDown", providerContext).state;
  state = routeSettingsKey(state, " ", providerContext).state;
  assert.equal(state.draft.providers.enabled, false);
  state = routeSettingsKey(state, "ArrowDown", providerContext).state;
  state = routeSettingsKey(state, "Space", providerContext).state;
  assert.equal(state.draft.providers.records["dynamic-a"].enabled, false);
  state = routeSettingsKey(state, "Ctrl+ArrowDown", providerContext).state;
  assert.deepEqual(state.draft.providers.order, ["stored-x", "dynamic-a"]);
  assert.equal(state.selected, 3);
  assert.deepEqual(buildProviderScreen(state.draft, providerContext).rows.map((row) => row.id), ["stored-x", "dynamic-a"]);
});

test("provider screen is truthful, capability-gated, and integrated without I/O", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";
  const screen = buildProviderScreen(state.draft, providerContext);
  assert.equal(screen.statuslineEnabled, true);
  assert.equal(screen.providerTrackingEnabled, true);
  assert.deepEqual(screen.rows.map((row) => row.id), ["dynamic-a", "stored-x"]);
  assert.equal(screen.rows[1].quota, "Not available: usage unavailable");
  setProviderDisplayMode(state.draft, "dynamic-a", "custom", providerContext.windows!["dynamic-a"]);
  cycleActiveModelOverride(state.draft, "dynamic-a", "context");
  setProviderIcon(state.draft, "dynamic-a", { mode: "custom", value: "D" });
  setProviderMissingDataPolicy(state.draft, "dynamic-a", "warning");
  setProviderRefreshOverrides(state.draft, "dynamic-a", {
    refreshIntervalMs: 20_000,
    maxCacheAgeMs: 40_000,
    useCache: false,
    keepAfterFailure: false,
    refreshWhileActive: true,
    refreshDisabledProvider: true,
  });
  updateProviderWindow(state.draft, "dynamic-a", "short", {
    visible: false,
    label: "Mine",
    showBar: false,
    showPercent: false,
    showReset: true,
    resetFormat: "exact-date",
    showUsed: false,
    showRemaining: false,
    showZero: true,
    width: 18,
  });
  const detail = buildProviderDetail(state.draft, providerContext, "dynamic-a")!;
  assert.equal(detail.displayMode, "custom");
  assert.equal(detail.activeModel.context, "off");
  assert.deepEqual(detail.providerIcon, { mode: "custom", value: "D" });
  assert.equal(detail.missingDataPolicy, "warning");
  assert.deepEqual(detail.refresh, {
    intervalMs: 20_000, maxAgeMs: 40_000, useCache: false, keepAfterFailure: false,
    refreshWhileActive: true, refreshDisabledProvider: true,
  });
  assert.equal(detail.refreshNowEligible, true);
  assert.deepEqual(detail.quotaWindows[0].settings, {
    visible: false, label: "Mine", showBar: false, showPercent: false, showReset: true,
    resetFormat: "exact-date", showUsed: false, showRemaining: false, showZero: true, width: 18,
  });
  state.selectedProviderId = "dynamic-a";
  state.selected = 0;
  const lines = renderSettingsUi(state, { width: 79, providers: providerContext });
  assert.ok(lines.some((line) => line === "Provider: Dynamic A"));
  assert.ok(lines.some((line) => line === "> Show project for this provider: on"));
  assert.ok(lines.some((line) => line === "  Refresh usage now"));
  assert.ok(lines.some((line) => line === "  Mine Reset format: exact-date"));
  assert.ok(lines.some((line) => line === "  Mine Width: 18"));
  assert.equal(lines.some((line) => /Display mode|Provider icon|Missing data|Use cache|Show zero/.test(line)), false);
});

test("provider draft actions retain configuration, stable order, overrides, and icon path", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  draft.providers.order = ["dynamic-a", "stored-x"];
  toggleProvider(draft, "dynamic-a");
  assert.equal(draft.providers.records["dynamic-a"].enabled, false);
  moveProvider(draft, "stored-x", "up");
  assert.deepEqual(draft.providers.order, ["stored-x", "dynamic-a"]);
  setProviderDisplayMode(draft, "dynamic-a", "custom", [{ key: "short", label: "Short", used: 0.2 }]);
  assert.ok(draft.providers.records["dynamic-a"].windows.short);
  cycleActiveModelOverride(draft, "dynamic-a", "context");
  assert.equal(draft.providers.records["dynamic-a"].activeModel.context, "off");
  setProviderIcon(draft, "dynamic-a", { mode: "custom", value: "D" });
  assert.deepEqual(draft.icons.providers["dynamic-a"], { mode: "custom", value: "D" });
});

test("display mode and window reconciliation fail closed on invalid adapter keys", () => {
  const empty = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  setProviderDisplayMode(empty, "dynamic-a", "custom", [{ key: "", label: "Bad", used: 0 }]);
  assert.equal(empty.providers.records["dynamic-a"], undefined);

  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  setProviderDisplayMode(draft, "dynamic-a", "custom", [{ key: "short", label: "Old", used: 0.1 }]);
  const beforeProvider = structuredClone(draft.providers.records["dynamic-a"]);
  setProviderDisplayMode(draft, "dynamic-a", "default");
  setProviderDisplayMode(draft, "dynamic-a", "custom", [
    { key: "same", label: "A", used: 0 }, { key: "same", label: "B", used: 0 },
  ]);
  assert.equal(draft.providers.records["dynamic-a"].displayMode, "default");
  assert.deepEqual(draft.providers.records["dynamic-a"].windows, beforeProvider.windows);

  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [{ key: "short", label: "Old", used: 0.1 }]).ok, true);
  updateProviderWindow(draft, "dynamic-a", "short", { label: "Mine", width: 500 });
  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [
    { key: "monthly", label: "Month", used: 0.3 }, { key: "short", label: "New", used: 0.2 },
  ]).ok, true);
  assert.equal(draft.providers.records["dynamic-a"].windows.short.label, "Mine");
  assert.equal(draft.providers.records["dynamic-a"].windows.short.width, 200);
  assert.equal(draft.providers.records["dynamic-a"].windows.monthly.width, 12);
  const before = structuredClone(draft.providers.records["dynamic-a"].windows);
  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [{ key: "", label: "Bad", used: 0 }]).ok, false);
  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [
    { key: "same", label: "A", used: 0 }, { key: "same", label: "B", used: 0 },
  ]).ok, false);
  assert.deepEqual(draft.providers.records["dynamic-a"].windows, before);
});

test("refresh/cache draft edits are bounded and reject non-finite ages", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  setProviderRefreshOverrides(draft, "dynamic-a", {
    refreshIntervalMs: 5_000,
    maxCacheAgeMs: 1,
    useCache: false,
  });
  assert.deepEqual(draft.providers.records["dynamic-a"].refresh, {
    refreshIntervalMs: 10_000,
    maxCacheAgeMs: 10_000,
    useCache: false,
  });
  setProviderRefreshOverrides(draft, "dynamic-a", { maxCacheAgeMs: Number.NaN });
  assert.deepEqual(draft.providers.records["dynamic-a"].refresh, {});
});

test("refresh-now is only an explicit effect for eligible providers", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  assert.deepEqual(requestProviderRefresh(draft, "dynamic-a", supportedCapability), { type: "refresh-provider", providerId: "dynamic-a" });
  assert.equal(requestProviderRefresh(draft, "stored-x", unavailableCapability), undefined);
});

test("provider detail navigation routes every editable control through the shared draft", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";
  state.selected = 2;
  let routed = routeSettingsKey(state, "Enter", providerContext);
  state = routed.state;
  assert.equal(state.selectedProviderId, "dynamic-a");

  const select = (text: string) => {
    const lines = renderSettingsUi(state, { width: 79, providers: providerContext });
    const line = lines.findIndex((value) => value.includes(text));
    assert.ok(line >= 2, `missing detail row: ${text}`);
    state = { ...state, selected: line - 2 };
  };
  const edit = (text: string, key = "Enter") => {
    select(text);
    routed = routeSettingsKey(state, key, providerContext);
    state = routed.state;
  };

  edit("Show context for this provider:");
  assert.equal(state.draft.providers.records["dynamic-a"].activeModel.context, "on");
  edit("Refresh usage now");
  assert.deepEqual(routed.effect, { type: "refresh-provider", providerId: "dynamic-a" });
  edit("Renamed Visible:");
  assert.equal(state.draft.providers.records["dynamic-a"].windows.short.visible, false);
  edit("Renamed Width:", "ArrowRight");
  assert.equal(state.draft.providers.records["dynamic-a"].windows.short.width, 13);

  state = routeSettingsKey(state, "Escape", providerContext).state;
  assert.equal(state.selectedProviderId, undefined);
  assert.equal(state.selected, 2);
});

test("provider detail shows only editable, working controls", () => {
  const renderDetail = (context: ProviderUiContext) => {
    const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
    state.openRow = "providers";
    state.selectedProviderId = context.descriptors[0].id;
    return renderSettingsUi(state, { width: 79, providers: context });
  };
  const subscription = renderDetail(providerContext);
  assert.ok(subscription.some((line) => line.includes("Refresh usage now")));
  assert.ok(subscription.some((line) => line.includes("Renamed Visible:")));

  const contextFor = (id: string, capability: ProviderCapability): ProviderUiContext => ({
    descriptors: [{ id, displayName: id, provenance: ["available"], available: true, authenticated: true, models: [{ provider: id }] }],
    capabilities: { [id]: capability },
  });
  for (const lines of [
    renderDetail(contextFor("local", { ...supportedCapability, billing: "local", quotaSupport: "none", quotaReliability: "none" })),
    renderDetail(contextFor("api", { ...supportedCapability, billing: "api", quotaSupport: "none", quotaReliability: "none" })),
  ]) {
    assert.equal(lines.some((line) => /Available|Refresh interval|Use cache|Missing data|Provider icon/.test(line)), false);
    assert.ok(lines.some((line) => line.includes("Reset provider to default")));
  }
});

test("display screen exposes working controls and omits inert settings", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.selected = 1;
  state = routeSettingsKey(state, "Enter", providerContext).state;
  assert.equal(state.openRow, "separators");

  const ids = buildSeparatorsScreen(state.draft).map(({ id }) => id);
  for (const id of [
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.segments).map((key) => `segments.${key}`),
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.extras).map((key) => `extras.${key}`),
    "layout.segmentOrder.project", "layout.narrowPriority.project",
    "separators.main", "separators.padding",
    "separators.spacingBefore", "separators.spacingAfter", "separators.trailingSpacing",
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.bars).map((key) => `bars.${key}`),
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.thresholds).map((key) => `thresholds.${key}`),
  ]) assert.ok(ids.includes(id), `missing working settings row ${id}`);
  for (const id of [
    "layout.providerRows", "layout.placement", "layout.maxWidth", "separators.window",
    "separators.provider", "separators.iconLabel", "separators.labelValue", "separators.preset",
    "timing.refreshIntervalMs", "timing.maxCacheAgeMs", "reset.all",
  ]) assert.equal(ids.includes(id), false, `inert or duplicate row must stay hidden: ${id}`);

  const select = (id: string) => ({ ...state, selected: buildSeparatorsScreen(state.draft).findIndex((row) => row.id === id) });
  state = routeSettingsKey(select("segments.project"), "Space", providerContext).state;
  assert.equal(state.draft.segments.project, false);
  state = routeSettingsKey(select("layout.segmentOrder.model"), "Ctrl+ArrowUp", providerContext).state;
  assert.deepEqual(state.draft.layout.segmentOrder.slice(0, 2), ["model", "project"]);
  state = routeSettingsKey(select("layout.narrowPriority.model"), "Ctrl+ArrowUp", providerContext).state;
  assert.deepEqual(state.draft.layout.narrowPriority.slice(0, 2), ["model", "project"]);

  state = routeSettingsKey(select("separators.main"), "X", providerContext).state;
  assert.equal(state.draft.separators.main, " >X");
  state.draft.bars.width = 99;
  state = routeSettingsKey(select("reset.separators"), "Enter", providerContext).state;
  assert.deepEqual(state.draft.separators, DEFAULT_STATUSLINE_SETTINGS.separators);
  assert.equal(state.draft.bars.width, 99, "section reset must be isolated");
});

test("text rows accept printable navigation letters and space before key actions", () => {
  let separators = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  separators.openRow = "separators";
  separators.selected = buildSeparatorsScreen(separators.draft).findIndex(({ id }) => id === "separators.main");
  const separatorRow = separators.selected;
  for (const key of ["h", "j", "k", "l", " "]) {
    separators = routeSettingsKey(separators, key, providerContext).state;
    assert.equal(separators.selected, separatorRow);
  }
  assert.equal(separators.draft.separators.main, " >hjkl ");

  let emojis = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  emojis.openRow = "emojis";
  const select = (id: string) => buildEmojisScreen(emojis.draft, providerContext.descriptors.map(({ id }) => id)).findIndex((row) => row.id === id);
  emojis.selected = select("icons.symbols.project");
  const symbolRow = emojis.selected;
  for (const key of ["h", "j", "k", "l", " "]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.equal(emojis.selected, symbolRow);
  }
  assert.equal(emojis.draft.icons.symbols.project, "hjkl ");

  emojis.selected = select("icons.providers.dynamic-a.value");
  const providerValueRow = emojis.selected;
  for (const key of ["h", "j", "k", "l", " "]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.equal(emojis.selected, providerValueRow);
  }
  assert.deepEqual(emojis.draft.icons.providers["dynamic-a"], { mode: "custom", value: "hjkl " });
});

test("text rows normalize the Space key and reject named command keys", () => {
  let separators = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  separators.openRow = "separators";
  separators.selected = buildSeparatorsScreen(separators.draft).findIndex(({ id }) => id === "separators.main");
  const sepRow = separators.selected;
  const sepBefore = separators.draft.separators.main;
  for (const key of ["Tab", "F1", "Ctrl+ArrowUp", "Ctrl+Down"]) {
    separators = routeSettingsKey(separators, key, providerContext).state;
    assert.equal(separators.draft.separators.main, sepBefore, `${key} must not append as text`);
    assert.equal(separators.selected, sepRow, `${key} must not move selection on a text row`);
  }
  separators = routeSettingsKey(separators, "Space", providerContext).state;
  separators = routeSettingsKey(separators, " ", providerContext).state;
  assert.equal(separators.draft.separators.main, sepBefore + "  ", "both Space key forms append a single space");

  let emojis = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  emojis.openRow = "emojis";
  const ids = providerContext.descriptors.map(({ id }) => id);
  const pick = (id: string) => buildEmojisScreen(emojis.draft, ids).findIndex((row) => row.id === id);
  emojis.selected = pick("icons.symbols.project");
  for (const key of ["Tab", "F1", "Ctrl+ArrowUp"]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.equal(emojis.draft.icons.symbols.project ?? "", "", `${key} must not append as text on a symbol row`);
  }
  emojis = routeSettingsKey(emojis, "Space", providerContext).state;
  emojis = routeSettingsKey(emojis, " ", providerContext).state;
  assert.equal(emojis.draft.icons.symbols.project, "  ", "both Space key forms append a single space on a symbol row");

  emojis.selected = pick("icons.providers.dynamic-a.value");
  for (const key of ["Tab", "Ctrl+ArrowUp"]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.deepEqual(emojis.draft.icons.providers["dynamic-a"] ?? { mode: "default", value: "" }, { mode: "default", value: "" }, `${key} must not append as text on a provider-value row`);
  }
  emojis = routeSettingsKey(emojis, "Space", providerContext).state;
  assert.deepEqual(emojis.draft.icons.providers["dynamic-a"], { mode: "custom", value: " " }, "named Space normalizes to a single space on a provider-value row");

  // a single hostile char that passes the allowlist is still stripped by validation (UI -> validation sanitization)
  emojis.selected = pick("icons.symbols.model");
  emojis = routeSettingsKey(emojis, "\u202e", providerContext).state;
  assert.equal(emojis.draft.icons.symbols.model ?? "", "", "bidi override stripped by validation");
});

test("R26 emojis routes styles, named symbols, and dynamic provider icons through one draft path", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.selected = 2;
  state = routeSettingsKey(state, "Enter", providerContext).state;
  assert.equal(state.openRow, "emojis");
  const initialRows = buildEmojisScreen(state.draft, providerContext.descriptors.map(({ id }) => id));
  const ids = initialRows.map(({ id }) => id);
  for (const symbol of ICON_SYMBOLS) assert.ok(ids.includes(`icons.symbols.${symbol}`));
  for (const providerId of ["dynamic-a", "stored-x"]) {
    assert.ok(ids.includes(`icons.providers.${providerId}.mode`));
    assert.ok(ids.includes(`icons.providers.${providerId}.value`));
  }

  const select = (id: string) => ({
    ...state,
    selected: buildEmojisScreen(state.draft, providerContext.descriptors.map(({ id }) => id)).findIndex((row) => row.id === id),
  });
  state = routeSettingsKey(select("icons.style"), "ArrowLeft", providerContext).state;
  assert.equal(state.draft.icons.style, "custom");
  state = routeSettingsKey(select("icons.symbols.project"), "P", providerContext).state;
  assert.equal(state.draft.icons.symbols.project, "P");
  state = routeSettingsKey(select("icons.providers.dynamic-a.mode"), "Enter", providerContext).state;
  assert.equal(state.draft.icons.providers["dynamic-a"].mode, "custom");
  state = routeSettingsKey(select("icons.providers.dynamic-a.value"), "D", providerContext).state;
  assert.deepEqual(state.draft.icons.providers["dynamic-a"], { mode: "custom", value: "D" });
  state = routeSettingsKey(select("icons.providers.dynamic-a.mode"), "Enter", providerContext).state;
  assert.deepEqual(state.draft.icons.providers["dynamic-a"], { mode: "default", value: "D" });
  state = routeSettingsKey(select("icons.providers.dynamic-a.mode"), "Enter", providerContext).state;
  assert.deepEqual(state.draft.icons.providers["dynamic-a"], { mode: "custom", value: "D" }, "menu must not expose duplicate hidden mode");

  const detail = buildProviderDetail(state.draft, providerContext, "dynamic-a")!;
  assert.deepEqual(detail.providerIcon, state.draft.icons.providers["dynamic-a"]);
  state = routeSettingsKey(select("reset.icons"), "Enter", providerContext).state;
  assert.deepEqual(state.draft.icons, DEFAULT_STATUSLINE_SETTINGS.icons);
});

test("root reset row restores every group to default in the draft without touching the saved original", () => {
  const original = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  original.enabled = false;
  original.bars.width = 7;
  let state = createSettingsUi(original);
  // Dirty the draft across several groups beyond what the saved original already carries.
  state.draft.segments.project = false;
  state.draft.layout.providerRows = "inline";
  state.draft.separators.main = "X";
  state.draft.thresholds.contextWarn = 50;
  state.draft.timing.refreshIntervalMs = 99_000;
  state.draft.icons.style = "ascii";
  state.draft.preview.mode = "narrow";

  state.selected = ROOT_ROWS.length - 1;
  assert.equal(ROOT_ROWS[state.selected].id, "reset");
  state = routeSettingsKey(state, "Enter").state;
  assert.equal(state.draft.enabled, true);
  assert.equal(state.draft.providers.enabled, true);
  assert.equal(state.draft.segments.project, true);
  assert.equal(state.draft.layout.providerRows, "newline");
  assert.equal(state.draft.separators.main, " >");
  assert.equal(state.draft.bars.width, 12);
  assert.equal(state.draft.thresholds.contextWarn, 80);
  assert.equal(state.draft.timing.refreshIntervalMs, 10_000);
  assert.equal(state.draft.icons.style, "emoji");
  assert.equal(state.draft.preview.mode, "current");
  // The reset is a draft mutation: the saved original stays intact, so it stays dirty and reversible.
  assert.equal(state.original.enabled, false);
  assert.equal(state.original.bars.width, 7);
  assert.equal(isDirty(state), true);
  assert.notEqual(state.draft, state.original);
});

test("provider detail reset restores only the currently open provider", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";
  state.selected = 2;
  state = routeSettingsKey(state, "Enter", providerContext).state;
  assert.equal(state.selectedProviderId, "dynamic-a");
  setProviderDisplayMode(state.draft, "dynamic-a", "custom", providerContext.windows!["dynamic-a"]);
  setProviderDisplayMode(state.draft, "stored-x", "custom", []);
  setProviderIcon(state.draft, "dynamic-a", { mode: "custom", value: "D" });
  setProviderIcon(state.draft, "stored-x", { mode: "custom", value: "S" });
  assert.equal(state.draft.providers.records["dynamic-a"].displayMode, "custom");
  assert.deepEqual(state.draft.icons.providers["dynamic-a"], { mode: "custom", value: "D" });

  const lines = renderSettingsUi(state, { width: 79, providers: providerContext });
  const resetLine = lines.findIndex((line) => line.includes("Reset provider to default"));
  assert.ok(resetLine >= 2, "provider detail must show a reset row");
  state.selected = resetLine - 2;
  state = routeSettingsKey(state, "Enter", providerContext).state;

  // dynamic-a is back to defaults (record and icon).
  assert.equal(state.draft.providers.records["dynamic-a"].displayMode, "default");
  assert.equal(state.draft.providers.records["dynamic-a"].enabled, true);
  assert.equal(state.draft.icons.providers["dynamic-a"], undefined);
  // stored-x is untouched: the reset is scoped to the open provider only.
  assert.equal(state.draft.providers.records["stored-x"].displayMode, "custom");
  assert.deepEqual(state.draft.icons.providers["stored-x"], { mode: "custom", value: "S" });
  // Cursor stays on the reset row (now the last detail row for a default provider).
  assert.ok(state.selected >= 0);
});

test("display screen has section resets but no duplicate reset-all action", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "separators";
  const ids = buildSeparatorsScreen(state.draft).map(({ id }) => id);
  assert.equal(ids.includes("reset.all"), false);
  for (const group of ["segments", "extras", "layout", "separators", "bars", "thresholds"]) {
    assert.ok(ids.includes(`reset.${group}`));
  }
});

test("default to custom snapshots every effective provider and window value", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  draft.segments.context = false;
  draft.bars.showPercent = false;
  draft.bars.width = 21;
  draft.providers.defaults = {
    ...draft.providers.defaults,
    missingDataPolicy: "warning",
    refreshIntervalMs: 20_000,
    maxCacheAgeMs: 40_000,
    useCache: false,
    keepAfterFailure: false,
    refreshWhileActive: false,
    refreshDisabledProvider: true,
  };
  setProviderDisplayMode(draft, "dynamic-a", "custom", [{ key: "short", label: "Effective", used: 0.2 }]);
  const record = draft.providers.records["dynamic-a"];
  assert.equal(record.displayMode, "custom");
  assert.equal(record.activeModel.context, "off");
  assert.equal(record.activeModel.project, "on");
  assert.equal(record.missingDataPolicy, "warning");
  assert.deepEqual(record.refresh, {
    refreshIntervalMs: 20_000, maxCacheAgeMs: 40_000, useCache: false,
    keepAfterFailure: false, refreshWhileActive: false, refreshDisabledProvider: true,
  });
  assert.equal(draft.icons.providers["dynamic-a"], undefined);
  assert.deepEqual(record.windows.short, {
    visible: true, label: "Effective", showBar: true, showPercent: false, showReset: true,
    resetFormat: "countdown", showUsed: true, showRemaining: true, showZero: false, width: 21,
  });
});

test("preview reflects draft mutations and updates when the draft changes", () => {
  // Wide render includes the preview section; any mutation to the draft must change it.
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const before = renderSettingsUi(state, { width: 100, previewMode: "local" });
  // The preview renders using state.draft; toggling a visible segment changes the footer output.
  const mutated = replaceDraft(state, { ...state.draft, segments: { ...state.draft.segments, model: false } });
  const after = renderSettingsUi(mutated, { width: 100, previewMode: "local" });
  assert.ok(before.length > 1 && after.length > 1, "preview must be non-empty");
  const previewBefore = before.slice(before.indexOf("") + 1).join("\n");
  const previewAfter = after.slice(after.indexOf("") + 1).join("\n");
  assert.notEqual(previewBefore, previewAfter, "preview must change when the draft changes");
});

test("long-list navigation: End jumps to last row, Home returns to first; selection stays in bounds", () => {
  // Separators screen has many rows (segments + extras + layout + separators + bars + thresholds + timing).
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.selected = 1; // Separators
  state = routeSettingsKey(state, "Enter").state;
  assert.equal(state.openRow, "separators");

  const totalRows = buildSeparatorsScreen(state.draft).length;
  assert.ok(totalRows > 10, "separators screen must be a long list");

  // End key jumps to the last row.
  state = routeSettingsKey(state, "End").state;
  assert.equal(state.selected, totalRows - 1, "End key must select the last row");

  // ArrowDown past the end must stay clamped at the last row.
  state = routeSettingsKey(state, "ArrowDown").state;
  assert.equal(state.selected, totalRows - 1, "ArrowDown at last row must stay clamped");

  // Home key returns to the first row.
  state = routeSettingsKey(state, "Home").state;
  assert.equal(state.selected, 0, "Home key must select the first row");

  // ArrowUp at the first row must stay clamped at zero.
  state = routeSettingsKey(state, "ArrowUp").state;
  assert.equal(state.selected, 0, "ArrowUp at first row must stay clamped");
});

test("renderSettingsWindow draws a bordered window with a per-screen key legend", () => {
  const providers = { descriptors: [], capabilities: {}, order: [], activeProvider: undefined };
  const root = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const lines = renderSettingsWindow(root, { width: 80, providers });

  // Bordered window: top/bottom borders and side rails on every line.
  assert.ok(lines[0]!.startsWith("┌") && lines[0]!.endsWith("┐"), `top border missing: ${lines[0]}`);
  assert.ok(lines.at(-1)!.startsWith("└") && lines.at(-1)!.endsWith("┘"), `bottom border missing: ${lines.at(-1)}`);
  assert.ok(lines.every((line) => line.startsWith("│") || line.startsWith("┌") || line.startsWith("├") || line.startsWith("└")), "every line must carry window chrome");
  // Title and root rows are present inside the box.
  assert.ok(lines.some((line) => line.includes("Statusline")), "window title missing");
  for (const label of ["Statusline & Providers", "Display", "Icons", "Reset all settings to default"]) {
    assert.ok(lines.some((line) => line.includes(label)), `root row ${label} missing`);
  }
  // Root legend mentions open/quit; never the detail-only keys.
  assert.ok(lines.some((line) => line.includes("Enter Open") && line.includes("Esc Quit")), `root legend missing: ${JSON.stringify(lines)}`);
  assert.equal(lines.some((line) => line.includes("Space Toggle")), false, "root legend must not show providers-list keys");
});

test("renderSettingsWindow legend adapts per active screen", () => {
  const providers = { descriptors: [], capabilities: {}, order: [], activeProvider: undefined };
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);

  state = routeSettingsKey(state, "Enter", providers).state; // open Providers list
  let providersLegend = renderSettingsWindow(state, { width: 80, providers }).filter((line) => line.includes("│↑↓"));
  assert.ok(providersLegend.some((line) => line.includes("Space Toggle") && line.includes("Enter Details")), `providers legend missing: ${JSON.stringify(providersLegend)}`);

  state = routeSettingsKey(state, "Escape", providers).state; // back to root
  state = routeSettingsKey(state, "ArrowDown").state;
  state = routeSettingsKey(state, "Enter", providers).state; // open Separators
  const separatorsLegend = renderSettingsWindow(state, { width: 80, providers }).filter((line) => line.includes("│↑↓"));
  assert.ok(separatorsLegend.some((line) => line.includes("←→/Enter Change") && line.includes("Ctrl↑↓ Reorder")), `separators legend missing: ${JSON.stringify(separatorsLegend)}`);
});

test("renderSettingsWindow scrolls to keep the selected row visible when content overflows the viewport", () => {
  const providers = { descriptors: [], capabilities: {}, order: [], activeProvider: undefined };
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  // Open Separators: it has ~50 rows, far more than a tiny viewport.
  state = routeSettingsKey(state, "ArrowDown").state;
  state = routeSettingsKey(state, "Enter", providers).state;

  // Tiny viewport forces scrolling; render returns fewer lines and a scroll indicator.
  const scrolled = renderSettingsWindow(state, { width: 80, providers, viewportRows: 12 });
  assert.ok(scrolled.length <= 12, `scrolled window must respect viewport (got ${scrolled.length})`);
  assert.ok(scrolled.some((line) => /[↑↓]\d+ (above|below)/.test(line)), `scroll indicator missing: ${JSON.stringify(scrolled)}`);
  assert.ok(scrolled.some((line) => line.includes("> ")), "selected row must remain visible while scrolled");

  // Move the cursor far down; the viewport must follow it.
  for (let i = 0; i < 40; i++) state = routeSettingsKey(state, "ArrowDown").state;
  const farDown = renderSettingsWindow(state, { width: 80, providers, viewportRows: 12 });
  assert.ok(farDown.some((line) => line.includes("> ")), "cursor far down must stay visible");
  assert.ok(farDown.some((line) => /↑\d+ above/.test(line)), "scrolled-down view must report hidden rows above");

  // Without a viewport hint, nothing is clipped (back-compat for non-overlay callers/tests).
  const full = renderSettingsWindow(state, { width: 80, providers });
  assert.ok(full.length > scrolled.length, "omitting viewportRows must render the full body");
  assert.equal(full.some((line) => /[↑↓]\d+ (above|below)/.test(line)), false, "no scroll indicator when not overflowing");
});

test("renderSettingsWindow keeps the preview pinned while Display settings scroll", () => {
  const providers = { descriptors: [], capabilities: {}, order: [], activeProvider: undefined };
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state = routeSettingsKey(routeSettingsKey(state, "ArrowDown").state, "Enter", providers).state;

  const atTop = renderSettingsWindow(state, { width: 100, providers, viewportRows: 12 });
  assert.ok(atTop.some((line) => line.includes("Current session preview")), "preview missing at top of Display list");

  state = routeSettingsKey(state, "End").state;
  const atBottom = renderSettingsWindow(state, { width: 100, providers, viewportRows: 12 });
  assert.ok(atBottom.some((line) => line.includes("Current session preview")), "preview must remain pinned after scrolling");
  assert.ok(atBottom.some((line) => line.includes("> ")), "selected setting must remain visible with pinned preview");
});

test("renderSettingsWindow stays within very small terminal bounds", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const lines = renderSettingsWindow(state, { width: 20, viewportRows: 8 });
  assert.ok(lines.length <= 8, `height overflow: ${lines.length}`);
  assert.ok(lines.every((line) => visibleWidth(line) <= 20), `width overflow: ${JSON.stringify(lines)}`);
  for (const width of [1, 2, 3]) {
    const tiny = renderSettingsWindow(state, { width, viewportRows: width });
    assert.ok(tiny.length <= width);
    assert.ok(tiny.every((line) => visibleWidth(line) <= width));
  }
});
