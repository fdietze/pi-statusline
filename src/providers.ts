import type { RateLimits } from "./ratelimit.ts";

export const PROVIDER_REFRESH_MS = 10_000;
// Keep the last quota during a brief provider/API outage instead of flickering to unavailable.
export const PROVIDER_MAX_AGE_MS = 5 * 60_000;

export interface ProviderUsage {
  limits: RateLimits;
}

export type ProviderHealth =
  | { state: "fresh"; usage: ProviderUsage; updatedAt: number }
  | { state: "hidden"; reason: string; updatedAt?: number };

export interface ProviderAdapter {
  refresh(signal: AbortSignal): Promise<ProviderUsage | undefined>;
}

/** Thrown by a provider usage fetch on HTTP 429. The provider-usage cache catches it to apply a
 *  shared, persisted backoff, so every session and every caller (background poll, session start,
 *  model select) stops hammering the endpoint until the cooldown elapses. */
export class RateLimitedError extends Error {
  constructor() {
    super("usage endpoint returned 429");
    this.name = "RateLimitedError";
  }
}

/** Never surface thrown provider data; these are deliberately short UI-safe reasons. */
export function sanitizedReason(provider: string, error?: unknown): string {
  // OpenRouter's only usage endpoint requires a separate management key pi doesn't manage
  // (the inference key pi already stores is explicitly rejected by that endpoint).
  if (provider === "openrouter") return "usage requires an OpenRouter management key pi doesn't manage";
  if (error instanceof DOMException && error.name === "TimeoutError") return "usage refresh timed out";
  return "usage unavailable";
}

export class ProviderRefreshCoordinator {
  private readonly health = new Map<string, ProviderHealth>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();

  constructor(
    adapters: ReadonlyMap<string, ProviderAdapter>,
    onUpdate: () => void,
    cadenceMs = PROVIDER_REFRESH_MS,
    maxAgeMs = PROVIDER_MAX_AGE_MS,
  ) {
    this.adapters = adapters;
    this.onUpdate = onUpdate;
    this.cadenceMs = cadenceMs;
    this.maxAgeMs = maxAgeMs;
  }

  private readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  private readonly onUpdate: () => void;
  private readonly cadenceMs: number;
  private readonly maxAgeMs: number;

  start(providers: readonly string[]) {
    this.stop();
    for (const provider of providers) void this.refresh(provider);
    this.timer = setInterval(() => { for (const provider of providers) void this.refresh(provider); }, this.cadenceMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(provider: string, now = Date.now()): ProviderHealth {
    const value = this.health.get(provider);
    if (value?.state === "fresh" && now - value.updatedAt <= this.maxAgeMs) return value;
    return value?.state === "hidden" ? value : { state: "hidden", reason: "usage data is stale", updatedAt: value?.updatedAt };
  }

  prime(provider: string, usage: ProviderUsage, updatedAt: number): void {
    if (usage.limits.length && Number.isFinite(updatedAt) && updatedAt <= Date.now()) this.health.set(provider, { state: "fresh", usage, updatedAt });
  }

  invalidate(provider: string): void {
    if (this.health.delete(provider)) this.onUpdate();
  }

  async refresh(provider: string): Promise<void> {
    if (this.running.has(provider)) return;
    this.running.add(provider);
    const adapter = this.adapters.get(provider);
    const previous = this.health.get(provider);
    if (!adapter) {
      if (previous?.state !== "fresh") this.health.set(provider, { state: "hidden", reason: sanitizedReason(provider) });
      this.running.delete(provider);
      this.onUpdate();
      return;
    }
    try {
      const usage = await adapter.refresh(AbortSignal.timeout(Math.min(this.cadenceMs, 3_000)));
      if (usage?.limits.length) this.health.set(provider, { state: "fresh", usage, updatedAt: Date.now() });
      else if (previous?.state !== "fresh") this.health.set(provider, { state: "hidden", reason: "usage unavailable" });
    } catch (error) {
      if (previous?.state !== "fresh") this.health.set(provider, { state: "hidden", reason: sanitizedReason(provider, error) });
    } finally {
      this.running.delete(provider);
      this.onUpdate();
    }
  }
}
