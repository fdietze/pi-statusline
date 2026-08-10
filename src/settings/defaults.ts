import type {
  StatuslineSettings,
  ProviderDefaults,
  ProviderConfiguration,
  WindowConfiguration,
  SegmentId,
  ProviderDisplayMode,
  ActiveModelToggle,
  ProviderRowLayout,
  ProviderPlacement,
  BarStyle,
  IconStyle,
  PreviewMode,
  MissingDataPolicy,
  ResetFormat,
} from "./schema.ts";
import { CURRENT_VERSION } from "./schema.ts";
import { SEGMENT_ORDER } from "../segments.ts";

/** Default window configuration. */
function defaultWindowConfig(): WindowConfiguration {
  return {
    visible: true,
    label: "",
    showBar: true,
    showPercent: true,
    showReset: true,
    resetFormat: "countdown",
    showUsed: true,
    showRemaining: true,
    showZero: false,
    width: 12,
  };
}

/** Default provider configuration. */
function defaultProviderConfig(): ProviderConfiguration {
  return {
    enabled: true,
    displayMode: "default",
    windows: {},
    activeModel: Object.fromEntries(
      SEGMENT_ORDER.map((id) => [id, "default" as ActiveModelToggle])
    ) as Record<SegmentId, ActiveModelToggle>,
    supportedOverrides: [...SEGMENT_ORDER],
  };
}

/** Default provider defaults. */
const DEFAULT_PROVIDER_DEFAULTS: ProviderDefaults = {
  displayMode: "default",
  missingDataPolicy: "cached",
  refreshIntervalMs: 10000,
  maxCacheAgeMs: 300000,
  useCache: true,
  keepAfterFailure: true,
  refreshWhileActive: true,
  refreshDisabledProvider: false,
};

/** Default separators — match the live footer's documented look (` > ` between segments). */
const DEFAULT_SEPARATORS = {
  main: " >",
  projectGit: " > ",
  window: " | ",
  provider: "\n",
  iconLabel: "",
  labelValue: " ",
  spacingBefore: 0,
  spacingAfter: 1,
  trailingSpacing: 0,
  padding: "",
  preset: "Default" as const,
};

/** Default bars. */
const DEFAULT_BARS = {
  width: 12,
  fill: "█",
  empty: "░",
  capLeft: "╟",
  capRight: "╢",
  showPercent: true,
  style: "rounded" as BarStyle,
  truecolor: true,
  warnAt: 80,
  critAt: 95,
};

/** Default thresholds. */
const DEFAULT_THRESHOLDS = {
  contextWarn: 80,
  contextCrit: 95,
};

/** Default timing. */
const DEFAULT_TIMING = {
  refreshIntervalMs: 10000,
  maxCacheAgeMs: 300000,
};

/** Default icons. */
const DEFAULT_ICONS = {
  style: "emoji" as IconStyle,
  symbols: {} as Record<string, string>,
  providers: {} as Record<string, { mode: "default" | "global" | "custom" | "hidden"; value: string }>,
};

/** Default preview. */
const DEFAULT_PREVIEW = {
  mode: "current" as PreviewMode,
};

/** Default extras (legacy feature parity: branch on, others off). */
const DEFAULT_EXTRAS = {
  branch: true,
  cost: false,
  sessionElapsed: false,
  lastTurn: false,
  pending: false,
};

/** Default layout. */
const DEFAULT_LAYOUT = {
  providerRows: "newline" as ProviderRowLayout,
  placement: "below" as ProviderPlacement,
  maxWidth: 0,
  segmentOrder: [...SEGMENT_ORDER] as SegmentId[],
  narrowPriority: ["time", "throughput", "project", "effort", "model", "session", "extensions"] as SegmentId[],
  rightAlignedExtensionStatuses: ["mcp"],
};

/** Default providers group. */
const DEFAULT_PROVIDERS = {
  enabled: true,
  order: [] as string[],
  defaults: DEFAULT_PROVIDER_DEFAULTS,
  records: {} as Record<string, ProviderConfiguration>,
};

/** Default segments (all enabled). */
const DEFAULT_SEGMENTS: Record<SegmentId, boolean> = {
  project: true,
  model: true,
  effort: true,
  extensions: true,
  context: true,
  session: true,
  throughput: true,
  time: true,
};

/**
 * Default statusline settings reproducing current behavior where meaningful.
 * - enabled: true (footer on by default)
 * - segmentOrder: [project, model, effort, extensions, context, session, throughput, time]
 * - narrowPriority: [time, throughput, project, effort, model, session, extensions] (context preserved last)
 * - rightAlignedExtensionStatuses: [mcp] (only when spare width is available)
 * - bars: rounded width 12, fill '█', empty '░', rounded caps, showPercent true
 * - providerRows: 'newline' (one provider per line)
 * - thresholds: 80/95 warning/critical
 * - refreshIntervalMs: 10000 (min 10000), maxCacheAgeMs: 300000
 * - icon style: 'emoji'
 * - separators main: ' >' with one space after it
 */
export const DEFAULT_STATUSLINE_SETTINGS: StatuslineSettings = {
  version: CURRENT_VERSION,
  enabled: true,
  providers: DEFAULT_PROVIDERS,
  layout: DEFAULT_LAYOUT,
  separators: DEFAULT_SEPARATORS,
  segments: DEFAULT_SEGMENTS,
  bars: DEFAULT_BARS,
  thresholds: DEFAULT_THRESHOLDS,
  timing: DEFAULT_TIMING,
  icons: DEFAULT_ICONS,
  preview: DEFAULT_PREVIEW,
  extras: DEFAULT_EXTRAS,
};

/** Create a fresh provider configuration with defaults. */
export function createProviderConfig(): ProviderConfiguration {
  return defaultProviderConfig();
}

/** Create a fresh window configuration with defaults. */
export function createWindowConfig(): WindowConfiguration {
  return defaultWindowConfig();
}

/** Create default provider defaults. */
export function createProviderDefaults(): ProviderDefaults {
  return { ...DEFAULT_PROVIDER_DEFAULTS };
}