import { renderBar, DEFAULT_STOPS, type BarStyle, type ColorStops } from "./bar.ts";
import { composeSegments, createSegments, SEGMENT_ORDER } from "./segments.ts";
import {
  billingMode,
  deriveContext,
  deriveEffort,
  deriveModel,
  deriveProject,
  isLocalEndpoint,
  type ContextUsage,
} from "./derive.ts";
import { formatRate, formatResetCountdown, formatTime, formatWindow } from "./format.ts";
import { gitBranchSymbol, gitStatusTokens, type GitStatusState, type GitTokenKind } from "./git.ts";
import { estimateTokens, type ThroughputLevel } from "./throughput.ts";
import type { RateLimitWindow } from "./ratelimit.ts";
import type { ResetFormat, StatuslineSettings } from "./settings/schema.ts";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Match Pi's single-line status normalization while preserving extension-provided ANSI styling. */
function normalizeExtensionStatus(status: string): string {
  return status.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Single source of truth for the statusline's main line. Both the live footer
 * (extensions/statusline.ts) and the settings preview (settings/resolve.ts) render
 * through `renderMainLine`, so the preview can never drift from the real footer —
 * only the data (live vs fixture) and the theme (real vs none) differ.
 */

export interface RenderTheme {
  fg: (color: ThemeColor, text: string) => string;
  getColorMode?: () => string;
  getFgAnsi?: (color: ThemeColor) => string;
}

export interface MeterSnapshot {
  avgInputRate?: number;
  avgOutputRate?: number;
  outputRate?: number;
  outputLevel?: ThroughputLevel;
  inputLevel?: ThroughputLevel;
  waitingMs?: number;
  activeMs?: number;
  elapsedMs?: number;
  lastTurnMs?: number;
}

export interface ExtensionStatus {
  /** Stable key passed to ctx.ui.setStatus(). */
  key: string;
  /** Publisher-provided display value, which may contain ANSI styling. */
  value: string;
}

export interface FooterSnapshot {
  cwd: string;
  model?: { id: string; provider?: string; reasoning?: boolean; baseUrl?: string };
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  /** Branch name to show; only meaningful when extras.branch is on. */
  gitBranch?: string | null;
  gitStatus?: GitStatusState;
  pending?: boolean;
  /** True for subscription-billed providers (codex or oauth). */
  subscription?: boolean;
  turnActive?: boolean;
  meter?: MeterSnapshot;
  /** Last context char count, used to estimate the local prompt-processing rate. */
  lastContextChars?: number;
  /** Session token/cost totals, used for the cost extra and the API ledger. */
  totals?: { input: number; output: number; cost: number };
  /** Active provider's subscription quota windows (shown on the main line when no provider row does). */
  sessionWindows?: RateLimitWindow[];
  /** True when the active provider already shows its quota on a provider-tracking row. */
  activeProviderHasRow?: boolean;
  /** Placeholder shown for an eligible subscription provider before its windows load (e.g. "5h — wk —"). */
  sessionPlaceholder?: string;
  /** Generic statuses published by Pi extensions, in FooterData map order. */
  extensionStatuses?: readonly ExtensionStatus[];
  now?: number;
}

const GIT_ROLES: Record<GitTokenKind, "accent" | "success" | "warning" | "error"> = {
  ahead: "accent",
  behind: "warning",
  dirty: "warning",
  clean: "success",
  error: "error",
};

const ICON_PRESETS: Record<StatuslineSettings["icons"]["style"], Record<string, string>> = {
  emoji: { project: "📁", model: "🤖", thinking: "🧠", context: "🪟", throughput: "⚡", time: "⏳", mcp: "🔌", fast: "⚡" },
  unicode: { project: "◆", model: "◇", thinking: "◌", context: "▣", throughput: "↕", time: "◷" },
  ascii: { project: "P", model: "M", thinking: "T", context: "C", throughput: "R", time: "@" },
  nerdfont: { project: "󰉋", model: "󰧑", thinking: "󰔟", context: "󰍛", throughput: "󰓅", time: "󰥔", fast: "⚡" },
  minimal: { project: "·", model: "·", thinking: "·", context: "·", throughput: "·", time: "·" },
  none: {},
  custom: {},
};

function icon(settings: StatuslineSettings, name: string): string {
  const override = settings.icons.symbols[name];
  if (override !== undefined) return override;
  return ICON_PRESETS[settings.icons.style][name] ?? "";
}

/** Provider icon: only when explicitly configured (no default glyph), matching the live footer. */
function providerIcon(settings: StatuslineSettings, providerId?: string): string {
  if (!providerId) return "";
  const configured = settings.icons.providers[providerId];
  if (configured?.mode === "hidden") return "";
  if (configured?.mode === "custom") return configured.value;
  return "";
}

function barRole(settings: StatuslineSettings, used: number): ThemeColor {
  if (used * 100 >= settings.bars.critAt) return "error";
  if (used * 100 >= settings.bars.warnAt) return "warning";
  return "success";
}

function barStyleFactory(settings: StatuslineSettings, used: number, theme: RenderTheme | undefined, stops: ColorStops): BarStyle {
  if (settings.bars.truecolor && theme?.getColorMode?.() === "truecolor") {
    return {
      fill: (text, rgb) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`,
      track: (text) => `\x1b[38;2;58;63;70m${text}\x1b[39m`,
    };
  }
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  return {
    fill: (text) => paint(barRole(settings, used), text),
    track: (text) => paint("dim", text),
  };
}

function blockBar(used: number, settings: StatuslineSettings, theme: RenderTheme | undefined, width: number, showPercent: boolean): string {
  const w = Math.max(2, Math.floor(Number.isFinite(width) ? width : 12));
  const filled = Math.round(used * w);
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const bar = paint(barRole(settings, used), `${settings.bars.capLeft || "["}${(settings.bars.fill || "█").repeat(filled)}${(settings.bars.empty || "░").repeat(w - filled)}${settings.bars.capRight || "]"}`);
  return showPercent ? `${bar} ${Math.round(used * 100)}%` : bar;
}

function isLineBarStyle(style: string): boolean {
  return style === "rounded" || style === "line";
}

/** Resolved per-window display: per-provider `WindowConfiguration` overriding the global bar defaults. */
export interface ResolvedWindowDisplay {
  visible: boolean;
  label: string;
  showBar: boolean;
  showPercent: boolean;
  showReset: boolean;
  resetFormat: ResetFormat;
  width: number;
}

/** Resolve a quota window's effective display settings (per-window config wins over global bars). */
export function resolveWindowDisplay(
  settings: StatuslineSettings,
  provider: string | undefined,
  window: RateLimitWindow,
): ResolvedWindowDisplay {
  const cfg = provider ? settings.providers.records[provider]?.windows[window.key ?? ""] : undefined;
  const width = cfg?.width && cfg.width > 0 ? cfg.width : settings.bars.width;
  return {
    visible: cfg?.visible ?? true,
    label: cfg?.label ? cfg.label : window.label,
    showBar: cfg?.showBar ?? true,
    showPercent: cfg?.showPercent ?? settings.bars.showPercent,
    showReset: cfg?.showReset ?? true,
    resetFormat: cfg?.resetFormat ?? "countdown",
    width,
  };
}

/** Format a reset timestamp according to the configured reset format. */
function formatReset(resetAt: number, format: ResetFormat, now: number): string {
  if (format === "exact-time" || format === "exact-date") {
    const d = new Date(resetAt);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return format === "exact-time" ? `${hh}:${mm}` : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
  }
  return formatResetCountdown(resetAt, now);
}

function renderSessionBar(settings: StatuslineSettings, provider: string | undefined, window: RateLimitWindow, theme: RenderTheme | undefined, now: number): string {
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const display = resolveWindowDisplay(settings, provider, window);
  const used = Math.max(0, Math.min(1, window.used));
  const bar = !display.showBar ? ""
    : isLineBarStyle(settings.bars.style)
      ? renderBar(used, display.width, barStyleFactory(settings, used, theme, DEFAULT_STOPS), DEFAULT_STOPS, display.showPercent)
      : blockBar(used, settings, theme, display.width, display.showPercent);
  const reset = display.showReset && window.resetAt !== undefined ? paint("dim", ` ↻ ${formatReset(window.resetAt, display.resetFormat, now)}`) : "";
  return `${paint("muted", `${display.label} `)}${bar}${reset}`;
}

/** One provider's data for a tracking row (caller pre-filters order/enabled/health). */
export interface ProviderRowSource {
  provider: string;
  windows: readonly RateLimitWindow[];
  /** Static affordance shown before a subscription provider's windows load (e.g. "5h — wk —"). */
  placeholder?: string;
}

/** True when a source would produce a row: at least one visible window, or a placeholder. */
export function sourceRenders(settings: StatuslineSettings, source: ProviderRowSource): boolean {
  if (source.windows.some((window) => resolveWindowDisplay(settings, source.provider, window).visible)) return true;
  return Boolean(source.placeholder);
}

/** True when `provider` would show a tracking row (visible windows or placeholder), so the main line hides its quota. */
export function providerHasRow(
  settings: StatuslineSettings,
  sources: readonly ProviderRowSource[],
  provider: string | undefined,
): boolean {
  if (!settings.providers.enabled || !provider) return false;
  return sources.some((source) => source.provider === provider && sourceRenders(settings, source));
}

/**
 * Render the provider-tracking rows through the same per-window logic as the main-line session
 * segment, so the multi-line footer and the settings preview can never drift. Pure: no I/O.
 */
export function renderProviderRows(
  settings: StatuslineSettings,
  sources: readonly ProviderRowSource[],
  theme: RenderTheme | undefined,
  now: number,
): string[] {
  if (!settings.providers.enabled) return [];
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const sep = paint("dim", " >");
  const lines: string[] = [];
  for (const source of sources) {
    if (settings.providers.records[source.provider]?.enabled === false) continue;
    const rendered = source.windows
      .filter((window) => resolveWindowDisplay(settings, source.provider, window).visible)
      .map((window) => renderSessionBar(settings, source.provider, window, theme, now))
      .filter((bar) => bar.trim().length > 0)
      .join(sep);
    if (rendered) lines.push(`${paint("muted", `${source.provider} `)}${rendered}`);
    else if (source.placeholder) lines.push(paint("muted", `${source.provider} ${source.placeholder}`));
  }
  return lines;
}

/** Render the single main statusline line. Pure: no I/O, no mutation. */
export function renderMainLine(
  settings: StatuslineSettings,
  snap: FooterSnapshot,
  width: number,
  theme?: RenderTheme,
): string {
  const paint = (role: ThemeColor, text: string) => (theme?.fg ? theme.fg(role, text) : text);
  const now = snap.now ?? Date.now();
  const extras = settings.extras;

  const context = deriveContext(snap.contextUsage);
  const contextRole = (ctx: { percent: number; tokens: number | null }): ThemeColor => {
    const tokens = ctx.tokens ?? 0;
    if (ctx.percent >= settings.thresholds.contextCrit || tokens >= 170_000) return "error";
    if (ctx.percent >= settings.thresholds.contextWarn || tokens >= 120_000) return "warning";
    return "success";
  };
  const branch = extras.branch ? snap.gitBranch : undefined;
  const branchSymbol = gitBranchSymbol(settings.icons.style === "nerdfont");
  const git = branch
    ? [
      paint("accent", `${branchSymbol ? `${branchSymbol} ` : ""}${branch}`),
      ...(snap.gitStatus ? gitStatusTokens(snap.gitStatus).map((token) => paint(GIT_ROLES[token.kind], token.text)) : []),
    ].join(" ")
    : "";
  const pending = extras.pending && snap.pending;
  const model = deriveModel(snap.model);
  const effort = deriveEffort(snap.thinkingLevel ?? "off", snap.model);
  const localModel = isLocalEndpoint(snap.model?.baseUrl);
  const mode = billingMode(localModel, snap.subscription ?? false);
  const needTotals = extras.cost || (mode === "api" && !snap.turnActive);
  const totals = needTotals ? snap.totals : undefined;
  const cost = extras.cost ? totals?.cost : undefined;

  const m = snap.meter ?? {};
  const liveOutputRate = snap.turnActive && m.outputRate !== undefined ? m.outputRate : undefined;
  const outputRateLabel = () => paint(m.outputLevel ?? "muted", `↓${formatRate(liveOutputRate ?? m.avgOutputRate ?? 0)}`);
  const throughputIcon = icon(settings, "throughput");
  // The ⚡ segment adapts to the billing model (see README "Throughput and time").
  const throughput = (() => {
    if (mode === "local") {
      const promptRate = m.waitingMs ? estimateTokens(snap.lastContextChars ?? 0) / (m.waitingMs / 1_000) : undefined;
      const inputRate = promptRate ?? m.avgInputRate ?? 0;
      const input = paint(m.inputLevel ?? "muted", `↑${formatRate(inputRate)}`);
      return `${paint("muted", throughputIcon)}${input} ${outputRateLabel()}${paint("muted", " t/s")}`;
    }
    if (snap.turnActive) return `${paint("muted", throughputIcon)}${outputRateLabel()}${paint("muted", " t/s")}`;
    if (mode === "subscription") return "";
    if (!totals || (!totals.input && !totals.output)) return "";
    return paint("muted", `🧾 ↑${formatWindow(totals.input)} ↓${formatWindow(totals.output)} $${totals.cost.toFixed(3)}`);
  })();

  const activeMs = m.activeMs ?? 0;
  const time = activeMs > 0 || m.lastTurnMs !== undefined
    ? formatTime(activeMs, extras.sessionElapsed ? m.elapsedMs : undefined, extras.lastTurn ? m.lastTurnMs : undefined)
    : "";

  const sessionWindows = snap.activeProviderHasRow ? [] : (snap.sessionWindows ?? []);
  const sessionProvider = snap.model?.provider;
  const session = sessionWindows.length
    ? sessionWindows
      .filter((window) => resolveWindowDisplay(settings, sessionProvider, window).visible)
      .map((window) => renderSessionBar(settings, sessionProvider, window, theme, now))
      .join(paint("dim", " >"))
    : (snap.sessionPlaceholder ?? "");

  const withSpace = (name: string, value: string) => {
    const glyph = icon(settings, name);
    return glyph ? `${glyph} ${value}` : value;
  };

  const normalizedExtensionStatuses = (snap.extensionStatuses ?? [])
    .map(({ key, value }) => ({ key, value: normalizeExtensionStatus(value) }))
    .filter(({ value }) => value.length > 0);
  const rightAlignedStatusKeys = settings.layout.rightAlignedExtensionStatuses ?? [];
  const rightAlignedKeys = new Set(rightAlignedStatusKeys);
  const extensionStatuses = normalizedExtensionStatuses
    .filter(({ key }) => !rightAlignedKeys.has(key))
    .map(({ key, value }) => key === "fast" ? withSpace(key, paint("warning", value)) : value)
    .join(" ");
  const statusesByKey = new Map(normalizedExtensionStatuses.map(({ key, value }) => [key, value]));

  const visibility = { ...settings.segments };
  const activeModel = snap.model?.provider ? settings.providers.records[snap.model.provider]?.activeModel : undefined;
  if (activeModel) {
    for (const id of SEGMENT_ORDER) {
      if (activeModel[id] === "on") visibility[id] = true;
      else if (activeModel[id] === "off") visibility[id] = false;
    }
  }
  const rightExtensionStatuses = visibility.extensions
    ? rightAlignedStatusKeys
      .map((key) => {
        const value = statusesByKey.get(key);
        if (value === undefined) return undefined;
        return withSpace(key, key === "fast" ? paint("warning", value) : value);
      })
      .filter((value): value is string => value !== undefined)
      .join(" ")
    : "";
  const orderRank = new Map(settings.layout.segmentOrder.map((id, index) => [id, index] as const));
  const segments = createSegments(visibility, {
    project: () => {
      const head = paint("muted", withSpace("project", deriveProject(snap.cwd)));
      const tail = `${git ? `${paint("dim", settings.separators.projectGit)}${git}` : ""}${pending ? ` ${paint("muted", "queued")}` : ""}`;
      return `${head}${tail}`;
    },
    model: () => {
      if (!model) return "";
      const provider = providerIcon(settings, snap.model?.provider);
      const label = provider ? `${provider}${model}` : model;
      return paint("muted", `${withSpace("model", label)}${cost === undefined ? "" : ` $${cost.toFixed(3)}`}`);
    },
    effort: () => effort ? paint("muted", withSpace("thinking", effort)) : "",
    // Status values can carry extension-provided ANSI styling; preserve them verbatim.
    extensions: () => extensionStatuses,
    context: () => {
      if (!context) return "";
      const glyph = icon(settings, "context");
      const head = paint("muted", glyph ? `${glyph} ` : "");
      return `${head}${paint(contextRole(context), context.label)}`;
    },
    session: () => session,
    throughput: () => throughput,
    // formatTime already carries its own ⏳ glyph; no icon prefix.
    time: () => time ? paint("muted", time) : "",
  }).sort((a, b) => (orderRank.get(a.id) ?? SEGMENT_ORDER.length) - (orderRank.get(b.id) ?? SEGMENT_ORDER.length));
  const inner = Math.max(0, width - Math.min(settings.separators.trailingSpacing, Math.max(0, width)));
  const separator = `${settings.separators.padding}${" ".repeat(settings.separators.spacingBefore)}${settings.separators.main}${" ".repeat(settings.separators.spacingAfter)}`;
  const paintedSeparator = paint("dim", separator);
  const line = composeSegments(segments, inner, paintedSeparator, settings.layout.narrowPriority);
  const fullLeft = rightExtensionStatuses
    ? composeSegments(segments, Number.MAX_SAFE_INTEGER, paintedSeparator, settings.layout.narrowPriority)
    : line;
  const leftWidth = visibleWidth(line);
  const rightWidth = visibleWidth(rightExtensionStatuses);
  const minimumGap = line ? 1 : 0;
  const canAlignRight = rightExtensionStatuses.length > 0
    && visibleWidth(fullLeft) <= inner
    && leftWidth + minimumGap + rightWidth <= inner;
  const aligned = canAlignRight
    ? `${line}${" ".repeat(inner - leftWidth - rightWidth)}${rightExtensionStatuses}`
    : line;
  const trailing = Math.min(settings.separators.trailingSpacing, Math.max(0, width));
  return aligned + " ".repeat(trailing);
}
