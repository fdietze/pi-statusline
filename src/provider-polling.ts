import type { StatuslineSettings } from "./settings/schema.ts";

/**
 * Providers whose quota the footer can show under these settings: enabled provider-tracking rows,
 * plus the active provider while its main-line `session` segment is visible (the per-provider
 * active-model override wins over the global toggle, as in src/render.ts). The refresh
 * coordinator polls exactly these, so an empty list means no background timer (CPU deep sleep).
 * Pure: no I/O.
 */
export function providersToPoll(settings: StatuslineSettings, activeProvider: string | undefined): string[] {
  if (!settings.enabled) return [];
  const { providers } = settings;
  const rows = providers.enabled ? providers.order.filter((p) => providers.records[p]?.enabled) : [];
  const override = activeProvider ? providers.records[activeProvider]?.activeModel.session : undefined;
  const sessionVisible = override === "on" || (override !== "off" && settings.segments.session);
  return Array.from(new Set(activeProvider && sessionVisible ? [...rows, activeProvider] : rows));
}
