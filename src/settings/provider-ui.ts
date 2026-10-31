import { createProviderConfig, createWindowConfig } from "./defaults.ts";
import {
  resolveProviderMissingDataPolicy,
  resolveProviderRefreshPolicy,
  resolveRefreshEligibility,
  type RefreshHealth,
  type RefreshPolicy,
} from "./refresh.ts";
import type {
  ActiveModelToggle,
  MissingDataPolicy,
  ProviderConfiguration,
  ProviderRefreshOverrides,
  SegmentId,
  StatuslineSettings,
  WindowConfiguration,
} from "./schema.ts";
import type { RateLimitWindow } from "../ratelimit.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";
import type { ProviderDescriptor } from "./providers/discovery.ts";

export interface ProviderRowView {
  id: string;
  label: string;
  enabled: boolean;
  availability: "Available" | "Not available";
  authentication: "Authenticated" | "Not authenticated";
  billing: string;
  reliability: string;
  freshness: "Fresh" | "Stale" | "Unknown";
  quota: string;
  active: boolean;
}

export interface ProviderDetailView {
  row: ProviderRowView;
  displayMode: ProviderConfiguration["displayMode"];
  activeModel: ProviderConfiguration["activeModel"];
  providerIcon: StatuslineSettings["icons"]["providers"][string];
  missingDataPolicy: MissingDataPolicy;
  refresh: RefreshPolicy;
  refreshNowEligible: boolean;
  quotaAvailable: boolean;
  quotaWindows: Array<RateLimitWindow & { settings: WindowConfiguration }>;
}

export interface ProviderScreenView {
  statuslineEnabled: boolean;
  providerTrackingEnabled: boolean;
  rows: ProviderRowView[];
}

export interface ProviderUiContext {
  descriptors: readonly ProviderDescriptor[];
  capabilities: Readonly<Record<string, ProviderCapability>>;
  health?: Readonly<Record<string, RefreshHealth>>;
  windows?: Readonly<Record<string, readonly RateLimitWindow[]>>;
  activeProvider?: string;
}

export type ProviderUiEffect = { type: "refresh-provider"; providerId: string };

const TOGGLE_ORDER: readonly ActiveModelToggle[] = ["default", "on", "off"];

function safeText(value: string | undefined, fallback: string): string {
  const clean = (value ?? "")
    .replace(/\x1b\[[0-9;]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gi, "")
    .trim();
  return clean || fallback;
}

function ensureRecord(draft: StatuslineSettings, providerId: string): ProviderConfiguration {
  return draft.providers.records[providerId] ??= createProviderConfig();
}

export function buildProviderScreen(draft: StatuslineSettings, context: ProviderUiContext): ProviderScreenView {
  const savedIndex = new Map(draft.providers.order.map((id, index) => [id, index]));
  const descriptors = context.descriptors
    .map((descriptor, index) => ({ descriptor, index }))
    .sort((a, b) => (savedIndex.get(a.descriptor.id) ?? Number.MAX_SAFE_INTEGER)
      - (savedIndex.get(b.descriptor.id) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ descriptor }) => descriptor);
  return {
    statuslineEnabled: draft.enabled,
    providerTrackingEnabled: draft.providers.enabled,
    rows: descriptors.map((descriptor) => {
      const capability = context.capabilities[descriptor.id];
      const record = draft.providers.records[descriptor.id];
      const state = context.health?.[descriptor.id]?.state ?? "unknown";
      const unavailable = capability?.unavailableReason;
      return {
        id: descriptor.id,
        label: safeText(descriptor.displayName, descriptor.id),
        enabled: record?.enabled ?? true,
        availability: capability?.available ? "Available" : "Not available",
        authentication: capability?.authenticated ? "Authenticated" : "Not authenticated",
        billing: capability?.billing ?? "unknown",
        reliability: capability?.quotaReliability ?? "none",
        freshness: state === "fresh" ? "Fresh" : state === "stale" ? "Stale" : "Unknown",
        quota: capability?.quotaSupport === "none"
          ? `Not available: ${safeText(unavailable, "usage unavailable")}`
          : capability ? "Available" : "Not available: usage unavailable",
        active: context.activeProvider === descriptor.id,
      };
    }),
  };
}

export function buildProviderDetail(
  draft: StatuslineSettings,
  context: ProviderUiContext,
  providerId: string,
): ProviderDetailView | undefined {
  const row = buildProviderScreen(draft, context).rows.find((entry) => entry.id === providerId);
  const capability = context.capabilities[providerId];
  if (!row || !capability) return undefined;
  const record = draft.providers.records[providerId];
  const adapterWindows = context.windows?.[providerId] ?? [];
  const keys = adapterWindows.map((window) => window.key?.trim() ?? "");
  const validWindows = keys.every(Boolean) && new Set(keys).size === keys.length;
  const quotaWindows = capability.quotaSupport === "none" || !validWindows ? [] : adapterWindows.map((window) => {
    const settings = record?.windows[window.key!] ?? createWindowConfig();
    return { ...window, settings: structuredClone(settings) };
  });
  const effectiveRecord = record ?? createProviderConfig();
  return {
    row,
    displayMode: effectiveRecord.displayMode,
    activeModel: structuredClone(effectiveRecord.activeModel),
    providerIcon: structuredClone(draft.icons.providers[providerId] ?? { mode: "default", value: "" }),
    missingDataPolicy: resolveProviderMissingDataPolicy(draft, providerId),
    refresh: resolveProviderRefreshPolicy(draft, providerId, capability),
    refreshNowEligible: resolveRefreshEligibility(draft, providerId, capability, {
      providerEnabled: row.enabled,
      isActive: row.active,
    }),
    quotaAvailable: capability.quotaSupport !== "none",
    quotaWindows,
  };
}

export function toggleStatusline(draft: StatuslineSettings): StatuslineSettings {
  draft.enabled = !draft.enabled;
  return draft;
}

export function toggleProviderTracking(draft: StatuslineSettings): StatuslineSettings {
  draft.providers.enabled = !draft.providers.enabled;
  return draft;
}

export function toggleProvider(draft: StatuslineSettings, providerId: string): StatuslineSettings {
  const record = ensureRecord(draft, providerId);
  record.enabled = !record.enabled;
  if (!draft.providers.order.includes(providerId)) draft.providers.order.push(providerId);
  return draft;
}

export function moveProvider(
  draft: StatuslineSettings,
  providerId: string,
  direction: "up" | "down",
): StatuslineSettings {
  const index = draft.providers.order.indexOf(providerId);
  const next = index + (direction === "up" ? -1 : 1);
  if (index >= 0 && next >= 0 && next < draft.providers.order.length) {
    [draft.providers.order[index], draft.providers.order[next]] = [draft.providers.order[next], draft.providers.order[index]];
  }
  return draft;
}

export function setProviderDisplayMode(
  draft: StatuslineSettings,
  providerId: string,
  mode: "default" | "custom",
  windows: readonly RateLimitWindow[] = [],
): StatuslineSettings {
  const existing = draft.providers.records[providerId];
  if (mode === "custom" && (existing?.displayMode ?? "default") === "default") {
    const keys = windows.map((window) => typeof window.key === "string" ? window.key.trim() : "");
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return draft;

    const record = ensureRecord(draft, providerId);
    for (const segment of Object.keys(draft.segments) as SegmentId[]) {
      if (record.activeModel[segment] === "default") {
        record.activeModel[segment] = draft.segments[segment] ? "on" : "off";
      }
    }
    record.missingDataPolicy ??= resolveProviderMissingDataPolicy(draft, providerId);
    const refresh = resolveProviderRefreshPolicy(draft, providerId);
    record.refresh = {
      refreshIntervalMs: refresh.intervalMs,
      maxCacheAgeMs: refresh.maxAgeMs,
      useCache: refresh.useCache,
      keepAfterFailure: refresh.keepAfterFailure,
      refreshWhileActive: refresh.refreshWhileActive,
      refreshDisabledProvider: refresh.refreshDisabledProvider,
    };
    for (const window of windows) {
      record.windows[window.key!] ??= {
        ...createWindowConfig(),
        label: window.label,
        showPercent: draft.bars.showPercent,
        width: draft.bars.width,
      };
    }
  }
  ensureRecord(draft, providerId).displayMode = mode;
  return draft;
}

export function cycleActiveModelOverride(
  draft: StatuslineSettings,
  providerId: string,
  segment: SegmentId,
): StatuslineSettings {
  const record = ensureRecord(draft, providerId);
  const current = record.activeModel[segment] ?? "default";
  record.activeModel[segment] = TOGGLE_ORDER[(TOGGLE_ORDER.indexOf(current) + 1) % TOGGLE_ORDER.length];
  return draft;
}

/** Provider icons use the canonical icons.providers draft path. */
export function setProviderIcon(
  draft: StatuslineSettings,
  providerId: string,
  icon: StatuslineSettings["icons"]["providers"][string],
): StatuslineSettings {
  draft.icons.providers[providerId] = { ...icon };
  return draft;
}

export interface WindowReconcileResult {
  ok: boolean;
  draft: StatuslineSettings;
  error?: "invalid-window-key" | "duplicate-window-key";
}

/** Validate the whole adapter result before touching the draft, then merge solely by stable key. */
export function reconcileProviderWindows(
  draft: StatuslineSettings,
  providerId: string,
  windows: readonly RateLimitWindow[],
): WindowReconcileResult {
  const keys = windows.map((window) => typeof window.key === "string" ? window.key.trim() : "");
  if (keys.some((key) => !key)) return { ok: false, draft, error: "invalid-window-key" };
  if (new Set(keys).size !== keys.length) return { ok: false, draft, error: "duplicate-window-key" };
  const record = ensureRecord(draft, providerId);
  for (const key of keys) record.windows[key] ??= createWindowConfig();
  return { ok: true, draft };
}

export function updateProviderWindow(
  draft: StatuslineSettings,
  providerId: string,
  key: string,
  changes: Partial<WindowConfiguration>,
): boolean {
  const cleanKey = key.trim();
  if (!cleanKey) return false;
  const record = ensureRecord(draft, providerId);
  const current = record.windows[cleanKey] ?? createWindowConfig();
  const width = changes.width === undefined ? current.width : Math.max(1, Math.min(200, Math.floor(changes.width) || 1));
  record.windows[cleanKey] = { ...current, ...changes, width };
  return true;
}

export function setProviderMissingDataPolicy(
  draft: StatuslineSettings,
  providerId: string,
  policy: MissingDataPolicy | undefined,
): StatuslineSettings {
  const record = ensureRecord(draft, providerId);
  if (policy === undefined) delete record.missingDataPolicy;
  else record.missingDataPolicy = policy;
  return draft;
}

export function setProviderRefreshOverrides(
  draft: StatuslineSettings,
  providerId: string,
  overrides: ProviderRefreshOverrides | undefined,
): StatuslineSettings {
  const record = ensureRecord(draft, providerId);
  if (overrides === undefined) {
    delete record.refresh;
    return draft;
  }
  const refresh: ProviderRefreshOverrides = { ...overrides };
  if (refresh.refreshIntervalMs !== undefined) {
    if (Number.isFinite(refresh.refreshIntervalMs)) {
      refresh.refreshIntervalMs = Math.min(86_400_000, Math.max(10_000, Math.floor(refresh.refreshIntervalMs)));
    } else {
      delete refresh.refreshIntervalMs;
    }
  }
  const interval = refresh.refreshIntervalMs ?? draft.providers.defaults.refreshIntervalMs;
  if (refresh.maxCacheAgeMs !== undefined) {
    if (Number.isFinite(refresh.maxCacheAgeMs)) {
      refresh.maxCacheAgeMs = Math.min(604_800_000, Math.max(interval, Math.floor(refresh.maxCacheAgeMs)));
    } else {
      delete refresh.maxCacheAgeMs;
    }
  }
  record.refresh = refresh;
  return draft;
}

/** Return an effect for the caller; never invoke an adapter, timer, cache, or filesystem here. */
export function requestProviderRefresh(
  draft: StatuslineSettings,
  providerId: string,
  capability: ProviderCapability,
  isActive = false,
): ProviderUiEffect | undefined {
  const providerEnabled = draft.providers.records[providerId]?.enabled ?? true;
  return resolveRefreshEligibility(draft, providerId, capability, { providerEnabled, isActive })
    ? { type: "refresh-provider", providerId }
    : undefined;
}
