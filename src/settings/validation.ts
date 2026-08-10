import type { StatuslineSettings, ParsedSettings, Version, SegmentId } from "./schema.ts";
import { CURRENT_VERSION } from "./schema.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";
import { SEGMENT_ORDER } from "../segments.ts";
import { migrateVersionOneSettings } from "./migrations.ts";

const VALID_SEGMENT_IDS = new Set<string>(SEGMENT_ORDER);

/** Control characters to strip (C0/C1 except tab and newline). */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** ANSI escape sequence regex (CSI, OSC+BEL/ESC, DCS/SOS/PM/APC+ST, charset, single-byte, ST). */
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*[\x07\x1b]|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[#%]\([0-9A-Z]|\x1b[()][AB012]|\x1b[@-Z\\-_]/g;

/** Bidi override characters. */
const BIDI_OVERRIDE_REGEX = /[\u202A-\u202E\u2066-\u2069]/g;

/** Bare newline in display strings. */
const BARE_NEWLINE_REGEX = /\n/g;

/** Known top-level fields for unknown preservation. */
const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "version",
  "enabled",
  "providers",
  "layout",
  "separators",
  "segments",
  "bars",
  "thresholds",
  "timing",
  "icons",
  "preview",
  "extras",
]);

/** Known provider record fields. */
const KNOWN_PROVIDER_FIELDS = new Set([
  "enabled",
  "displayMode",
  "windows",
  "activeModel",
  "thresholds",
  "icon",
  "missingDataPolicy",
  "refresh",
  "supportedOverrides",
]);

/** Known refresh override fields. */
const KNOWN_REFRESH_FIELDS = new Set([
  "refreshIntervalMs",
  "maxCacheAgeMs",
  "useCache",
  "keepAfterFailure",
  "refreshWhileActive",
  "refreshDisabledProvider",
  "__unknown",
]);

/** Known window fields. */
const KNOWN_WINDOW_FIELDS = new Set([
  "visible",
  "label",
  "showBar",
  "showPercent",
  "showReset",
  "resetFormat",
  "showUsed",
  "showRemaining",
  "showZero",
  "width",
]);

/** Sanitize a display string (labels, separators, symbols). */
function sanitizeDisplayString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(CONTROL_CHAR_REGEX, "")
    .replace(BIDI_OVERRIDE_REGEX, "")
    .replace(BARE_NEWLINE_REGEX, "");
}

/** Sanitize a generic string (provider IDs, keys). */
function sanitizeString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(CONTROL_CHAR_REGEX, "")
    .replace(BIDI_OVERRIDE_REGEX, "")
    .replace(BARE_NEWLINE_REGEX, "");
}

/** Clamp a number to bounds. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Parse and validate a version field. */
function parseVersion(value: unknown): Version {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value as Version;
  }
  return CURRENT_VERSION;
}

/** Parse and validate providers settings. */
function parseProviders(value: unknown): StatuslineSettings["providers"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const order = Array.isArray(input.order)
    ? input.order.map(sanitizeString).filter((s): s is string => s.length > 0)
    : [];
  const defaults = parseProviderDefaults(input.defaults);
  type ProviderRecord = StatuslineSettings["providers"]["records"][string];
  const records: Record<string, ProviderRecord> = {};

  if (input.records && typeof input.records === "object") {
    for (const [providerId, config] of Object.entries(input.records as Record<string, unknown>)) {
      const cleanId = sanitizeString(providerId);
      if (!cleanId) continue;
      records[cleanId] = parseProviderConfig(config);
    }
  }

  return { enabled, order, defaults, records };
}

/** Parse provider defaults. */
function parseProviderDefaults(value: unknown): StatuslineSettings["providers"]["defaults"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const displayMode = input.displayMode === "custom" ? "custom" : "default";
  const missingDataPolicy =
    ["hide", "cached", "na", "warning", "provider-name"].includes(input.missingDataPolicy as string)
      ? (input.missingDataPolicy as StatuslineSettings["providers"]["defaults"]["missingDataPolicy"])
      : "cached";
  const refreshIntervalMs = clamp(
    typeof input.refreshIntervalMs === "number" ? input.refreshIntervalMs : 10000,
    10000,
    86400000
  );
  const maxCacheAgeMs = clamp(
    typeof input.maxCacheAgeMs === "number" ? input.maxCacheAgeMs : 300000,
    refreshIntervalMs,
    604800000
  );
  return {
    displayMode,
    missingDataPolicy,
    refreshIntervalMs,
    maxCacheAgeMs,
    useCache: typeof input.useCache === "boolean" ? input.useCache : true,
    keepAfterFailure: typeof input.keepAfterFailure === "boolean" ? input.keepAfterFailure : true,
    refreshWhileActive: typeof input.refreshWhileActive === "boolean" ? input.refreshWhileActive : true,
    refreshDisabledProvider: typeof input.refreshDisabledProvider === "boolean" ? input.refreshDisabledProvider : false,
  };
}

/** Parse provider configuration. */
function parseProviderConfig(value: unknown): StatuslineSettings["providers"]["records"][string] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const displayMode = input.displayMode === "custom" ? "custom" : "default";

  const windows: Record<string, StatuslineSettings["providers"]["records"][string]["windows"][string]> = {};
  if (input.windows && typeof input.windows === "object") {
    for (const [key, win] of Object.entries(input.windows as Record<string, unknown>)) {
      const cleanKey = sanitizeString(key);
      if (!cleanKey) continue;
      windows[cleanKey] = parseWindowConfig(win);
    }
  }

  const activeModel: Record<string, "default" | "on" | "off"> = {};
  if (input.activeModel && typeof input.activeModel === "object") {
    for (const [segment, mode] of Object.entries(input.activeModel as Record<string, unknown>)) {
      if (["default", "on", "off"].includes(mode as string)) {
        activeModel[segment] = mode as "default" | "on" | "off";
      }
    }
  }

  let thresholds: { contextWarn: number; contextCrit: number } | undefined;
  if (input.thresholds && typeof input.thresholds === "object") {
    const t = input.thresholds as Record<string, unknown>;
    const warn = clamp(typeof t.contextWarn === "number" ? t.contextWarn : 80, 1, 100);
    const crit = clamp(typeof t.contextCrit === "number" ? t.contextCrit : 95, 1, 100);
    if (warn < crit) {
      thresholds = { contextWarn: warn, contextCrit: crit };
    }
  }

  let icon: { mode: "default" | "custom" | "hidden"; value: string } | undefined;
  if (input.icon && typeof input.icon === "object") {
    const i = input.icon as Record<string, unknown>;
    const mode = ["default", "custom", "hidden"].includes(i.mode as string)
      ? (i.mode as "default" | "custom" | "hidden")
      : "default";
    const value = sanitizeDisplayString(i.value);
    icon = { mode, value };
  }

  const missingDataPolicy = ["hide", "cached", "na", "warning", "provider-name"].includes(input.missingDataPolicy as string)
    ? input.missingDataPolicy as StatuslineSettings["providers"]["defaults"]["missingDataPolicy"]
    : undefined;

  let refresh: StatuslineSettings["providers"]["records"][string]["refresh"];
  if (input.refresh && typeof input.refresh === "object") {
    const source = input.refresh as Record<string, unknown>;
    refresh = {};
    if (typeof source.refreshIntervalMs === "number" && Number.isFinite(source.refreshIntervalMs)) {
      refresh.refreshIntervalMs = clamp(Math.floor(source.refreshIntervalMs), 10_000, 86_400_000);
    }
    if (typeof source.maxCacheAgeMs === "number" && Number.isFinite(source.maxCacheAgeMs)) {
      refresh.maxCacheAgeMs = clamp(
        Math.floor(source.maxCacheAgeMs),
        refresh.refreshIntervalMs ?? 10_000,
        604_800_000,
      );
    }
    for (const key of ["useCache", "keepAfterFailure", "refreshWhileActive", "refreshDisabledProvider"] as const) {
      if (typeof source[key] === "boolean") refresh[key] = source[key];
    }
    const existingUnknown = source.__unknown && typeof source.__unknown === "object" && !Array.isArray(source.__unknown)
      ? source.__unknown as Record<string, unknown>
      : {};
    const unknownRefresh = { ...existingUnknown, ...collectUnknown(source, KNOWN_REFRESH_FIELDS) };
    if (Object.keys(unknownRefresh).length) refresh.__unknown = unknownRefresh;
    if (!Object.keys(refresh).length) refresh = undefined;
  }

  const supportedOverrides: SegmentId[] = [];
  if (Array.isArray(input.supportedOverrides)) {
    for (const s of input.supportedOverrides) {
      const clean = sanitizeString(s);
      if (clean && VALID_SEGMENT_IDS.has(clean)) supportedOverrides.push(clean as SegmentId);
    }
  }

  return {
    enabled,
    displayMode,
    windows,
    activeModel,
    thresholds,
    icon,
    ...(missingDataPolicy ? { missingDataPolicy } : {}),
    ...(refresh ? { refresh } : {}),
    supportedOverrides,
  };
}

/** Parse window configuration. */
function parseWindowConfig(value: unknown): StatuslineSettings["providers"]["records"][string]["windows"][string] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    visible: typeof input.visible === "boolean" ? input.visible : true,
    label: sanitizeDisplayString(input.label),
    showBar: typeof input.showBar === "boolean" ? input.showBar : true,
    showPercent: typeof input.showPercent === "boolean" ? input.showPercent : true,
    showReset: typeof input.showReset === "boolean" ? input.showReset : true,
    resetFormat: ["countdown", "exact-time", "exact-date"].includes(input.resetFormat as string)
      ? (input.resetFormat as "countdown" | "exact-time" | "exact-date")
      : "countdown",
    showUsed: typeof input.showUsed === "boolean" ? input.showUsed : true,
    showRemaining: typeof input.showRemaining === "boolean" ? input.showRemaining : true,
    showZero: typeof input.showZero === "boolean" ? input.showZero : false,
    width: clamp(typeof input.width === "number" ? input.width : 12, 1, 200),
  };
}

/** Parse layout settings. */
function parseLayout(value: unknown): StatuslineSettings["layout"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const providerRows = ["newline", "inline", "wrap"].includes(input.providerRows as string)
    ? (input.providerRows as "newline" | "inline" | "wrap")
    : "newline";
  const placement = ["above", "below"].includes(input.placement as string)
    ? (input.placement as "above" | "below")
    : "below";
  const maxWidth = clamp(typeof input.maxWidth === "number" ? input.maxWidth : 0, 0, 10000);
  const segmentOrder: SegmentId[] = Array.isArray(input.segmentOrder)
    ? input.segmentOrder.map(sanitizeString).filter((s): s is SegmentId => VALID_SEGMENT_IDS.has(s))
    : [];
  const narrowPriority: SegmentId[] = Array.isArray(input.narrowPriority)
    ? input.narrowPriority.map(sanitizeString).filter((s): s is SegmentId => VALID_SEGMENT_IDS.has(s))
    : [];
  const rightAlignedExtensionStatuses = Array.isArray(input.rightAlignedExtensionStatuses)
    ? [...new Set(input.rightAlignedExtensionStatuses
      .map((key) => sanitizeString(key).trim().slice(0, 128))
      .filter((key) => key.length > 0))].slice(0, 32)
    : [...DEFAULT_STATUSLINE_SETTINGS.layout.rightAlignedExtensionStatuses];

  return {
    providerRows,
    placement,
    maxWidth,
    // Absent or fully-invalid order falls back to cloned defaults (never an empty order).
    segmentOrder: segmentOrder.length ? segmentOrder : [...DEFAULT_STATUSLINE_SETTINGS.layout.segmentOrder],
    narrowPriority: narrowPriority.length ? narrowPriority : [...DEFAULT_STATUSLINE_SETTINGS.layout.narrowPriority],
    rightAlignedExtensionStatuses,
  };
}

/** Parse separators settings. */
function parseSeparators(value: unknown): StatuslineSettings["separators"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const presets = ["Default", "Compact", "Minimal", "Pipes", "Arrows", "Unicode", "ASCII", "Custom"] as const;
  // ponytail: default only when the field is ABSENT; a present value that sanitizes to "" stays ""
  const sep = (v: unknown, d: string): string => (v === undefined || v === null ? d : sanitizeDisplayString(v));
  return {
    main: sep(input.main, DEFAULT_STATUSLINE_SETTINGS.separators.main),
    projectGit: sep(input.projectGit, DEFAULT_STATUSLINE_SETTINGS.separators.projectGit),
    window: sep(input.window, " | "),
    provider: sep(input.provider, "\n"),
    iconLabel: sep(input.iconLabel, ""),
    labelValue: sep(input.labelValue, " "),
    spacingBefore: clamp(typeof input.spacingBefore === "number" ? input.spacingBefore : DEFAULT_STATUSLINE_SETTINGS.separators.spacingBefore, 0, 10),
    spacingAfter: clamp(typeof input.spacingAfter === "number" ? input.spacingAfter : DEFAULT_STATUSLINE_SETTINGS.separators.spacingAfter, 0, 10),
    trailingSpacing: clamp(typeof input.trailingSpacing === "number" ? input.trailingSpacing : DEFAULT_STATUSLINE_SETTINGS.separators.trailingSpacing, 0, 10),
    padding: sep(input.padding, ""),
    preset: presets.includes(input.preset as typeof presets[number]) ? (input.preset as typeof presets[number]) : "Default",
  };
}

/** Parse segments settings. */
function parseSegments(value: unknown): StatuslineSettings["segments"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  // Start from cloned defaults so every SegmentId is present; apply only valid overrides.
  const result = structuredClone(DEFAULT_STATUSLINE_SETTINGS.segments);
  for (const [key, val] of Object.entries(input)) {
    if (VALID_SEGMENT_IDS.has(key)) {
      result[key as SegmentId] = typeof val === "boolean" ? val : true;
    }
  }
  return result;
}

/** Parse bars settings. */
function parseBars(value: unknown): StatuslineSettings["bars"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const styles = ["rounded", "block", "line", "bracket", "ascii"] as const;
  const warnAt = typeof input.warnAt === "number" && input.warnAt >= 0 && input.warnAt <= 100 ? input.warnAt : 80;
  const critAt = typeof input.critAt === "number" && input.critAt >= 0 && input.critAt <= 100 ? input.critAt : 95;
  return {
    width: clamp(typeof input.width === "number" ? input.width : 12, 1, 200),
    fill: sanitizeDisplayString(input.fill) || "█",
    empty: sanitizeDisplayString(input.empty) || "░",
    capLeft: sanitizeDisplayString(input.capLeft) || "╟",
    capRight: sanitizeDisplayString(input.capRight) || "╢",
    showPercent: typeof input.showPercent === "boolean" ? input.showPercent : true,
    style: styles.includes(input.style as typeof styles[number]) ? (input.style as typeof styles[number]) : "rounded",
    truecolor: typeof input.truecolor === "boolean" ? input.truecolor : true,
    // ponytail: impossible/inverted thresholds fall back together rather than creating a misleading scale.
    warnAt: warnAt < critAt ? warnAt : 80,
    critAt: warnAt < critAt ? critAt : 95,
  };
}

/** Parse thresholds settings. */
function parseThresholds(value: unknown): StatuslineSettings["thresholds"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const warn = clamp(typeof input.contextWarn === "number" ? input.contextWarn : 80, 1, 100);
  const crit = clamp(typeof input.contextCrit === "number" ? input.contextCrit : 95, 1, 100);
  return { contextWarn: warn < crit ? warn : 80, contextCrit: warn < crit ? crit : 95 };
}

/** Parse timing settings. */
function parseTiming(value: unknown): StatuslineSettings["timing"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const refreshIntervalMs = clamp(typeof input.refreshIntervalMs === "number" ? input.refreshIntervalMs : 10000, 10000, 86400000);
  const maxCacheAgeMs = clamp(typeof input.maxCacheAgeMs === "number" ? input.maxCacheAgeMs : 300000, refreshIntervalMs, 604800000);
  return { refreshIntervalMs, maxCacheAgeMs };
}

/** Parse icons settings. */
function parseIcons(value: unknown): StatuslineSettings["icons"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const styles = ["emoji", "unicode", "ascii", "nerdfont", "minimal", "none", "custom"] as const;
  const symbols: Record<string, string> = {};
  if (input.symbols && typeof input.symbols === "object") {
    for (const [key, val] of Object.entries(input.symbols as Record<string, unknown>)) {
      symbols[key] = sanitizeDisplayString(val);
    }
  }
  const providers: Record<string, { mode: "default" | "global" | "custom" | "hidden"; value: string }> = {};
  if (input.providers && typeof input.providers === "object") {
    for (const [provider, config] of Object.entries(input.providers as Record<string, unknown>)) {
      const c = config as Record<string, unknown>;
      const mode = ["default", "global", "custom", "hidden"].includes(c.mode as string)
        ? (c.mode as "default" | "global" | "custom" | "hidden")
        : "default";
      const value = sanitizeDisplayString(c.value);
      providers[provider] = { mode, value };
    }
  }
  return {
    style: styles.includes(input.style as typeof styles[number]) ? (input.style as typeof styles[number]) : "emoji",
    symbols,
    providers,
  };
}

/** Parse preview settings. */
function parsePreview(value: unknown): StatuslineSettings["preview"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const modes = ["current", "local", "subscription", "api", "narrow"] as const;
  return {
    mode: modes.includes(input.mode as typeof modes[number]) ? (input.mode as typeof modes[number]) : "current",
  };
}

/** Parse extras settings (legacy feature-parity toggles). */
function parseExtras(value: unknown): StatuslineSettings["extras"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const bool = (v: unknown, d: boolean): boolean => typeof v === "boolean" ? v : d;
  return {
    branch: bool(input.branch, true),
    cost: bool(input.cost, false),
    sessionElapsed: bool(input.sessionElapsed, false),
    lastTurn: bool(input.lastTurn, false),
    pending: bool(input.pending, false),
  };
}

/** Collect unknown fields from an object. */
function collectUnknown(input: Record<string, unknown>, knownFields: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!knownFields.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Safe parse/normalize function for StatuslineSettings.
 * Validates, normalizes, bounds, and falls back to defaults for invalid documents.
 * Preserves unknown fields via opaque __unknown bag.
 * Future versions (> CURRENT_VERSION) return readOnly: true and are returned unchanged.
 */
export function parseStatuslineSettings(unknown: unknown): ParsedSettings {
  // Handle null/undefined/non-object — return a CLONE so callers can never mutate the singleton.
  if (!unknown || typeof unknown !== "object") {
    return { settings: structuredClone(DEFAULT_STATUSLINE_SETTINGS) };
  }

  const source = unknown as Record<string, unknown>;
  const version = parseVersion(source.version);

  // Future version: read-only and returned UNCHANGED (no normalization/bounding).
  // Preserve the document's own values; collect only the unknown top-level keys into __unknown.
  // structuredClone de-aliases nested default objects so a read-only doc can't leak into the singleton.
  if (version > CURRENT_VERSION) {
    const __unknown = collectUnknown(source, KNOWN_TOP_LEVEL_FIELDS);
    return {
      settings: structuredClone({ ...DEFAULT_STATUSLINE_SETTINGS, ...source, version, __unknown }) as unknown as StatuslineSettings,
      readOnly: true,
    };
  }

  // Upgrade complete v1 documents before normalizing. Unversioned legacy documents are converted
  // by loadRuntimeSettings() before they reach this parser.
  const input = Number(version) === 1 ? migrateVersionOneSettings(source) : source;

  // Current or past version: normalize and validate
  const providers = parseProviders(input.providers);
  const layout = parseLayout(input.layout);
  const separators = parseSeparators(input.separators);
  const segments = parseSegments(input.segments);
  const bars = parseBars(input.bars);
  const thresholds = parseThresholds(input.thresholds);
  const timing = parseTiming(input.timing);
  const icons = parseIcons(input.icons);
  const preview = parsePreview(input.preview);
  const extras = parseExtras(input.extras);
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;

  // Collect unknown top-level fields
  const __unknown = collectUnknown(input, KNOWN_TOP_LEVEL_FIELDS);

  // Also collect unknown provider fields
  if (input.providers && typeof input.providers === "object") {
    const provInput = input.providers as Record<string, unknown>;
    if (provInput.records && typeof provInput.records === "object") {
      for (const [rawProviderId, config] of Object.entries(provInput.records as Record<string, unknown>)) {
        // Sanitize the provider key so unknown fields merge into the sanitized record, not a duplicate raw key.
        const providerId = sanitizeString(rawProviderId);
        if (!providerId || !config || typeof config !== "object") continue;
        const configInput = config as Record<string, unknown>;
        const unknownProv = collectUnknown(configInput, KNOWN_PROVIDER_FIELDS);
        if (Object.keys(unknownProv).length > 0) {
          if (!providers.records[providerId]) {
            providers.records[providerId] = parseProviderConfig({});
          }
          (providers.records[providerId] as unknown as Record<string, unknown>).__unknown = unknownProv;
        }
        // Collect unknown window fields
        if (configInput.windows && typeof configInput.windows === "object") {
          for (const [winKey, winConfig] of Object.entries(configInput.windows as Record<string, unknown>)) {
            if (!(winConfig && typeof winConfig === "object")) continue;
            const winInput = winConfig as Record<string, unknown>;
            const unknownWin = collectUnknown(winInput, KNOWN_WINDOW_FIELDS);
            if (Object.keys(unknownWin).length > 0) {
              if (!providers.records[providerId]?.windows[winKey]) {
                providers.records[providerId].windows[winKey] = parseWindowConfig({});
              }
              (providers.records[providerId].windows[winKey] as unknown as Record<string, unknown>).__unknown = unknownWin;
            }
          }
        }
      }
    }
  }

  return {
    settings: {
      version: CURRENT_VERSION,
      enabled,
      providers,
      layout,
      separators,
      segments,
      bars,
      thresholds,
      timing,
      icons,
      preview,
      extras,
      __unknown,
    },
  };
}