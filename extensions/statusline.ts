import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import {
  AGENT_ACTIVITY_REQUEST_EVENT,
  AGENT_ACTIVITY_UPDATE_EVENT,
  AgentActivitySources,
  TerminalProgressMultiplexer,
  type ProgressTerminal,
} from "../src/agent-activity.ts";
import { codexAccountScope, CodexDailyUsage, CODEX_QUOTA_HISTORY_DIR } from "../src/codex-daily.ts";
import { billingMode, isLocalEndpoint } from "../src/derive.ts";
import { formatResetCountdown, formatTime } from "../src/format.ts";
import { parseGitStatus, type GitStatusState } from "../src/git.ts";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, parseZaiUsage, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { ProviderRefreshCoordinator, RateLimitedError, type ProviderAdapter } from "../src/providers.ts";
import { renderMainLine, renderProviderRows, providerHasRow, type ExtensionStatus, type ProviderRowSource } from "../src/render.ts";
import { estimateTokens, sumTextLength, TurnMeter } from "../src/throughput.ts";
import {
  DEFAULT_STATUSLINE_CONFIG_PATH,
  configuredProviders,
  loadRuntimeSettings,
  reconcileProviders,
} from "../src/settings/runtime.ts";
import type { ResolutionContext } from "../src/settings/resolve.ts";
import { saveStatuslineSettings } from "../src/settings/storage.ts";
import { createSettingsUi, renderSettingsWindow, resolveDirtyChoice, routeSettingsKey } from "../src/settings/ui.ts";
import type { ProviderUiContext } from "../src/settings/provider-ui.ts";
import { discoverProviders, type ModelRegistryLike } from "../src/settings/providers/discovery.ts";
import { deriveCapability, type ProviderCapability } from "../src/settings/providers/capabilities.ts";
import type { RefreshHealth } from "../src/settings/refresh.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";

// Anthropic's OAuth usage endpoint (api.anthropic.com/api/oauth/usage) throttles hard and hands
// out sticky 429s, so poll it less often than the 10s cadence the other providers share.
const ANTHROPIC_REFRESH_MS = 30_000;

export default function statusline(
  pi: ExtensionAPI,
  providerUsageCache = new ProviderUsageCache(undefined, undefined, undefined, undefined, { anthropic: ANTHROPIC_REFRESH_MS }),
  settingsPath = DEFAULT_STATUSLINE_CONFIG_PATH,
  codexDailyUsage = new CodexDailyUsage(
    settingsPath === DEFAULT_STATUSLINE_CONFIG_PATH
      ? CODEX_QUOTA_HISTORY_DIR
      : join(dirname(settingsPath), "quota-history"),
  ),
) {
  let settings: StatuslineSettings = loadRuntimeSettings(settingsPath);
  let meter = new TurnMeter();
  let limits: RateLimits = [];
  let gitStatus: GitStatusState | undefined;
  const ANTHROPIC_LIMITS_ENTRY = "pi-statusline:anthropic-limits";
  let requestRender: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let gitTick: ReturnType<typeof setInterval> | undefined;
  let anthropicRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastContextChars = 0;
  let lastRenderedTime = "";
  let sessionActive = false;
  let sessionEpoch = 0;
  let turnActive = false;
  let backgroundActive = false;
  const activitySources = new AgentActivitySources();
  let progressTerminal: ProgressTerminal | undefined;
  let progressMultiplexer: TerminalProgressMultiplexer | undefined;
  // Live footer-only values captured so the settings preview can show the same HUD and statuses.
  let liveGitBranch: string | null | undefined;
  let liveExtensionStatuses: ExtensionStatus[] = [];
  // True while the settings overlay is open; keeps commitSettings from flashing the live footer.
  let settingsOverlayOpen = false;
  let providerRefresh: ProviderRefreshCoordinator | undefined;
  let codexCacheScope: string | undefined;
  // Pi serializes provider requests within a session, so one in-flight scope is sufficient.
  let codexProviderRequestScope: string | undefined;
  let codexProviderRequestEpoch = 0;
  let codexAccountGeneration = 0;
  const isCurrentSession = (epoch: number) => sessionActive && epoch === sessionEpoch;
  const ANTHROPIC_RETRY_DELAYS_MS = [1_500, 3_000];

  const timeLabel = () => {
    const snapshot = meter.snapshot();
    const liveMs = meter.liveActiveMs();
    return snapshot.activeMs === 0 && liveMs === 0 && snapshot.lastTurnMs === undefined
      ? ""
      : formatTime(
        snapshot.activeMs + liveMs,
        settings.extras.sessionElapsed ? snapshot.elapsedMs : undefined,
        settings.extras.lastTurn ? snapshot.lastTurnMs : undefined,
      );
  };
  const tickLabel = (time = timeLabel()) => `${time}|${limits.map((limit) =>
    limit.resetAt === undefined ? "" : formatResetCountdown(limit.resetAt)
  ).join("|")}`;
  const hasUpcomingReset = () => limits.some((limit) => limit.resetAt !== undefined && limit.resetAt > Date.now());
  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = undefined;
    lastRenderedTime = "";
  };
  const startTick = () => {
    stopTick();
    lastRenderedTime = tickLabel();
    tick = setInterval(() => {
      const next = tickLabel();
      if (next !== lastRenderedTime) {
        lastRenderedTime = next;
        requestRender?.();
      }
      const workNeedsTick = (settings.segments.time && (turnActive || backgroundActive))
        || (settings.segments.throughput && turnActive);
      if (!workNeedsTick && !hasUpcomingReset()) stopTick();
    }, 1_000);
    tick.unref?.();
  };
  const syncTick = () => {
    const shouldTick = sessionActive && settings.enabled
      && ((settings.segments.time && (turnActive || backgroundActive))
        || (settings.segments.throughput && turnActive)
        || (settings.segments.session && hasUpcomingReset()));
    if (shouldTick && !tick) startTick();
    else if (!shouldTick && tick) stopTick();
  };

  const syncAggregateActivity = (at?: number) => {
    meter.setActive(turnActive || backgroundActive, at);
    syncTick();
    requestRender?.();
  };
  const disposeProgressMultiplexer = () => {
    progressMultiplexer?.dispose();
    progressMultiplexer = undefined;
    progressTerminal = undefined;
  };
  const ensureProgressMultiplexer = (terminal: ProgressTerminal | undefined, initialNativeActive = false) => {
    if (!terminal || terminal === progressTerminal) return;
    disposeProgressMultiplexer();
    progressTerminal = terminal;
    progressMultiplexer = new TerminalProgressMultiplexer(terminal, initialNativeActive);
    progressMultiplexer.setExternal(activitySources.snapshot().terminalProgress);
  };
  type ExtensionEventBus = {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
  const extensionEvents = (pi as unknown as { events?: ExtensionEventBus }).events;
  extensionEvents?.on(AGENT_ACTIVITY_UPDATE_EVENT, (data) => {
    if (!activitySources.update(data)) return;
    const aggregate = activitySources.snapshot();
    backgroundActive = aggregate.active;
    progressMultiplexer?.setExternal(aggregate.terminalProgress);
    syncAggregateActivity();
  });

  const refreshGit = async (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch)) return;
    if (!settings.extras.branch) {
      gitStatus = undefined;
      return;
    }
    try {
      const result = await pi.exec("git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: ctx.cwd, timeout: 2_000 });
      if (!isCurrentSession(epoch)) return;
      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : "error";
    } catch {
      if (!isCurrentSession(epoch)) return;
      gitStatus = "error";
    }
    requestRender?.();
  };

  const stopGitTick = () => {
    if (gitTick) clearInterval(gitTick);
    gitTick = undefined;
  };
  const syncGitTick = (ctx: ExtensionContext, epoch = sessionEpoch) => {
    const shouldTick = isCurrentSession(epoch) && settings.enabled && settings.extras.branch;
    if (shouldTick && !gitTick) {
      gitTick = setInterval(() => void refreshGit(ctx, epoch), 10_000);
      gitTick.unref?.();
    } else if (!shouldTick) stopGitTick();
  };

  const stopAnthropicRetry = () => {
    if (anthropicRetryTimer) clearTimeout(anthropicRetryTimer);
    anthropicRetryTimer = undefined;
  };
  const scheduleAnthropicRetry = (ctx: ExtensionContext, attempt = 0, epoch = sessionEpoch) => {
    stopAnthropicRetry();
    if (!isCurrentSession(epoch) || attempt >= ANTHROPIC_RETRY_DELAYS_MS.length) return;
    anthropicRetryTimer = setTimeout(() => {
      anthropicRetryTimer = undefined;
      if (!isCurrentSession(epoch) || limits.length || !isAnthropicOAuth(ctx)) return;
      void refreshAnthropicLimits(ctx, epoch).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx, attempt + 1, epoch); });
    }, ANTHROPIC_RETRY_DELAYS_MS[attempt]);
    anthropicRetryTimer.unref?.();
  };

  const isAnthropicOAuth = (ctx: ExtensionContext) =>
    ctx.model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(ctx.model);

  // The active model's provider, not necessarily configured/authenticated, is irrelevant here:
  // provider-tracking rows need usage for every *selected* provider, so resolve each provider's
  // own model from the registry instead of assuming it's the one currently in use.
  const findAvailableModel = (ctx: ExtensionContext, provider: string) =>
    ctx.modelRegistry.getAvailable().find((model) => model.provider === provider);

  const codexAccountId = (token: string): string | undefined => {
    try {
      const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
      const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
    } catch {
      return undefined;
    }
  };

  const restoreAnthropicLimits = (ctx: ExtensionContext): RateLimits => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type === "custom" && entry.customType === ANTHROPIC_LIMITS_ENTRY) {
        return parseStoredRateLimits(entry.data);
      }
    }
    return [];
  };

  // Pure provider-scoped fetch: no side effects on the active session's `limits`/tick/persisted
  // entry, so it's safe to call for a provider that isn't the currently active model. The
  // provider-tracking rows need every *selected* provider's usage simultaneously, not just
  // whichever one you happen to be talking to right now.
  const fetchAnthropicUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>): Promise<RateLimits> => {
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return [];
    try {
      const access = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
      if (!access) return [];
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${access}`,
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "pi-statusline",
        },
        signal: AbortSignal.timeout(3_000),
      });
      // 429: surface to the provider-usage cache so every session and every caller backs off
      // instead of re-hammering the endpoint each refresh (Anthropic's retry-after: 0 is useless).
      if (response.status === 429) throw new RateLimitedError();
      if (!response.ok) return [];
      return parseAnthropicUsage(await response.json());
    } catch (error) {
      // Best effort: unavailable account usage falls back to response headers — but let the 429
      // signal through so the cache can apply its shared backoff.
      if (error instanceof RateLimitedError) throw error;
      return [];
    }
  };

  // Undocumented by Z.AI (see src/ratelimit.ts parseZaiUsage), used anyway at the user's request.
  const fetchZaiUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>): Promise<RateLimits> => {
    if (!model) return [];
    try {
      const access = await ctx.modelRegistry.getApiKeyForProvider("zai");
      if (!access) return [];
      const response = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
        headers: { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "pi-statusline" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return [];
      return parseZaiUsage(await response.json());
    } catch {
      return [];
    }
  };

  const codexCredentials = async (ctx: ExtensionContext) => {
    try {
      const access = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
      const accountId = access ? codexAccountId(access) : undefined;
      return access && accountId ? { access, accountId } : undefined;
    } catch {
      return undefined;
    }
  };

  const fetchCodexUsage = async (
    model: ReturnType<typeof findAvailableModel>,
    credentials: { access: string; accountId: string },
  ): Promise<RateLimits> => {
    if (!model?.baseUrl) return [];
    try {
      const origin = new URL(model.baseUrl).origin;
      const response = await fetch(`${origin}/backend-api/wham/usage`, {
        headers: {
          authorization: `Bearer ${credentials.access}`,
          "chatgpt-account-id": credentials.accountId,
          originator: "pi",
        },
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok ? parseCodexUsage(await response.json()) : [];
    } catch {
      return [];
    }
  };

  const refreshProviderUsage = (provider: string, fetchLimits: () => Promise<RateLimits>, scope?: string) =>
    providerUsageCache.refresh(provider, async () => {
      const next = await fetchLimits();
      return next.length ? { limits: next } : undefined;
    }, scope);

  const selectCodexAccount = (credentials: { accountId: string }, activeCodex: boolean) => {
    const scope = codexAccountScope(credentials.accountId);
    if (scope !== codexCacheScope) {
      codexCacheScope = scope;
      codexAccountGeneration++;
      codexProviderRequestEpoch++;
      if (activeCodex) {
        limits = [];
        syncTick();
      }
      providerRefresh?.invalidate("openai-codex");
    }
    codexDailyUsage.selectAccount(credentials.accountId);
    return { scope, generation: codexAccountGeneration };
  };

  const clearCodexAccount = (activeCodex: boolean) => {
    if (codexCacheScope !== undefined) {
      codexAccountGeneration++;
      codexProviderRequestEpoch++;
      if (activeCodex) {
        limits = [];
        syncTick();
      }
      providerRefresh?.invalidate("openai-codex");
    }
    codexCacheScope = undefined;
    codexDailyUsage.clearAccount();
  };

  const refreshCodexProviderUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>) => {
    const credentials = await codexCredentials(ctx);
    const activeCodex = ctx.model?.provider === "openai-codex";
    if (!credentials) {
      clearCodexAccount(activeCodex);
      return undefined;
    }
    const selected = selectCodexAccount(credentials, activeCodex);
    const usage = await refreshProviderUsage("openai-codex", async () => {
      const next = await fetchCodexUsage(model, credentials);
      if (selected.generation !== codexAccountGeneration || selected.scope !== codexCacheScope) return [];
      return codexDailyUsage.observe(credentials.accountId, next);
    }, selected.scope);
    return selected.generation === codexAccountGeneration && selected.scope === codexCacheScope ? usage : undefined;
  };

  // Active-session wrappers: only apply fetched usage to the shared `limits`/tick/persisted entry
  // when the fetched provider is actually the active model, so a background provider-tracking
  // fetch for a different provider never clobbers what the session line shows.
  const refreshAnthropicLimits = async (ctx: ExtensionContext, epoch = sessionEpoch): Promise<RateLimits> => {
    if (!isCurrentSession(epoch) || !isAnthropicOAuth(ctx)) return [];
    const usage = await refreshProviderUsage("anthropic", () => fetchAnthropicUsage(ctx, ctx.model));
    const next = usage?.limits ?? [];
    if (!next.length || !isCurrentSession(epoch) || !isAnthropicOAuth(ctx)) return [];
    limits = next;
    pi.appendEntry(ANTHROPIC_LIMITS_ENTRY, limits);
    syncTick();
    requestRender?.();
    return next;
  };

  const refreshCodexLimits = async (ctx: ExtensionContext, epoch = sessionEpoch): Promise<RateLimits> => {
    if (!isCurrentSession(epoch) || ctx.model?.provider !== "openai-codex") return [];
    const usage = await refreshCodexProviderUsage(ctx, ctx.model);
    const next = usage?.limits ?? [];
    if (!next.length || !isCurrentSession(epoch) || ctx.model?.provider !== "openai-codex") return [];
    limits = next;
    syncTick();
    requestRender?.();
    return next;
  };

  // Sum token usage across the session's assistant messages. "input" folds cached and
  // cache-write tokens into the prompt total; cost.total already reflects the cache discount.
  const sessionTotals = (ctx: ExtensionContext): { input: number; output: number; cost: number } => {
    let input = 0, output = 0, cost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const usage = (entry.message as AssistantMessage).usage;
        input += usage.input + usage.cacheRead + usage.cacheWrite;
        output += usage.output;
        cost += usage.cost.total;
      }
    }
    return { input, output, cost };
  };

  const installFooter = (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch)) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      ensureProgressMultiplexer(
        (tui as unknown as { terminal?: ProgressTerminal }).terminal,
        typeof ctx.isIdle === "function" && !ctx.isIdle(),
      );
      const unsubscribe = footerData.onBranchChange(() => {
        gitStatus = undefined;
        tui.requestRender();
        void refreshGit(ctx, epoch);
      });
      return {
        dispose() {
          unsubscribe();
          stopTick();
          stopGitTick();
          stopAnthropicRetry();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const edge = width >= 2 ? " " : "";
          const contentWidth = width - edge.length * 2;
          const provider = ctx.model?.provider;
          const subscription = ctx.model !== undefined
            && (ctx.model.provider === "openai-codex" || ctx.modelRegistry.isUsingOAuth(ctx.model));
          const mode = billingMode(isLocalEndpoint(ctx.model?.baseUrl), subscription);
          // Walk the branch for totals only when something actually shows them (opt-in cost, or the
          // API token ledger while idle), not on every render tick.
          const needTotals = settings.extras.cost || (mode === "api" && !turnActive);
          const totals = needTotals ? sessionTotals(ctx) : undefined;
          const snapshot = meter.snapshot();
          // Provider-tracking rows share the settings-preview renderer (renderProviderRows) so the
          // multi-line footer and the in-app preview can never drift. Sources are built here from
          // live refresh health; per-window display (visible/bar/percent/reset/label/width) is read
          // from settings inside the shared renderer, keyed by each window's stable adapter key.
          const sources: ProviderRowSource[] = settings.providers.enabled ? settings.providers.order.flatMap((p) => {
            const record = settings.providers.records[p];
            if (!record?.enabled) return [];
            const health = providerRefresh?.get(p);
            if (health?.state === "fresh") return [{
              provider: p,
              windows: p === "openai-codex" ? codexDailyUsage.decorate(health.usage.limits) : health.usage.limits,
            }];
            // Before a subscription provider's usage loads, anthropic+OAuth earns a placeholder row.
            if (p === "anthropic") {
              const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> };
              const model = registry.getAvailable ? findAvailableModel(ctx, p) : undefined;
              if (model && ctx.modelRegistry.isUsingOAuth(model)) return [{ provider: p, windows: [], placeholder: "5h — wk —" }];
            }
            return [];
          }) : [];
          const activeProviderHasRow = providerHasRow(settings, sources, provider);
          const sessionPlaceholder = !activeProviderHasRow && provider === "anthropic" && ctx.model !== undefined && ctx.modelRegistry.isUsingOAuth(ctx.model)
            ? theme.fg("muted", "5h — wk —")
            : "";
          // Query on every render so ctx.ui.setStatus() changes are reflected immediately. The
          // optional fallback keeps the fork loadable on older Pi versions without FooterData.
          liveExtensionStatuses = [...(footerData.getExtensionStatuses?.() ?? new Map<string, string>())]
            .map(([key, value]) => ({ key, value }));
          lastRenderedTime = tickLabel();
          const line = renderMainLine(settings, {
            cwd: ctx.cwd,
            model: ctx.model,
            thinkingLevel: pi.getThinkingLevel(),
            contextUsage: ctx.getContextUsage(),
            extensionStatuses: liveExtensionStatuses,
            gitBranch: (liveGitBranch = footerData.getGitBranch()),
            gitStatus,
            pending: ctx.hasPendingMessages(),
            subscription,
            turnActive,
            meter: { ...snapshot, activeMs: snapshot.activeMs + meter.liveActiveMs() },
            lastContextChars,
            totals,
            sessionWindows: provider === "openai-codex" ? codexDailyUsage.decorate(limits) : limits,
            activeProviderHasRow,
            sessionPlaceholder,
          }, contentWidth, theme);
          const providerRowLines = renderProviderRows(settings, sources, theme, Date.now());
          return [line, ...providerRowLines.map((rowLine) => truncateToWidth(rowLine, contentWidth, ""))]
            .map((rowLine) => `${edge}${rowLine}${edge}`);
        },
      };
    });
    syncTick();
  };

  const availableProviders = (ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> } | undefined;
    return registry?.getAvailable ? configuredProviders(registry as { getAvailable(): Array<{ provider: string }> }) : [];
  };

  // One-shot discovery/capability snapshot for the settings app. Rendering never re-discovers or
  // refreshes: the snapshot freezes at open time, so reopening the command picks up new providers.
  const buildProviderContext = (ctx: ExtensionContext): ProviderUiContext => {
    const registry = ctx.modelRegistry as unknown as ModelRegistryLike & { getRegisteredProviderIds?: () => string[] };
    const descriptors = typeof registry?.getAvailable === "function"
      ? discoverProviders(registry, {
        activeProvider: ctx.model?.provider,
        storedProviders: settings.providers.order,
        storedRecords: settings.providers.records,
        registeredProviders: typeof registry.getRegisteredProviderIds === "function" ? registry.getRegisteredProviderIds() : undefined,
      })
      : [];
    const capabilities: Record<string, ProviderCapability> = {};
    const health: Record<string, RefreshHealth> = {};
    const windows: Record<string, RateLimitWindow[]> = {};
    for (const descriptor of descriptors) {
      const model = findAvailableModel(ctx, descriptor.id);
      let oauth = false;
      try { oauth = Boolean(model && ctx.modelRegistry.isUsingOAuth(model)); } catch { oauth = false; }
      capabilities[descriptor.id] = deriveCapability(descriptor, { oauth });
      const snapshot = providerRefresh?.get(descriptor.id);
      if (snapshot?.state === "fresh") {
        health[descriptor.id] = { state: "fresh" };
        windows[descriptor.id] = descriptor.id === "openai-codex"
          ? codexDailyUsage.decorate(snapshot.usage.limits)
          : snapshot.usage.limits;
      } else if (snapshot) {
        health[descriptor.id] = { state: "unknown" };
      }
    }
    return { descriptors, capabilities, health, windows, activeProvider: ctx.model?.provider };
  };

  // Raw terminal input -> the semantic key names routeSettingsKey understands.
  const ROUTE_KEYS: Record<string, string> = {
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    enter: "Enter", escape: "Escape", home: "Home", end: "End", space: " ", backspace: "Backspace",
    "ctrl+up": "Ctrl+Up", "ctrl+down": "Ctrl+Down",
  };
  const translateKey = (data: string): string | undefined => {
    const parsed = parseKey(data);
    if (!parsed) return undefined;
    if (parsed in ROUTE_KEYS) return ROUTE_KEYS[parsed];
    return parsed.length === 1 ? parsed : undefined; // printable char, else ignore
  };

  // Persist the draft first (throws => nothing applied), then swap in-memory settings atomically and
  // reconfigure the live runtime once. Reconcile pulls in providers authenticated since load.
  const commitSettings = (draft: StatuslineSettings, ctx: ExtensionContext) => {
    const next = availableProviders(ctx).length ? reconcileProviders(draft, ctx.modelRegistry) : draft;
    saveStatuslineSettings(next, settingsPath);
    settings = next;
    // While the settings overlay is open the live footer is intentionally hidden (the in-app
    // preview stands in); skip re-installing it here so it doesn't flash behind the overlay.
    // The close handler restores it based on the final `settings.enabled`.
    if (!settingsOverlayOpen) {
      if (settings.enabled) installFooter(ctx);
      else ctx.ui.setFooter(undefined);
    }
    syncTick();
    syncGitTick(ctx);
    void refreshGit(ctx);
    requestRender?.();
  };

  const openSettingsApp = (ctx: ExtensionContext) => {
    const providers = buildProviderContext(ctx);
    const previewCapability = ctx.model?.provider ? providers.capabilities[ctx.model.provider] : undefined;
    // Live snapshot of the current session, fed to the in-app preview so it shows exactly what the
    // footer will look like under the DRAFT settings (cwd, model, context, quota, ticking clock).
    // Reads the draft (not the committed settings) so toggling extras like cost / session-elapsed /
    // last-turn is visible before saving — the preview is a live reflection of the draft.
    const currentPreviewContext = (draft: StatuslineSettings): ResolutionContext => {
      const snapshot = meter.snapshot();
      const subscription = ctx.model !== undefined
        && (ctx.model.provider === "openai-codex" || ctx.modelRegistry.isUsingOAuth(ctx.model));
      const mode = billingMode(isLocalEndpoint(ctx.model?.baseUrl), subscription);
      // Mirror the footer's own render inputs so the "current" preview is byte-identical to the
      // live main line under the draft settings (git HUD, ledger, quota, ticking clock, theme).
      const needTotals = draft.extras.cost || (mode === "api" && !turnActive);
      const totals = needTotals ? sessionTotals(ctx) : undefined;
      return {
        capability: previewCapability,
        runtime: {
          cwd: ctx.cwd,
          model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, reasoning: ctx.model.reasoning, baseUrl: ctx.model.baseUrl } : undefined,
          activeProvider: ctx.model?.provider,
          thinkingLevel: pi.getThinkingLevel(),
          contextUsage: ctx.getContextUsage() ?? undefined,
          extensionStatuses: liveExtensionStatuses,
          throughput: { inputRate: snapshot.avgInputRate, outputRate: snapshot.avgOutputRate },
          sessionWindows: limits,
          activeMs: snapshot.activeMs + meter.liveActiveMs(),
          elapsedMs: draft.extras.sessionElapsed ? snapshot.elapsedMs : undefined,
          lastTurnMs: draft.extras.lastTurn ? snapshot.lastTurnMs : undefined,
          gitBranch: liveGitBranch,
          gitStatus,
          pending: ctx.hasPendingMessages(),
          subscription,
          turnActive,
          lastContextChars,
          totals,
        },
      };
    };
    // The live footer would duplicate the preview's clock; hide it while settings are open so there
    // is exactly one statusline on screen — the interactive preview. Restored on close.
    const footerWasEnabled = settings.enabled;
    settingsOverlayOpen = true;
    if (footerWasEnabled) ctx.ui.setFooter(undefined);
    return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      let state = createSettingsUi(settings);
      let finished = false;
      // Re-render every second so the preview's clock ticks live (the footer's own tick is gone).
      const previewTick = setInterval(() => tui.requestRender(), 1_000);
      previewTick.unref?.();
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(previewTick);
        settingsOverlayOpen = false;
        if (settings.enabled) installFooter(ctx);
        else ctx.ui.setFooter(undefined);
        done();
      };
      return {
        invalidate() {},
        dispose() { clearInterval(previewTick); },
        render: (width: number) => {
          const rows = tui.terminal?.rows;
          return renderSettingsWindow(state, { width, providers, viewportRows: rows ? rows - 2 : undefined, current: currentPreviewContext(state.draft), theme });
        },
        handleInput(data: string) {
          const key = translateKey(data);
          if (!key) return;
          if (state.confirmClose) {
            const choice = key === "s" || key === "S" ? "save"
              : key === "d" || key === "D" ? "discard"
              : key === "c" || key === "C" || key === "Escape" ? "cancel"
              : undefined;
            if (!choice) return;
            void resolveDirtyChoice(state, choice, (draft) => commitSettings(draft, ctx)).then((result) => {
              state = result.state;
              if (result.action === "close") finish();
              tui.requestRender();
            });
            return;
          }
          const result = routeSettingsKey(state, key, providers);
          state = result.state;
          if (result.effect?.type === "refresh-provider") void providerRefresh?.refresh(result.effect.providerId);
          if (result.action === "close") finish();
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "80%", anchor: "center", margin: 1 },
    });
  };

  pi.registerCommand("statusline", {
    description: "Open the interactive statusline settings",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Statusline settings require the interactive terminal UI.", "info");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("/statusline takes no arguments \u2014 run it with no arguments to open settings.", "warning");
        return;
      }
      await openSettingsApp(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++sessionEpoch;
    sessionActive = true;
    turnActive = false;
    backgroundActive = false;
    activitySources.clear();
    codexAccountGeneration++;
    codexCacheScope = undefined;
    codexDailyUsage.clearAccount();
    disposeProgressMultiplexer();
    stopTick();
    stopAnthropicRetry();
    settings = loadRuntimeSettings(settingsPath);
    if (availableProviders(ctx).length) settings = reconcileProviders(settings, ctx.modelRegistry);
    const providers = availableProviders(ctx);
    if (providers.includes("openai-codex")) {
      const credentials = await codexCredentials(ctx);
      if (!isCurrentSession(epoch)) return;
      if (credentials) selectCodexAccount(credentials, ctx.model?.provider === "openai-codex");
    }
    meter = new TurnMeter();
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    if (!limits.length) {
      const provider = ctx.model?.provider ?? "";
      limits = (provider === "anthropic"
        ? providerUsageCache.get(provider)
        : provider === "openai-codex"
          ? codexCacheScope ? providerUsageCache.getFresh(provider, undefined, codexCacheScope) : undefined
          : providerUsageCache.getFresh(provider))?.limits ?? [];
    }
    gitStatus = undefined;
    liveExtensionStatuses = [];
    // Saved providers may not be available in this process yet. Keep their last fresh cross-session
    // snapshot visible while a session that can authenticate them refreshes it.
    const trackedProviders = Array.from(new Set([...providers, ...settings.providers.order]));
    const adapters = new Map<string, ProviderAdapter>();
    if (providers.includes("anthropic")) adapters.set("anthropic", { refresh: () => refreshProviderUsage("anthropic", () => fetchAnthropicUsage(ctx, findAvailableModel(ctx, "anthropic"))) });
    if (providers.includes("openai-codex")) adapters.set("openai-codex", { refresh: () => refreshCodexProviderUsage(ctx, findAvailableModel(ctx, "openai-codex")) });
    if (providers.includes("zai")) adapters.set("zai", { refresh: () => refreshProviderUsage("zai", () => fetchZaiUsage(ctx, findAvailableModel(ctx, "zai"))) });
    providerRefresh?.stop();
    providerRefresh = new ProviderRefreshCoordinator(adapters, () => {
      if (!isCurrentSession(epoch)) return;
      const health = providerRefresh?.get(ctx.model?.provider ?? "");
      if (health?.state === "fresh") {
        limits = health.usage.limits;
        syncTick();
      }
      requestRender?.();
    });
    for (const provider of trackedProviders) {
      const cached = provider === "anthropic"
        ? providerUsageCache.get(provider)
        : provider === "openai-codex"
          ? codexCacheScope ? providerUsageCache.getFresh(provider, undefined, codexCacheScope) : undefined
          : providerUsageCache.getFresh(provider);
      if (cached?.limits.length) providerRefresh.prime(provider, cached, provider === "anthropic" ? Date.now() : cached.updatedAt);
    }
    if (settings.enabled) installFooter(ctx, epoch);
    extensionEvents?.emit(AGENT_ACTIVITY_REQUEST_EVENT, { version: 1 });
    providerRefresh.start(trackedProviders);
    if (!providers.includes(ctx.model?.provider ?? "")) {
      void refreshAnthropicLimits(ctx, epoch).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx, 0, epoch); });
      void refreshCodexLimits(ctx, epoch);
    }
    syncGitTick(ctx, epoch);
    await refreshGit(ctx, epoch);
  });

  pi.on("session_shutdown", () => {
    meter.setActive(false);
    sessionActive = false;
    sessionEpoch++;
    turnActive = false;
    backgroundActive = false;
    activitySources.clear();
    progressMultiplexer?.setExternal(false);
    disposeProgressMultiplexer();
    stopTick();
    stopGitTick();
    stopAnthropicRetry();
    providerRefresh?.stop();
    liveExtensionStatuses = [];
  });

  pi.on("turn_start", (event) => {
    turnActive = true;
    meter.startTurn(event.timestamp);
    syncAggregateActivity(event.timestamp);
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    meter.markFirstUpdate();
    meter.updateOutputChars(sumTextLength(event.message.content));
    requestRender?.();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") meter.markMessageEnd();
  });

  pi.on("context", (event) => {
    lastContextChars = sumTextLength(event.messages);
  });

  pi.on("turn_end", async (event, ctx) => {
    turnActive = false;
    if (event.message.role === "assistant") {
      const { usage, content } = event.message;
      const input = usage.input || estimateTokens(lastContextChars);
      const output = usage.output || estimateTokens(sumTextLength(content));
      meter.finishTurn({ input, output });
    }
    syncAggregateActivity();
    void refreshCodexLimits(ctx);
    await refreshGit(ctx);
    requestRender?.();
  });

  pi.on("agent_settled", () => {
    turnActive = false;
    meter.finalizeActiveTurn();
    syncAggregateActivity();
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    const requestEpoch = ++codexProviderRequestEpoch;
    const scope = ctx.model?.provider === "openai-codex" ? codexCacheScope : undefined;
    codexProviderRequestScope = undefined;
    if (!scope) return;
    const credentials = await codexCredentials(ctx);
    if (requestEpoch !== codexProviderRequestEpoch
      || ctx.model?.provider !== "openai-codex"
      || scope !== codexCacheScope) return;
    if (!credentials) {
      clearCodexAccount(true);
      return;
    }
    if (codexAccountScope(credentials.accountId) !== scope) {
      selectCodexAccount(credentials, true);
      return;
    }
    codexProviderRequestScope = scope;
  });

  pi.on("after_provider_response", (event, ctx) => {
    const codexHeaders = Object.keys(event.headers).some((key) => key.toLowerCase().startsWith("x-codex-"));
    if (codexHeaders && (ctx.model?.provider !== "openai-codex"
      || !codexProviderRequestScope
      || codexProviderRequestScope !== codexCacheScope)) return;
    const next = parseRateLimits(event.headers);
    if (!next.length) return;
    limits = next;
    if (isAnthropicOAuth(ctx)) pi.appendEntry(ANTHROPIC_LIMITS_ENTRY, limits);
    syncTick();
    requestRender?.();
  });

  pi.on("model_select", (_event, ctx) => {
    codexProviderRequestEpoch++;
    codexProviderRequestScope = undefined;
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    meter.resetThroughput();
    syncTick();
    requestRender?.();
    stopAnthropicRetry();
    void refreshAnthropicLimits(ctx).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx); });
    void refreshCodexLimits(ctx);
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
