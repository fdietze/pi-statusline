export interface RateLimitWindow {
  /** Stable adapter identity; labels may be renamed without losing settings. */
  key?: string;
  label: string;
  used: number;
  resetAt?: number;
  durationMs?: number;
  /** Approximate consumed fraction since the local operational-day boundary. */
  dailyUsed?: number;
}

export type RateLimits = RateLimitWindow[];

export interface RateLimitPace {
  relation: "over" | "under" | "on-pace";
  percentagePoints: number;
}

/** Compare consumed quota with the elapsed share of a reported fixed window. */
export function deriveRateLimitPace(window: RateLimitWindow, now: number): RateLimitPace | undefined {
  const { durationMs, resetAt } = window;
  if (durationMs === undefined || resetAt === undefined
    || !Number.isFinite(window.used) || window.used < 0 || window.used > 1
    || !Number.isFinite(durationMs) || durationMs <= 0
    || !Number.isFinite(resetAt) || !Number.isFinite(now)) return undefined;
  const remainingMs = resetAt - now;
  if (remainingMs <= 0 || remainingMs > durationMs) return undefined;
  const elapsed = 1 - remainingMs / durationMs;
  const delta = (window.used - elapsed) * 100;
  const percentagePoints = Math.abs(delta);
  return {
    relation: percentagePoints <= 1 ? "on-pace" : delta > 0 ? "over" : "under",
    percentagePoints,
  };
}

const ANTHROPIC_WINDOWS = [
  ["five-hour", "5h", "anthropic-ratelimit-unified-5h-utilization"],
  ["seven-day", "wk", "anthropic-ratelimit-unified-7d-utilization"],
] as const;

function numberInRange(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
}

function reset(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function durationLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "wk" : `${minutes / 10_080}wk`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function parseAnthropicUsage(payload: unknown): RateLimits {
  if (!payload || typeof payload !== "object") return [];
  const usage = payload as Record<string, unknown>;

  return ([["five-hour", "5h", usage.five_hour], ["seven-day", "wk", usage.seven_day]] as const).flatMap(([key, label, value]) => {
    if (!value || typeof value !== "object") return [];
    const window = value as Record<string, unknown>;
    const utilization = window.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0 || utilization > 100) return [];
    const resetAt = reset(typeof window.resets_at === "string" || typeof window.resets_at === "number" ? window.resets_at : undefined);
    return [{ key, label, used: utilization / 100, ...(resetAt === undefined ? {} : { resetAt }) }];
  });
}

export function parseCodexUsage(payload: unknown): RateLimits {
  if (!payload || typeof payload !== "object") return [];
  const rateLimit = (payload as Record<string, unknown>).rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return [];

  return ["primary_window", "secondary_window"].flatMap((name) => {
    const value = (rateLimit as Record<string, unknown>)[name];
    if (!value || typeof value !== "object") return [];
    const window = value as Record<string, unknown>;
    const percent = typeof window.used_percent === "number" ? window.used_percent : undefined;
    const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
    if (percent === undefined || !Number.isFinite(percent) || percent < 0 || percent > 100
      || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return [];
    const resetAt = reset(typeof window.reset_at === "number" ? window.reset_at : undefined);
    return [{
      key: name === "primary_window" ? "primary" : "secondary",
      label: durationLabel(seconds / 60),
      used: percent / 100,
      durationMs: seconds * 1_000,
      ...(resetAt === undefined ? {} : { resetAt }),
    }];
  });
}

// Z.AI has not published this endpoint in its own API docs (docs.z.ai); it's only known from a
// third-party reverse-engineered tool. Used anyway at the user's request because it works with
// pi's own stored GLM key and reports the same 5h/weekly credit windows Z.AI documents for the
// Coding Plan (docs.z.ai/devpack/teamplan). Upgrade path: drop this if Z.AI ever breaks/replaces it.
export function parseZaiUsage(payload: unknown): RateLimits {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return [];
  const rawLimits = (data as Record<string, unknown>).limits;
  if (!Array.isArray(rawLimits)) return [];

  // Only TOKENS_LIMIT entries are the coding-plan credit windows; TIME_LIMIT entries are an
  // unrelated MCP tool-call budget (search-prime/web-reader/zread), not the model quota.
  const windows = rawLimits.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const window = entry as Record<string, unknown>;
    if (window.type !== "TOKENS_LIMIT") return [];
    const percentage = window.percentage;
    if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return [];
    return [{ used: percentage / 100, resetAt: reset(typeof window.nextResetTime === "number" ? window.nextResetTime : undefined) }];
  });
  // The response has no documented field naming which window is 5h vs weekly. A window with no
  // active reset countdown hasn't been touched since its last reset (Z.AI docs: 5h credits reset
  // 5 hours *after consumption*, so an untouched window has no countdown; weekly credits always
  // count down once subscribed), so it's the 5h window; otherwise the sooner-resetting window is
  // the 5h one. Fail closed (no row) unless exactly two windows come back, since that's the only
  // shape this heuristic was verified against.
  if (windows.length !== 2) return [];
  const [first, second] = [...windows].sort((a, b) => (a.resetAt ?? -Infinity) - (b.resetAt ?? -Infinity));
  return [
    { key: "five-hour", label: "5h", used: first!.used, ...(first!.resetAt === undefined ? {} : { resetAt: first!.resetAt }) },
    { key: "weekly", label: "wk", used: second!.used, ...(second!.resetAt === undefined ? {} : { resetAt: second!.resetAt }) },
  ];
}

export function parseStoredRateLimits(value: unknown): RateLimits {
  if (!Array.isArray(value)) return [];
  return value.flatMap((window) => {
    if (!window || typeof window !== "object") return [];
    const { key, label, used, resetAt, durationMs } = window as Record<string, unknown>;
    if (key !== undefined && (typeof key !== "string" || !key.trim())) return [];
    if (typeof label !== "string" || !label || typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) return [];
    const parsedResetAt = reset(typeof resetAt === "number" ? resetAt : undefined);
    const parsedDurationMs = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined;
    return [{
      ...(typeof key === "string" ? { key } : {}),
      label,
      used,
      ...(parsedResetAt === undefined ? {} : { resetAt: parsedResetAt }),
      ...(parsedDurationMs === undefined ? {} : { durationMs: parsedDurationMs }),
    }];
  });
}

export function parseRateLimits(headers: Record<string, string>): RateLimits {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const limits: RateLimits = ANTHROPIC_WINDOWS.flatMap(([key, label, header]) => {
    const used = numberInRange(normalized[header], 1);
    const resetAt = reset(normalized[header.replace("utilization", "reset")]);
    return used === undefined ? [] : [{ key, label, used, ...(resetAt === undefined ? {} : { resetAt }) }];
  });

  for (const name of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${name}`;
    const percent = numberInRange(normalized[`${prefix}-used-percent`], 100);
    if (percent === undefined) continue;
    const minutes = numberInRange(normalized[`${prefix}-window-minutes`], Number.MAX_SAFE_INTEGER);
    const resetAt = reset(normalized[`${prefix}-reset-at`]);
    if (percent === 0 && minutes === undefined && resetAt === undefined) continue;
    limits.push({
      key: name,
      label: minutes === undefined ? name : durationLabel(minutes),
      used: percent / 100,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(minutes === undefined || minutes <= 0 ? {} : { durationMs: minutes * 60_000 }),
    });
  }

  return limits;
}
