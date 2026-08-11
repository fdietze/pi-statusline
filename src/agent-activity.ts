/** Versioned extension-bus protocol for aggregate background activity. */
export const AGENT_ACTIVITY_UPDATE_EVENT = "pi.agent-activity.v1:update";
export const AGENT_ACTIVITY_REQUEST_EVENT = "pi.agent-activity.v1:request";

export interface AgentActivitySourceUpdate {
  version: 1;
  source: string;
  /** Raw activity, independent from presentation settings. */
  active: boolean;
  /** Whether this source currently requests terminal OSC progress. */
  terminalProgress: boolean;
}

export interface AgentActivityAggregate {
  active: boolean;
  terminalProgress: boolean;
}

function parseUpdate(value: unknown): AgentActivitySourceUpdate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentActivitySourceUpdate>;
  if (
    candidate.version !== 1
    || typeof candidate.source !== "string"
    || candidate.source.length === 0
    || candidate.source.length > 128
    || typeof candidate.active !== "boolean"
    || typeof candidate.terminalProgress !== "boolean"
  ) return undefined;
  return candidate as AgentActivitySourceUpdate;
}

/** Local projection of all live sources; reset/query on every foreground session start. */
export class AgentActivitySources {
  private readonly sources = new Map<string, AgentActivitySourceUpdate>();

  update(value: unknown): boolean {
    const next = parseUpdate(value);
    if (!next) return false;
    const previous = this.sources.get(next.source);
    if (previous?.active === next.active && previous.terminalProgress === next.terminalProgress) return false;
    if (!next.active && !next.terminalProgress) this.sources.delete(next.source);
    else this.sources.set(next.source, next);
    return true;
  }

  clear(): boolean {
    if (this.sources.size === 0) return false;
    this.sources.clear();
    return true;
  }

  snapshot(): AgentActivityAggregate {
    let active = false;
    let terminalProgress = false;
    for (const source of this.sources.values()) {
      active ||= source.active;
      terminalProgress ||= source.terminalProgress;
      if (active && terminalProgress) break;
    }
    return { active, terminalProgress };
  }
}

export interface ProgressTerminal {
  setProgress(active: boolean): void;
  start?(...args: unknown[]): unknown;
}

interface TerminalProgressState {
  nativeActive: boolean;
  effectiveActive: boolean;
}

interface TerminalProgressOwnership {
  version: 1;
  release(): TerminalProgressState;
}

const TERMINAL_PROGRESS_OWNER = Symbol.for("futile.pi-statusline.terminal-progress-multiplexer.v1");
const readTerminalOwner = (terminal: ProgressTerminal): TerminalProgressOwnership | undefined => {
  const value = Reflect.get(terminal, TERMINAL_PROGRESS_OWNER) as Partial<TerminalProgressOwnership> | undefined;
  return value?.version === 1 && typeof value.release === "function"
    ? value as TerminalProgressOwnership
    : undefined;
};

/**
 * Arbitrates Pi's native foreground request with one aggregate external request while delegating
 * to the original Terminal implementation. ProcessTerminal therefore remains the sole OSC writer
 * and keepalive owner.
 */
export class TerminalProgressMultiplexer {
  private readonly terminal: ProgressTerminal;
  private readonly originalMethod: ProgressTerminal["setProgress"];
  private readonly wrappedMethod: ProgressTerminal["setProgress"];
  private readonly originalStart: ProgressTerminal["start"];
  private readonly wrappedStart: ProgressTerminal["start"];
  private readonly ownership: TerminalProgressOwnership = {
    version: 1,
    release: () => this.releaseForReplacement(),
  };
  private nativeActive = false;
  private externalActive = false;
  private appliedActive = false;
  private disposed = false;

  constructor(terminal: ProgressTerminal, initialNativeActive = false) {
    this.terminal = terminal;
    const previous = readTerminalOwner(terminal)?.release();
    this.nativeActive = initialNativeActive || previous?.nativeActive === true;
    // Preserve the physical state until the replacement receives the current external snapshot.
    this.appliedActive = previous?.effectiveActive ?? this.nativeActive;
    this.originalMethod = terminal.setProgress;
    this.originalStart = terminal.start;
    this.wrappedMethod = (active: boolean) => {
      if (this.disposed) {
        const current = this.terminal.setProgress;
        (current === this.wrappedMethod ? this.originalMethod : current).call(this.terminal, active);
        return;
      }
      this.nativeActive = active;
      this.reconcile();
    };
    this.wrappedStart = this.originalStart
      ? (...args: unknown[]) => {
        if (this.disposed) {
          const current = this.terminal.start;
          if (current && current !== this.wrappedStart) return current.apply(this.terminal, args);
        }
        const result = this.originalStart!.apply(this.terminal, args);
        this.reassert();
        return result;
      }
      : undefined;
    terminal.setProgress = this.wrappedMethod;
    if (this.wrappedStart) terminal.start = this.wrappedStart;
    Reflect.set(terminal, TERMINAL_PROGRESS_OWNER, this.ownership);
  }

  setExternal(active: boolean): void {
    if (this.disposed) return;
    this.externalActive = active;
    this.reconcile();
  }

  /** Restart the underlying transport after Pi starts a replacement renderer. */
  reassert(): void {
    if (this.disposed || !(this.nativeActive || this.externalActive)) return;
    this.originalMethod.call(this.terminal, true);
  }

  private reconcile(): void {
    const effective = this.nativeActive || this.externalActive;
    if (effective === this.appliedActive) return;
    this.appliedActive = effective;
    this.originalMethod.call(this.terminal, effective);
  }

  private ownsTerminal(): boolean {
    return readTerminalOwner(this.terminal) === this.ownership;
  }

  private restoreMethods(): void {
    if (this.terminal.setProgress === this.wrappedMethod) this.terminal.setProgress = this.originalMethod;
    if (this.wrappedStart && this.terminal.start === this.wrappedStart) this.terminal.start = this.originalStart;
  }

  private releaseForReplacement(): TerminalProgressState {
    const state = {
      nativeActive: this.nativeActive,
      effectiveActive: this.nativeActive || this.externalActive,
    };
    if (this.disposed) return state;
    this.disposed = true;
    if (this.ownsTerminal()) {
      this.restoreMethods();
      Reflect.deleteProperty(this.terminal, TERMINAL_PROGRESS_OWNER);
    }
    return state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ownsTerminal()) return;
    this.restoreMethods();
    Reflect.deleteProperty(this.terminal, TERMINAL_PROGRESS_OWNER);
    // Remove only our external contribution; preserve Pi's last native request.
    if (this.appliedActive !== this.nativeActive) {
      this.appliedActive = this.nativeActive;
      this.originalMethod.call(this.terminal, this.nativeActive);
    }
  }
}
