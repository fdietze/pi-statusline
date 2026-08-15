import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lockSync } from "proper-lockfile";
import type { RateLimits, RateLimitWindow } from "./ratelimit.ts";

export const CODEX_QUOTA_HISTORY_DIR = join(homedir(), ".pi", "agent", "statusline", "quota-history");
const FILE = "openai-codex.json";
const VERSION = 1;
const DAY_START_HOUR = 5;
const LOCK_MS = 10_000;

interface WindowState {
  used: number;
  dailyUsed: number;
  observedAt: number;
  resetAt?: number;
  durationMs?: number;
}

interface AccountState {
  dayStart: number;
  observedAt: number;
  windows: Record<string, WindowState>;
}

interface HistoryFile {
  version: 1;
  accounts: Record<string, AccountState>;
}

type ReadResult = { kind: "missing" | "invalid" } | { kind: "valid"; history: HistoryFile };

/** Start of the local operational day containing `at` (05:00 through 04:59). */
export function operationalDayStart(at: number): number {
  const date = new Date(at);
  date.setHours(DAY_START_HOUR, 0, 0, 0);
  if (at < date.getTime()) date.setDate(date.getDate() - 1);
  return date.getTime();
}

function previousDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() - 1);
  date.setHours(DAY_START_HOUR, 0, 0, 0);
  return date.getTime();
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWindow(value: unknown, stateObservedAt: number): WindowState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const window = value as Record<string, unknown>;
  if (!finite(window.used) || window.used < 0 || window.used > 1
    || !finite(window.dailyUsed) || window.dailyUsed < 0
    || !finite(window.observedAt) || window.observedAt > stateObservedAt) return undefined;
  const resetAt = window.resetAt === undefined ? undefined : finite(window.resetAt) ? window.resetAt : NaN;
  const durationMs = window.durationMs === undefined ? undefined : finite(window.durationMs) && window.durationMs > 0 ? window.durationMs : NaN;
  if (Number.isNaN(resetAt) || Number.isNaN(durationMs)) return undefined;
  return {
    used: window.used,
    dailyUsed: window.dailyUsed,
    observedAt: window.observedAt,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function parseAccount(value: unknown, now: number): AccountState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const account = value as Record<string, unknown>;
  if (!finite(account.dayStart) || !finite(account.observedAt) || account.observedAt > now
    || account.dayStart !== operationalDayStart(account.observedAt)
    || !account.windows || typeof account.windows !== "object" || Array.isArray(account.windows)) return undefined;
  const windows: Record<string, WindowState> = {};
  for (const [key, raw] of Object.entries(account.windows as Record<string, unknown>)) {
    if (!key) return undefined;
    const window = parseWindow(raw, account.observedAt);
    if (!window) return undefined;
    windows[key] = window;
  }
  return Object.keys(windows).length ? { dayStart: account.dayStart, observedAt: account.observedAt, windows } : undefined;
}

export function codexAccountScope(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 24);
}

function validObservation(window: RateLimitWindow): window is RateLimitWindow & { key: string } {
  return typeof window.key === "string" && Boolean(window.key)
    && finite(window.used) && window.used >= 0 && window.used <= 1
    && (window.resetAt === undefined || finite(window.resetAt))
    && (window.durationMs === undefined || (finite(window.durationMs) && window.durationMs > 0));
}

/** Persist and decorate Codex snapshots with approximate quota consumed since 05:00 local time. */
export class CodexDailyUsage {
  private readonly file: string;
  private readonly now: () => number;
  private account: string | undefined;
  private state: AccountState | undefined;

  constructor(dir = CODEX_QUOTA_HISTORY_DIR, now = () => Date.now()) {
    this.file = join(dir, FILE);
    this.now = now;
  }

  /** Select an authenticated account and restore its latest state once, outside the render path. */
  selectAccount(accountId: string): void {
    const account = accountId ? codexAccountScope(accountId) : undefined;
    this.account = account;
    const read = account ? this.read() : undefined;
    this.state = read?.kind === "valid" ? read.history.accounts[account!] : undefined;
  }

  clearAccount(): void {
    this.account = undefined;
    this.state = undefined;
  }

  observe(accountId: string, limits: RateLimits, observedAt = this.now()): RateLimits {
    const observations = limits.filter(validObservation);
    if (!accountId || !finite(observedAt) || observedAt > this.now() || !observations.length) return limits;
    const account = codexAccountScope(accountId);
    if (account !== this.account) this.state = undefined;
    this.account = account;

    let release: (() => void) | undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      release = lockSync(this.file, { realpath: false, stale: LOCK_MS, retries: 0 });
    } catch {
      return this.decorate(limits);
    }

    try {
      const read = this.read();
      const history: HistoryFile = read.kind === "valid" ? read.history : { version: VERSION, accounts: {} };
      const current = history.accounts[this.account];
      const dayStart = operationalDayStart(observedAt);
      if (current && current.dayStart > dayStart) {
        this.state = current;
        return this.decorate(limits);
      }

      let windows: Record<string, WindowState> = {};
      if (current?.dayStart === dayStart) {
        windows = { ...current.windows };
      } else if (current?.dayStart === previousDayStart(dayStart)) {
        windows = Object.fromEntries(Object.entries(current.windows).map(([key, window]) => [key, {
          ...window,
          dailyUsed: 0,
        }]));
      }

      let changed = false;
      for (const observation of observations) {
        const previous = windows[observation.key];
        if (previous && observedAt <= previous.observedAt) continue;
        changed = true;
        if (!previous || previous.durationMs !== observation.durationMs) {
          windows[observation.key] = this.baseline(observation, observedAt);
          continue;
        }

        const resetChanged = previous.resetAt !== undefined && observation.resetAt !== undefined
          && previous.resetAt !== observation.resetAt;
        const crossedReset = resetChanged && observation.resetAt! > previous.resetAt!
          && observedAt >= previous.resetAt!;
        windows[observation.key] = {
          used: observation.used,
          dailyUsed: previous.dailyUsed + (crossedReset
            ? observation.used
            : Math.max(0, observation.used - previous.used)),
          observedAt,
          ...(observation.resetAt === undefined
            ? previous.resetAt === undefined ? {} : { resetAt: previous.resetAt }
            : { resetAt: observation.resetAt }),
          ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
        };
      }

      if (!changed && current?.dayStart === dayStart) {
        this.state = current;
        return this.decorate(limits);
      }
      const next: AccountState = {
        dayStart,
        observedAt: Math.max(observedAt, current?.dayStart === dayStart ? current.observedAt : 0),
        windows,
      };
      this.save({
        version: VERSION,
        accounts: { ...history.accounts, [this.account]: next },
      });
      this.state = next;
      return this.decorate(limits);
    } catch {
      return limits;
    } finally {
      try { release(); } catch { /* The lock may already have been recovered after a crash. */ }
    }
  }

  /** Add the selected account's daily values without reading disk on every render. */
  decorate(limits: RateLimits): RateLimits {
    const state = this.state;
    if (!state || !this.account || state.dayStart !== operationalDayStart(this.now())) return limits;
    return limits.map((window) => {
      const tracked = window.key ? state.windows[window.key] : undefined;
      if (!tracked
        || (tracked.durationMs !== undefined && window.durationMs !== undefined && tracked.durationMs !== window.durationMs)
        || (tracked.resetAt !== undefined && window.resetAt !== undefined && tracked.resetAt !== window.resetAt)) return window;
      return { ...window, dailyUsed: tracked.dailyUsed };
    });
  }

  private baseline(window: RateLimitWindow & { key: string }, observedAt: number): WindowState {
    return {
      used: window.used,
      dailyUsed: 0,
      observedAt,
      ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
      ...(window.durationMs === undefined ? {} : { durationMs: window.durationMs }),
    };
  }

  private read(): ReadResult {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
    }
    if (!value || typeof value !== "object") return { kind: "invalid" };
    const record = value as Record<string, unknown>;
    if (record.version !== VERSION || !record.accounts || typeof record.accounts !== "object" || Array.isArray(record.accounts)) return { kind: "invalid" };
    const accounts: Record<string, AccountState> = {};
    for (const [key, raw] of Object.entries(record.accounts as Record<string, unknown>)) {
      if (!key) return { kind: "invalid" };
      const account = parseAccount(raw, this.now());
      if (!account) return { kind: "invalid" };
      accounts[key] = account;
    }
    return Object.keys(accounts).length
      ? { kind: "valid", history: { version: VERSION, accounts } }
      : { kind: "invalid" };
  }

  private save(history: HistoryFile): void {
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(history)}\n`, "utf8");
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); } catch { /* The atomic rename already won. */ }
    }
  }
}
