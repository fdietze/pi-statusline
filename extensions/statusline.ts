import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_ACTIVITY_REQUEST_EVENT,
  AGENT_ACTIVITY_UPDATE_EVENT,
  AgentActivitySources,
  TerminalProgressMultiplexer,
  type ProgressTerminal,
} from "../src/agent-activity.ts";
import { accountScope, DailyUsage, QUOTA_HISTORY_DIR } from "../src/daily-usage.ts";
import { msUntilResetCountdownChange } from "../src/format.ts";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, parseZaiUsage, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { ProviderRefreshCoordinator, RateLimitedError, type ProviderAdapter } from "../src/providers.ts";
import { providersToPoll } from "../src/provider-polling.ts";
import { renderMainLine, renderProviderRows, providerHasRow, type ExtensionStatus, type ProviderRowSource } from "../src/render.ts";
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

// The host name is read once per process; the short label (before the first dot) identifies
// the machine for local and SSH sessions alike.
const HOSTNAME = hostname().split(".")[0];

const quotaHistoryDir = (settingsPath: string) =>
  settingsPath === DEFAULT_STATUSLINE_CONFIG_PATH ? QUOTA_HISTORY_DIR : join(dirname(settingsPath), "quota-history");

export default function statusline(
  pi: ExtensionAPI,
  providerUsageCache = new ProviderUsageCache(),
  settingsPath = DEFAULT_STATUSLINE_CONFIG_PATH,
  codexDailyUsage = new DailyUsage(quotaHistoryDir(settingsPath), "openai-codex"),
  anthropicDailyUsage = new DailyUsage(quotaHistoryDir(settingsPath), "anthropic"),
) {
  let settings: StatuslineSettings = loadRuntimeSettings(settingsPath);
  let limits: RateLimits = [];
  const ANTHROPIC_LIMITS_ENTRY = "pi-statusline:anthropic-limits";
  // The usage endpoint names no account, so all Anthropic observations share one history scope;
  // an account switch just starts a new baseline once its reset time or usage no longer matches.
  const ANTHROPIC_ACCOUNT = "anthropic";
  let requestRender: (() => void) | undefined;
  let tick: ReturnType<typeof setTimeout> | undefined;
  let anthropicRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionActive = false;
  let sessionEpoch = 0;
  const activitySources = new AgentActivitySources();
  let progressTerminal: ProgressTerminal | undefined;
  let progressMultiplexer: TerminalProgressMultiplexer | undefined;
  // Live footer-only values captured so the settings preview can show the same HUD and statuses.
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

  // Reset countdowns are the only ticking content. One timeout is armed for the earliest moment a
  // shown countdown text changes (src/format.ts msUntilResetCountdownChange), so the footer wakes
  // only for visible changes and never while no countdown is upcoming (CPU deep sleep).
  const nextCountdownChangeMs = () => {
    const now = Date.now();
    let next: number | undefined;
    for (const limit of limits) {
      const delay = limit.resetAt === undefined ? undefined : msUntilResetCountdownChange(limit.resetAt, now);
      if (delay !== undefined && (next === undefined || delay < next)) next = delay;
    }
    return next;
  };
  const stopTick = () => {
    if (tick) clearTimeout(tick);
    tick = undefined;
  };
  const syncTick = () => {
    stopTick();
    if (!(sessionActive && settings.enabled && settings.segments.session)) return;
    const delay = nextCountdownChangeMs();
    if (delay === undefined) return;
    tick = setTimeout(() => {
      tick = undefined;
      requestRender?.();
      syncTick();
    }, delay);
    tick.unref?.();
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
    progressMultiplexer.setExternal(activitySources.terminalProgress());
  };
  type ExtensionEventBus = {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
  const extensionEvents = (pi as unknown as { events?: ExtensionEventBus }).events;
  extensionEvents?.on(AGENT_ACTIVITY_UPDATE_EVENT, (data) => {
    if (!activitySources.update(data)) return;
    progressMultiplexer?.setExternal(activitySources.terminalProgress());
  });

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

  // Providers with a "% today" tracker; other providers render without.
  const dailyUsageOf = (provider: string | undefined): DailyUsage | undefined =>
    provider === "openai-codex" ? codexDailyUsage : provider === "anthropic" ? anthropicDailyUsage : undefined;
  const withDailyUsage = (provider: string | undefined, windows: RateLimits): RateLimits =>
    dailyUsageOf(provider)?.decorate(windows) ?? windows;

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
      return anthropicDailyUsage.observe(ANTHROPIC_ACCOUNT, parseAnthropicUsage(await response.json()));
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

  const refreshProviderUsage = async (provider: string, fetchLimits: () => Promise<RateLimits>, scope?: string) => {
    const usage = await providerUsageCache.refresh(provider, async () => {
      const next = await fetchLimits();
      return next.length ? { limits: next } : undefined;
    }, scope);
    // Only one process per refresh window fetches (and tracks) usage; re-read the shared history so
    // this session's "% today" follows it instead of freezing at its start-up value.
    dailyUsageOf(provider)?.reload();
    return usage;
  };

  const selectCodexAccount = (credentials: { accountId: string }, activeCodex: boolean) => {
    const scope = accountScope(credentials.accountId);
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
      return {
        dispose() {
          stopTick();
          stopAnthropicRetry();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const edge = width >= 2 ? " " : "";
          const contentWidth = width - edge.length * 2;
          const provider = ctx.model?.provider;
          // Walk the branch for totals only when the opt-in cost extra shows them.
          const totals = settings.extras.cost ? sessionTotals(ctx) : undefined;
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
              windows: withDailyUsage(p, health.usage.limits),
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
          const line = renderMainLine(settings, {
            cwd: ctx.cwd,
            // Pi already requests a render on session_info_changed; read fresh metadata here.
            sessionName: ctx.sessionManager.getSessionName?.(),
            hostname: HOSTNAME,
            model: ctx.model,
            thinkingLevel: pi.getThinkingLevel(),
            contextUsage: ctx.getContextUsage(),
            extensionStatuses: liveExtensionStatuses,
            pending: ctx.hasPendingMessages(),
            totals,
            sessionWindows: withDailyUsage(provider, limits),
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
        windows[descriptor.id] = withDailyUsage(descriptor.id, snapshot.usage.limits);
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
    providerRefresh?.start(providersToPoll(settings, ctx.model?.provider));
    requestRender?.();
  };

  const openSettingsApp = (ctx: ExtensionContext) => {
    const providers = buildProviderContext(ctx);
    const previewCapability = ctx.model?.provider ? providers.capabilities[ctx.model.provider] : undefined;
    // Live snapshot of the current session, fed to the in-app preview so it shows exactly what the
    // footer will look like under the DRAFT settings (cwd, model, context, quota, reset countdowns).
    // Reads the draft (not the committed settings) so toggling extras like cost /
    // pending is visible before saving — the preview is a live reflection of the draft.
    const currentPreviewContext = (draft: StatuslineSettings): ResolutionContext => {
      // Mirror the footer's own render inputs so the "current" preview is byte-identical to the
      // live main line under the draft settings (cost, quota, theme).
      const totals = draft.extras.cost ? sessionTotals(ctx) : undefined;
      return {
        capability: previewCapability,
        runtime: {
          cwd: ctx.cwd,
          sessionName: ctx.sessionManager.getSessionName?.(),
          hostname: HOSTNAME,
          model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, reasoning: ctx.model.reasoning, baseUrl: ctx.model.baseUrl } : undefined,
          activeProvider: ctx.model?.provider,
          thinkingLevel: pi.getThinkingLevel(),
          contextUsage: ctx.getContextUsage() ?? undefined,
          extensionStatuses: liveExtensionStatuses,
          sessionWindows: limits,
          pending: ctx.hasPendingMessages(),
          totals,
        },
      };
    };
    // The live footer would duplicate the preview; hide it while settings are open so there
    // is exactly one statusline on screen — the interactive preview. Restored on close.
    const footerWasEnabled = settings.enabled;
    settingsOverlayOpen = true;
    if (footerWasEnabled) ctx.ui.setFooter(undefined);
    return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      let state = createSettingsUi(settings);
      let finished = false;
      // Re-render every second while the overlay is open so the preview's reset countdowns stay live.
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
    activitySources.clear();
    codexAccountGeneration++;
    codexCacheScope = undefined;
    codexDailyUsage.clearAccount();
    anthropicDailyUsage.selectAccount(ANTHROPIC_ACCOUNT);
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
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    if (!limits.length) {
      const provider = ctx.model?.provider ?? "";
      limits = (provider === "anthropic"
        ? providerUsageCache.get(provider)
        : provider === "openai-codex"
          ? codexCacheScope ? providerUsageCache.getFresh(provider, undefined, codexCacheScope) : undefined
          : providerUsageCache.getFresh(provider))?.limits ?? [];
    }
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
    providerRefresh.start(providersToPoll(settings, ctx.model?.provider));
    if (!providers.includes(ctx.model?.provider ?? "")) {
      void refreshAnthropicLimits(ctx, epoch).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx, 0, epoch); });
      void refreshCodexLimits(ctx, epoch);
    }
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    sessionEpoch++;
    activitySources.clear();
    progressMultiplexer?.setExternal(false);
    disposeProgressMultiplexer();
    stopTick();
    stopAnthropicRetry();
    providerRefresh?.stop();
    liveExtensionStatuses = [];
  });

  pi.on("turn_end", async (_event, ctx) => {
    void refreshCodexLimits(ctx);
    requestRender?.();
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
    if (accountScope(credentials.accountId) !== scope) {
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
    syncTick();
    providerRefresh?.start(providersToPoll(settings, ctx.model?.provider));
    requestRender?.();
    stopAnthropicRetry();
    void refreshAnthropicLimits(ctx).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx); });
    void refreshCodexLimits(ctx);
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
