export interface TokenUsage {
  input: number;
  output: number;
}

export type ThroughputLevel = "muted" | "success" | "warning" | "error";

export interface MeterSnapshot {
  inputRate?: number;
  outputRate?: number;
  inputLevel?: ThroughputLevel;
  outputLevel?: ThroughputLevel;
  activeMs: number;
  elapsedMs: number;
  lastTurnMs?: number;
  /** Elapsed ms since turn start while no output has streamed yet (prompt processing). */
  waitingMs?: number;
  /** Rolling average over recent finished turns (smooths out single-turn noise). */
  avgInputRate?: number;
  avgOutputRate?: number;
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

export function rateLevel(rate: number, history: number[], output = false): ThroughputLevel {
  if (output && rate <= 15) return "error";
  if (history.length < 3) return "muted";
  const baseline = history.reduce((sum, value) => sum + value, 0) / history.length;
  return rate >= baseline * 0.9 ? "success" : rate >= baseline * 0.6 ? "warning" : "error";
}

function fallbackRate(tokens: number, measuredMs: number, turnMs: number): number {
  const duration = measuredMs > 0 ? measuredMs : turnMs;
  return duration > 0 ? tokens / (duration / 1_000) : 0;
}

// Providers that omit token usage (many local servers, e.g. llama.cpp, never report it)
// leave counts at 0. Approximate from response text so throughput isn't stuck at 0 t/s.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return chars > 0 ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN)) : 0;
}

export function sumTextLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + sumTextLength(item), 0);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce((sum, [key, part]) => {
      if ((key === "text" || key === "thinking") && typeof part === "string") return sum + part.length;
      if (key === "content") return sum + sumTextLength(part);
      return sum;
    }, 0);
  }
  return 0;
}

export class TurnMeter {
  private readonly clock: () => number;
  private sessionStartedAt: number;
  private turnStartedAt?: number;
  private firstUpdateAt?: number;
  private messageEndedAt?: number;
  private inputRate?: number;
  private outputRate?: number;
  private inputLevel?: ThroughputLevel;
  private outputLevel?: ThroughputLevel;
  private inputHistory: number[] = [];
  private outputHistory: number[] = [];
  private activeMs = 0;
  private activeStartedAt?: number;
  private lastTurnMs?: number;
  private liveOutputChars = 0;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.sessionStartedAt = clock();
  }

  resetSession(at = this.clock()): void {
    this.sessionStartedAt = at;
    this.turnStartedAt = undefined;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.resetThroughput();
    this.activeMs = 0;
    this.activeStartedAt = undefined;
    this.lastTurnMs = undefined;
  }

  resetThroughput(): void {
    this.inputHistory = [];
    this.outputHistory = [];
    this.inputRate = undefined;
    this.outputRate = undefined;
    this.inputLevel = undefined;
    this.outputLevel = undefined;
  }

  startTurn(at = this.clock()): void {
    this.turnStartedAt = at;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.inputRate = undefined;
    this.outputRate = undefined;
    this.inputLevel = undefined;
    this.outputLevel = undefined;
    this.liveOutputChars = 0;
  }

  markFirstUpdate(at = this.clock()): void {
    this.firstUpdateAt ??= at;
  }

  /** Running character count of the streamed assistant message, for a live rate while the turn is active. */
  updateOutputChars(chars: number): void {
    this.liveOutputChars = chars;
  }

  markMessageEnd(at = this.clock()): void {
    this.messageEndedAt = at;
  }

  liveElapsedMs(at = this.clock()): number {
    return this.turnStartedAt === undefined ? 0 : Math.max(0, at - this.turnStartedAt);
  }

  /** Live portion of union wall-clock activity; independent from foreground turn timing. */
  liveActiveMs(at = this.clock()): number {
    return this.activeStartedAt === undefined ? 0 : Math.max(0, at - this.activeStartedAt);
  }

  /** Transition-based union accounting: repeated/overlapping starts and stops are idempotent. */
  setActive(active: boolean, at = this.clock()): void {
    if (active) {
      this.activeStartedAt ??= at;
      return;
    }
    if (this.activeStartedAt === undefined) return;
    this.activeMs += Math.max(0, at - this.activeStartedAt);
    this.activeStartedAt = undefined;
  }

  finalizeActiveTurn(at = this.clock()): void {
    if (this.turnStartedAt === undefined) return;
    const duration = this.liveElapsedMs(at);
    this.lastTurnMs = duration;
    this.turnStartedAt = undefined;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.liveOutputChars = 0;
  }

  finishTurn(usage: TokenUsage, at = this.clock()): void {
    if (this.turnStartedAt === undefined) return;
    const duration = Math.max(0, at - this.turnStartedAt);
    this.lastTurnMs = duration;

    const inputMs = this.firstUpdateAt === undefined ? 0 : this.firstUpdateAt - this.turnStartedAt;
    const outputMs = this.firstUpdateAt === undefined || this.messageEndedAt === undefined
      ? 0
      : this.messageEndedAt - this.firstUpdateAt;
    this.inputRate = fallbackRate(usage.input, inputMs, duration);
    this.outputRate = fallbackRate(usage.output, outputMs, duration);
    this.inputLevel = rateLevel(this.inputRate, this.inputHistory);
    this.outputLevel = rateLevel(this.outputRate, this.outputHistory, true);
    this.inputHistory.push(this.inputRate);
    this.outputHistory.push(this.outputRate);
    if (this.inputHistory.length > 5) this.inputHistory.shift();
    if (this.outputHistory.length > 5) this.outputHistory.shift();
    this.turnStartedAt = undefined;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.liveOutputChars = 0;
  }

  snapshot(now = this.clock()): MeterSnapshot {
    const turnRunning = this.turnStartedAt !== undefined;
    const waitingMs = turnRunning && this.firstUpdateAt === undefined
      ? Math.max(0, now - this.turnStartedAt!)
      : undefined;
    // While streaming, override the last-turn rate with a live one so the UI updates continuously
    // instead of freezing until the turn finishes.
    const liveOutputRate = turnRunning && this.firstUpdateAt !== undefined
      ? fallbackRate(estimateTokens(this.liveOutputChars), now - this.firstUpdateAt, 0)
      : undefined;
    return {
      inputRate: this.inputRate,
      outputRate: liveOutputRate ?? this.outputRate,
      inputLevel: this.inputLevel,
      outputLevel: liveOutputRate !== undefined ? rateLevel(liveOutputRate, this.outputHistory, true) : this.outputLevel,
      activeMs: this.activeMs,
      elapsedMs: Math.max(0, now - this.sessionStartedAt),
      lastTurnMs: this.lastTurnMs,
      waitingMs,
      avgInputRate: average(this.inputHistory),
      avgOutputRate: average(this.outputHistory),
    };
  }
}
