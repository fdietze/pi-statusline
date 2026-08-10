import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StatuslineSettings } from "./schema.ts";
import { parseStatuslineSettings } from "./validation.ts";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig } from "./defaults.ts";
import { migrateLegacySettings } from "./migrations.ts";

/** Default on-disk settings path (legacy location, preserved for migration continuity). */
export const DEFAULT_STATUSLINE_CONFIG_PATH = join(homedir(), ".pi", "agent", "statusline.json");

/** Registry that can enumerate configured models (used to discover available providers). */
export interface AvailableModelRegistry {
  getAvailable(): Array<{ provider: string }>;
}

function providerName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Providers with configured pi authentication, in registry order (deduped). */
export function configuredProviders(registry: AvailableModelRegistry): string[] {
  return Array.from(new Set(registry.getAvailable().map((model) => providerName(model.provider))
    .filter((provider): provider is string => provider !== undefined)));
}

/** Pre-0.9 default separators. Now that the footer is settings-driven, a saved doc still
 * holding these would flip the live look from `>` to `·`; migrate it once, in-memory and
 * idempotently, so the documented look is preserved without touching a user's real edits. */
const LEGACY_DEFAULT_SEPARATORS = { main: " · ", projectGit: " " } as const;

function migrateLegacyDefaultSeparators(settings: StatuslineSettings): StatuslineSettings {
  const { main, projectGit } = settings.separators;
  if (main === LEGACY_DEFAULT_SEPARATORS.main && projectGit === LEGACY_DEFAULT_SEPARATORS.projectGit) {
    return { ...settings, separators: { ...settings.separators, main: DEFAULT_STATUSLINE_SETTINGS.separators.main, projectGit: DEFAULT_STATUSLINE_SETTINGS.separators.projectGit } };
  }
  return settings;
}

/**
 * Load settings from disk, auto-migrating legacy (unversioned) documents to the new schema.
 * Missing file / invalid JSON -> a clone of defaults. Legacy docs (no `version`) are migrated
 * then normalized so the renderer always sees a valid StatuslineSettings.
 */
export function loadRuntimeSettings(path: string): StatuslineSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !("version" in (raw as Record<string, unknown>))) {
    return parseStatuslineSettings(migrateLegacySettings(raw)).settings;
  }
  return migrateLegacyDefaultSeparators(parseStatuslineSettings(raw).settings);
}

/**
 * Reconcile discovered providers into settings: append newly authenticated providers to the
 * persisted order and seed an enabled record (with a default window) for each, preserving
 * existing records/order. Mirrors the legacy reconcileProviderTracking guarantee.
 */
export function reconcileProviders(settings: StatuslineSettings, registry: AvailableModelRegistry): StatuslineSettings {
  const available = configuredProviders(registry);
  const order = [...settings.providers.order];
  const records = { ...settings.providers.records };
  for (const provider of available) {
    if (!order.includes(provider)) order.push(provider);
    if (!records[provider]) {
      const record = createProviderConfig();
      record.windows["default"] = createWindowConfig();
      records[provider] = record;
    }
  }
  return { ...settings, providers: { ...settings.providers, order, records } };
}

/** Names the /statusline toggle command accepts (segments + legacy extras, with aliases). */
const SEGMENT_TOGGLE_NAMES = new Set<string>(["project", "model", "effort", "extensions", "context", "session", "throughput", "time"]);
const TOGGLE_ALIASES: Record<string, string> = {
  "session-bars": "session",
  elapsed: "sessionElapsed",
  "last-turn": "lastTurn",
};

/**
 * Apply a /statusline toggle by name on a new-shape StatuslineSettings (returns a new object).
 * Segments flip segments[name]; branch/cost/sessionElapsed/lastTurn/pending flip extras[name];
 * nerdFont toggles icons.style between "nerdfont" and "emoji". Throws for unknown names.
 */
export function applyToggle(settings: StatuslineSettings, rawName: string): StatuslineSettings {
  const name = TOGGLE_ALIASES[rawName] ?? rawName;
  if (SEGMENT_TOGGLE_NAMES.has(name)) {
    return { ...settings, segments: { ...settings.segments, [name]: !settings.segments[name as keyof StatuslineSettings["segments"]] } };
  }
  if (name === "nerdFont") {
    return { ...settings, icons: { ...settings.icons, style: settings.icons.style === "nerdfont" ? "emoji" : "nerdfont" } };
  }
  if (name in settings.extras) {
    const key = name as keyof StatuslineSettings["extras"];
    return { ...settings, extras: { ...settings.extras, [key]: !settings.extras[key] } };
  }
  throw new Error(`Unknown statusline segment: ${rawName}`);
}

/** One-line summary of toggleable state for command notifications (parity with legacy formatSettings). */
export function formatStatusSummary(settings: StatuslineSettings): string {
  const rows: Array<[string, boolean]> = [
    ["footer", settings.enabled],
    ...(["project", "model", "effort", "extensions", "context", "session", "throughput", "time"] as const).map((s) => [s, settings.segments[s]] as [string, boolean]),
    ...(["branch", "cost", "sessionElapsed", "lastTurn", "pending"] as const).map((e) => [e, settings.extras[e]] as [string, boolean]),
    ["nerdFont", settings.icons.style === "nerdfont"],
  ];
  return rows.map(([name, enabled]) => `${name}: ${enabled ? "on" : "off"}`).join("\n");
}
