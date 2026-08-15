import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";
import { parseStoredRateLimits } from "./ratelimit.ts";
import { PROVIDER_MAX_AGE_MS, PROVIDER_REFRESH_MS, RateLimitedError, type ProviderUsage } from "./providers.ts";

export const PROVIDER_CACHE_DIR = join(homedir(), ".pi", "agent", "statusline", "provider-usage");
const LOCK_MS = 10_000;
// When a provider's usage endpoint returns 429, back off with a growing delay shared across
// every session and every caller (persisted in the cache file). Anthropic's usage endpoint sends
// retry-after: 0, which is useless, so we use our own schedule instead. Capped at the last step.
const BACKOFF_STEPS_MS = [60_000, 120_000, 300_000];

interface CachedUsage extends ProviderUsage {
  updatedAt: number;
  /** Epoch ms; while now() < retryAt the cache skips fetching (active 429 backoff). */
  retryAt?: number;
  /** Next index into BACKOFF_STEPS_MS; bumped on each consecutive 429, cleared on success. */
  backoffStep?: number;
}

export class ProviderUsageCache {
  private readonly dir: string;
  private readonly refreshMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;
  private readonly refreshMsOverrides: Record<string, number>;

  constructor(
    dir = PROVIDER_CACHE_DIR,
    refreshMs = PROVIDER_REFRESH_MS,
    lockMs = LOCK_MS,
    now = () => Date.now(),
    refreshMsOverrides: Record<string, number> = {},
  ) {
    this.dir = dir;
    this.refreshMs = refreshMs;
    this.lockMs = lockMs;
    this.now = now;
    this.refreshMsOverrides = refreshMsOverrides;
  }

  private refreshMsFor(provider: string): number {
    return this.refreshMsOverrides[provider] ?? this.refreshMs;
  }

  get(provider: string, scope?: string): CachedUsage | undefined {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(readFileSync(this.file(provider, scope), "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const limits = parseStoredRateLimits(value.limits);
    const updatedAt = value.updatedAt;
    const retryAt = typeof value.retryAt === "number" && Number.isFinite(value.retryAt) ? value.retryAt : undefined;
    const backoffStep = typeof value.backoffStep === "number" && Number.isInteger(value.backoffStep) && value.backoffStep >= 0 ? value.backoffStep : undefined;
    const usageValid = limits.length && typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt <= this.now();
    // Keep an entry while it has usable usage, or while a 429 backoff is still cooling down.
    if (!usageValid && retryAt === undefined) return undefined;
    const extras = { ...(retryAt === undefined ? {} : { retryAt }), ...(backoffStep === undefined ? {} : { backoffStep }) };
    return usageValid
      ? { limits, updatedAt: updatedAt as number, ...extras }
      : { limits: [], updatedAt: 0, ...extras };
  }

  getFresh(provider: string, maxAge = PROVIDER_MAX_AGE_MS, scope?: string): CachedUsage | undefined {
    const cached = this.get(provider, scope);
    return cached && cached.limits.length && this.now() - cached.updatedAt <= maxAge ? cached : undefined;
  }

  async refresh(provider: string, fetchUsage: () => Promise<ProviderUsage | undefined>, scope?: string): Promise<ProviderUsage | undefined> {
    const refreshMs = this.refreshMsFor(provider);
    const before = this.get(provider, scope);
    // Honor an active 429 backoff: don't hit the endpoint again until it expires.
    if (before?.retryAt !== undefined && this.now() < before.retryAt) {
      return before.limits.length ? { limits: before.limits } : undefined;
    }
    if (before?.limits.length && this.now() - before.updatedAt < refreshMs) {
      return { limits: before.limits };
    }
    mkdirSync(this.dir, { recursive: true });
    let release: () => void;
    try {
      release = lockSync(this.file(provider, scope), { realpath: false, stale: Math.max(this.lockMs, 5_000), retries: 0 });
    } catch {
      return before?.limits.length ? { limits: before.limits } : undefined;
    }
    try {
      const current = this.get(provider, scope);
      if (current?.retryAt !== undefined && this.now() < current.retryAt) {
        return current.limits.length ? { limits: current.limits } : undefined;
      }
      if (current?.limits.length && this.now() - current.updatedAt < refreshMs) {
        return { limits: current.limits };
      }
      try {
        const usage = await fetchUsage();
        if (usage?.limits.length) {
          // Success: store fresh usage and clear any backoff.
          this.save(provider, { limits: usage.limits, updatedAt: this.now() }, scope);
          return usage;
        }
        return current?.limits.length ? { limits: current.limits } : undefined;
      } catch (error) {
        if (error instanceof RateLimitedError) {
          // 429: persist a growing backoff so every session and every caller backs off.
          this.applyBackoff(provider, current, scope);
        } else if (!current?.limits.length) {
          throw error;
        }
        return current?.limits.length ? { limits: current.limits } : undefined;
      }
    } finally {
      try { release(); } catch { /* The lock may already have been recovered after a crash. */ }
    }
  }

  private applyBackoff(provider: string, current: CachedUsage | undefined, scope?: string): void {
    const step = current?.backoffStep ?? 0;
    const delay = BACKOFF_STEPS_MS[Math.min(step, BACKOFF_STEPS_MS.length - 1)];
    const hasUsage = current?.limits.length;
    this.save(provider, {
      limits: hasUsage ? current!.limits : [],
      updatedAt: hasUsage ? current!.updatedAt : 0,
      retryAt: this.now() + delay,
      backoffStep: step + 1,
    }, scope);
  }

  private file(provider: string, scope?: string) {
    const key = scope ? `${provider}\0${scope}` : provider;
    return join(this.dir, `${Buffer.from(key).toString("base64url")}.json`);
  }

  private save(provider: string, record: CachedUsage, scope?: string): void {
    const file = this.file(provider, scope);
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf8");
      renameSync(temporary, file);
    } finally {
      try { unlinkSync(temporary); } catch { /* The atomic rename already won. */ }
    }
  }
}
