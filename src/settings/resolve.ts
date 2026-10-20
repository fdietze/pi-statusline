import { SEGMENT_ORDER, type SegmentId } from "../segments.ts";
import { type ContextUsage } from "../derive.ts";
import type { StatuslineSettings, ActiveModelToggle } from "./schema.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";
import type { RateLimitWindow } from "../ratelimit.ts";
import type { GitStatusState } from "../git.ts";
import { renderMainLine, type ExtensionStatus, type RenderTheme } from "../render.ts";

/**
 * Resolution helpers for the settings UI/tests. The actual line rendering lives in
 * ../render.ts (`renderMainLine`) and is shared with the live footer, so the preview
 * and the footer can never drift — only the data (live vs fixture) differs.
 */

/** Immutable runtime inputs the renderer reads (footer uses live state, preview uses a fixture). */
export interface RuntimeSnapshot {
  cwd?: string;
  sessionName?: string;
  hostname?: string;
  model?: { id: string; provider?: string; reasoning?: boolean; baseUrl?: string };
  /** Active provider id, used to resolve per-provider activeModel tri-state overrides. */
  activeProvider?: string;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  /** Generic extension statuses in stable FooterData map order. */
  extensionStatuses?: readonly ExtensionStatus[];
  throughput?: { inputRate?: number; outputRate?: number };
  /** Active subscription quota windows, when the active provider reports them. */
  sessionWindows?: RateLimitWindow[];
  activeMs?: number;
  elapsedMs?: number;
  lastTurnMs?: number;
  pending?: boolean;
  /** Session token/cost totals, used for the API ledger preview. */
  totals?: { input: number; output: number; cost: number };
  now?: number;
  // Live-only fields (the "current" preview forwards these so it matches the footer exactly).
  gitBranch?: string | null;
  gitStatus?: GitStatusState;
  turnActive?: boolean;
  subscription?: boolean;
  lastContextChars?: number;
  activeProviderHasRow?: boolean;
  sessionPlaceholder?: string;
}

export interface ResolutionContext {
  capability?: ProviderCapability;
  runtime: RuntimeSnapshot;
}

function isApplicable(id: SegmentId, ctx: ResolutionContext): boolean {
  const { runtime, capability } = ctx;
  switch (id) {
    case "effort":
      // Non-reasoning models have no effort level to show.
      return runtime.model?.reasoning === true;
    case "extensions":
      return Boolean(runtime.extensionStatuses?.some(({ value }) => value.length > 0));
    case "context":
      // Hide when no context usage (or right after compaction, where percent is null).
      return Boolean(runtime.contextUsage && runtime.contextUsage.percent !== null);
    case "session":
      // Session quota only for providers whose adapter reports windows.
      return Boolean(capability && capability.quotaSupport !== "none" && runtime.sessionWindows?.length);
    case "throughput": {
      // Throughput needs at least one measured rate.
      const t = runtime.throughput;
      return Boolean(t && (t.inputRate !== undefined || t.outputRate !== undefined));
    }
    default:
      return true;
  }
}

/**
 * Resolve per-segment visibility (R8): global enable ANDed with the active provider's
 * tri-state activeModel override ('on'/'off' win; 'default' inherits global), then
 * applicability self-hide (an inapplicable segment is never shown, even if forced 'on').
 */
export function resolveSegmentVisibility(
  settings: StatuslineSettings,
  ctx: ResolutionContext,
): Record<SegmentId, boolean> {
  const activeRec = ctx.runtime.activeProvider
    ? settings.providers.records[ctx.runtime.activeProvider]
    : undefined;
  const overrides = activeRec?.activeModel ?? ({} as Partial<Record<SegmentId, ActiveModelToggle>>);

  const result = {} as Record<SegmentId, boolean>;
  for (const id of SEGMENT_ORDER) {
    let enabled = settings.segments[id] !== false;
    const override = overrides[id];
    if (override === "on") enabled = true;
    else if (override === "off") enabled = false;
    // Applicability can only hide, never force-show.
    if (!isApplicable(id, ctx)) enabled = false;
    result[id] = enabled;
  }
  return result;
}

/** Resolve and validate segment order / narrow priority against the known segment set. */
export function resolveOrder(settings: StatuslineSettings): {
  segmentOrder: SegmentId[];
  narrowPriority: SegmentId[];
} {
  const valid = new Set<string>(SEGMENT_ORDER);
  const order = settings.layout.segmentOrder.filter((id) => valid.has(id));
  const narrow = settings.layout.narrowPriority.filter((id) => valid.has(id));
  return {
    segmentOrder: order.length ? order : ([...SEGMENT_ORDER] as SegmentId[]),
    narrowPriority: narrow.length ? narrow : ([...settings.layout.narrowPriority] as SegmentId[]),
  };
}

/** Resolved bar configuration derived (and bounded) from settings.bars. */
export interface ResolvedBar {
  width: number;
  fill: string;
  empty: string;
  capLeft: string;
  capRight: string;
  showPercent: boolean;
  style: StatuslineSettings["bars"]["style"];
}

/** Resolve and bound the bar config from settings (width clamped >= 2, chars defaulted). */
export function resolveBarConfig(settings: StatuslineSettings): ResolvedBar {
  const bars = settings.bars;
  return {
    width: Math.max(2, Math.floor(Number.isFinite(bars.width) ? bars.width : 12)),
    fill: bars.fill || "█",
    empty: bars.empty || "░",
    capLeft: bars.capLeft || "╟",
    capRight: bars.capRight || "╢",
    showPercent: bars.showPercent,
    style: bars.style,
  };
}

/**
 * Compose the single main statusline line through the SAME renderer as the live footer
 * (../render.ts renderMainLine), so preview and footer cannot drift. Pure: no I/O. The
 * optional theme lets the in-app preview render with the live terminal colors.
 */
export function composeFooterLine(
  settings: StatuslineSettings,
  ctx: ResolutionContext,
  width: number,
  theme?: RenderTheme,
): string {
  const { runtime, capability } = ctx;
  return renderMainLine(settings, {
    cwd: runtime.cwd ?? "",
    sessionName: runtime.sessionName,
    hostname: runtime.hostname,
    model: runtime.model
      ? { id: runtime.model.id, provider: runtime.model.provider, reasoning: runtime.model.reasoning, baseUrl: runtime.model.baseUrl }
      : undefined,
    thinkingLevel: runtime.thinkingLevel,
    contextUsage: runtime.contextUsage,
    extensionStatuses: runtime.extensionStatuses,
    pending: runtime.pending,
    // billingMode(isLocalEndpoint(baseUrl), subscription): local endpoints win regardless. Fall
    // back to the capability-derived billing for fixture modes that don't pass it explicitly.
    subscription: runtime.subscription ?? (capability?.billing === "subscription"),
    turnActive: runtime.turnActive ?? false,
    meter: {
      avgInputRate: runtime.throughput?.inputRate,
      avgOutputRate: runtime.throughput?.outputRate,
      activeMs: runtime.activeMs,
      elapsedMs: runtime.elapsedMs,
      lastTurnMs: runtime.lastTurnMs,
    },
    totals: runtime.totals,
    sessionWindows: runtime.sessionWindows,
    activeProviderHasRow: runtime.activeProviderHasRow ?? false,
    sessionPlaceholder: runtime.sessionPlaceholder ?? "",
    gitBranch: runtime.gitBranch,
    gitStatus: runtime.gitStatus,
    lastContextChars: runtime.lastContextChars,
    now: runtime.now,
  }, width, theme);
}
