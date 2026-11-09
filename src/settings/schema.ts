import type { SegmentId } from "../segments.ts";
export type { SegmentId } from "../segments.ts";

/** Current schema version. Version 3 adds keyed right-aligned extension statuses. */
export const CURRENT_VERSION = 3 as const;

export type Version = typeof CURRENT_VERSION;

/** Display mode for provider configuration. */
export type ProviderDisplayMode = "default" | "custom";

/** Three-state toggle for active-model segment overrides. */
export type ActiveModelToggle = "default" | "on" | "off";

/** Provider row layout strategy. */
export type ProviderRowLayout = "newline" | "inline" | "wrap";

/** Provider row placement relative to main line. */
export type ProviderPlacement = "below" | "above";

/** Bar visual style. */
export type BarStyle = "rounded" | "block" | "line" | "bracket" | "ascii";

/** Icon style preset. */
export type IconStyle = "emoji" | "unicode" | "ascii" | "nerdfont" | "minimal" | "none" | "custom";

/** Preview mode for settings UI. */
export type PreviewMode = "current" | "local" | "subscription" | "api" | "narrow";

/** Reset time format. */
export type ResetFormat = "countdown" | "exact-time" | "exact-date";

/** Window configuration for provider quota windows. */
export interface WindowConfiguration {
  /** Whether this window is visible in the statusline. */
  visible: boolean;
  /** Custom label for this window (overrides adapter label). */
  label: string;
  /** Show usage bar. */
  showBar: boolean;
  /** Show percentage. */
  showPercent: boolean;
  /** Show reset countdown/time. */
  showReset: boolean;
  /** Format for reset display. */
  resetFormat: ResetFormat;
  /** Show used amount. */
  showUsed: boolean;
  /** Show remaining amount. */
  showRemaining: boolean;
  /** Show window when at zero. */
  showZero: boolean;
  /** Bar width for this window. */
  width: number;
}

/** Per-provider configuration. */
export interface ProviderConfiguration {
  /** Whether this provider is enabled. */
  enabled: boolean;
  /** Display mode: default uses capability-appropriate defaults, custom uses explicit values. */
  displayMode: ProviderDisplayMode;
  /** Quota windows keyed by stable adapter-provided key. */
  windows: Record<string, WindowConfiguration>;
  /** Active-model segment overrides (three-state). */
  activeModel: Record<SegmentId, ActiveModelToggle>;
  /** Optional per-provider thresholds (context warning/critical). */
  thresholds?: { contextWarn: number; contextCrit: number };
  /** Optional provider icon override. */
  icon?: { mode: "default" | "custom" | "hidden"; value: string };
  /** Segments this provider supports overriding (for UI gating). */
  supportedOverrides: SegmentId[];
}

/** Provider-level settings group. */
export interface ProvidersSettings {
  /** Global provider tracking enabled. */
  enabled: boolean;
  /** Persisted provider row order. */
  order: string[];
  /** Provider-specific configurations keyed by provider id. */
  records: Record<string, ProviderConfiguration>;
}

/** Layout configuration. */
export interface LayoutSettings {
  /** Provider row layout strategy. */
  providerRows: ProviderRowLayout;
  /** Provider row placement. */
  placement: ProviderPlacement;
  /** Maximum width for provider rows (0 = unlimited). */
  maxWidth: number;
  /** Global segment order. */
  segmentOrder: SegmentId[];
  /** Narrow priority (segments dropped first under width pressure). */
  narrowPriority: SegmentId[];
  /** Extension status keys rendered at the right edge when spare width is available. */
  rightAlignedExtensionStatuses: string[];
}

/** Separator and spacing configuration. */
export interface SeparatorsSettings {
  /** Main segment separator. */
  main: string;
  /** Window separator. */
  window: string;
  /** Provider row separator. */
  provider: string;
  /** Icon-label separator. */
  iconLabel: string;
  /** Label-value separator. */
  labelValue: string;
  /** Spacing before separator. */
  spacingBefore: number;
  /** Spacing after separator. */
  spacingAfter: number;
  /** Trailing spacing. */
  trailingSpacing: number;
  /** Custom padding. */
  padding: string;
  /** Separator preset name. */
  preset: "Default" | "Compact" | "Minimal" | "Pipes" | "Arrows" | "Unicode" | "ASCII" | "Custom";
}

/** Global segment visibility (tri-state via provider/active-model overrides). */
export type SegmentsSettings = Record<SegmentId, boolean>;

/** Usage bar configuration. */
export interface BarsSettings {
  /** Bar width in characters. */
  width: number;
  /** Fill character. */
  fill: string;
  /** Empty character. */
  empty: string;
  /** Left cap character. */
  capLeft: string;
  /** Right cap character. */
  capRight: string;
  /** Show percentage next to bar. */
  showPercent: boolean;
  /** Bar visual style. */
  style: BarStyle;
  /** Use truecolor for bar gradients. */
  truecolor: boolean;
  /** Warning threshold (0-100). */
  warnAt: number;
  /** Critical threshold (0-100). */
  critAt: number;
}

/** Threshold configuration. */
export interface ThresholdsSettings {
  /** Context warning threshold (percentage). */
  contextWarn: number;
  /** Context critical threshold (percentage). */
  contextCrit: number;
}

/** Icon configuration. */
export interface IconsSettings {
  /** Global icon style. */
  style: IconStyle;
  /** Custom symbol overrides keyed by symbol name. */
  symbols: Record<string, string>;
  /** Provider-specific icon modes. */
  providers: Record<string, { mode: "default" | "global" | "custom" | "hidden"; value: string }>;
}

/** Preview configuration. */
export interface PreviewSettings {
  /** Preview mode. */
  mode: PreviewMode;
}

/** Extra display toggles preserved from the legacy `extras` group (feature parity). */
export interface ExtrasSettings {
  /** Show the running session cost in the model segment. */
  cost: boolean;
  /** Show a queued/pending indicator. */
  pending: boolean;
}

/** Root versioned settings document. */
export interface StatuslineSettings {
  /** Schema version. */
  version: Version;
  /** Global statusline enabled. */
  enabled: boolean;
  /** Provider settings group. */
  providers: ProvidersSettings;
  /** Layout settings group. */
  layout: LayoutSettings;
  /** Separator settings group. */
  separators: SeparatorsSettings;
  /** Global segment visibility. */
  segments: SegmentsSettings;
  /** Usage bar settings. */
  bars: BarsSettings;
  /** Threshold settings. */
  thresholds: ThresholdsSettings;
  /** Icon settings. */
  icons: IconsSettings;
  /** Preview settings. */
  preview: PreviewSettings;
  /** Extra display toggles (legacy feature parity). */
  extras: ExtrasSettings;
  /** Opaque bag for unknown top-level fields (preserved across saves). */
  __unknown?: Record<string, unknown>;
}

/** Parsed settings with optional read-only flag for future versions. */
export interface ParsedSettings {
  settings: StatuslineSettings;
  readOnly?: boolean;
}