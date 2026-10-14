import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import statusline from "../extensions/statusline.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";

// The interactive settings menu resolves colors from pi's global theme singleton
// (getSettingsListTheme() throws "Theme not initialized" otherwise). Real pi sessions
// call this at startup; tests must do it once too.
initTheme();
const cacheRoot = mkdtempSync(join(tmpdir(), "pi-statusline-test-"));
let cacheNumber = 0;
const testCache = () => new ProviderUsageCache(join(cacheRoot, String(cacheNumber++)));
after(() => rmSync(cacheRoot, { recursive: true, force: true }));

test("stops the live timer when settled or the footer is disposed", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void } | undefined;
  let cleared = 0;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((_: () => void) => 1) as typeof setInterval;
  globalThis.clearInterval = ((_: ReturnType<typeof setInterval>) => { cleared++; }) as typeof clearInterval;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as never;
    const ctx = {
      cwd: process.cwd(),
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
    await handlers.get("session_start")!({}, ctx);
    const now = Date.now();
    handlers.get("turn_start")!({ timestamp: now });
    handlers.get("agent_settled")!({});
    assert.equal(cleared, 1);

    handlers.get("turn_start")!({ timestamp: now });
    footer?.dispose?.();
    // Disposing also stops the independent git-status poll interval alongside the time tick.
    assert.equal(cleared, 3);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("arbitrates native and aggregate background terminal progress through the footer terminal", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const progressCalls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => progressCalls.push(active) };
  let footer: { dispose?: () => void } | undefined;
  const events = {
    on: (channel: string, handler: (data: unknown) => void) => {
      const listeners = busHandlers.get(channel) ?? new Set<(data: unknown) => void>();
      listeners.add(handler);
      busHandlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit: (channel: string, data: unknown) => {
      for (const handler of busHandlers.get(channel) ?? []) handler(data);
    },
  };
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    events,
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {}, terminal },
          { fg: (_: string, text: string) => text },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  events.emit("pi.agent-activity.v1:update", {
    version: 1,
    source: "subagents",
    active: true,
    terminalProgress: true,
  });
  assert.deepEqual(progressCalls, [true]);
  terminal.setProgress(false); // Pi's foreground stops; the child keeps effective progress active.
  assert.deepEqual(progressCalls, [true]);

  events.emit("pi.agent-activity.v1:update", {
    version: 1,
    source: "subagents",
    active: true,
    terminalProgress: false,
  });
  assert.deepEqual(progressCalls, [true, false], "OSC policy is separate from raw timer activity");
  footer?.dispose?.();
  await handlers.get("session_shutdown")!({ reason: "quit" });
});

test("reasserts aggregate progress after started TUI transitions but not an unstarted shutdown renderer", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const progressCalls: boolean[] = [];
  const transportSetProgress = (active: boolean) => progressCalls.push(active);
  const terminal = { setProgress: transportSetProgress, start: () => {} };
  const tui = { mode: "regular", requestRender: () => {}, terminal };
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const events = {
    on: (channel: string, handler: (data: unknown) => void) => {
      const listeners = busHandlers.get(channel) ?? new Set<(data: unknown) => void>();
      listeners.add(handler);
      busHandlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit: (channel: string, data: unknown) => {
      for (const handler of busHandlers.get(channel) ?? []) handler(data);
    },
  };
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    events,
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    isIdle: () => true,
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    modelRegistry: { isUsingOAuth: () => false },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          tui,
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "mode-transition.json"));
  await handlers.get("session_start")!({}, ctx);
  events.emit("pi.agent-activity.v1:update", {
    version: 1,
    source: "subagents",
    active: true,
    terminalProgress: true,
  });
  assert.deepEqual(progressCalls, [true]);

  transportSetProgress(false); // ProcessTerminal.stop() clears the physical transport.
  tui.mode = "fullscreen";
  terminal.start(); // TuiBase.start() starts the replacement renderer's shared terminal.
  footer!.render(200);
  assert.deepEqual(progressCalls, [true, false, true], "one forced reassertion after terminal start");

  transportSetProgress(false);
  tui.mode = "regular";
  terminal.start();
  footer!.render(200);
  assert.deepEqual(progressCalls, [true, false, true, false, true]);

  transportSetProgress(false);
  tui.mode = "fullscreen";
  footer!.render(200); // stopInteractiveTui() swaps mode with startRenderer=false, then renders.
  assert.deepEqual(
    progressCalls,
    [true, false, true, false, true, false],
    "an unstarted shutdown renderer cannot resurrect terminal progress",
  );

  events.emit("pi.agent-activity.v1:update", {
    version: 1,
    source: "subagents",
    active: false,
    terminalProgress: false,
  });
  assert.equal(progressCalls.at(-1), false);

  const settledCalls = [...progressCalls];
  events.emit("pi.agent-activity.v1:update", {
    version: 1,
    source: "subagents",
    active: true,
    terminalProgress: false,
  });
  tui.mode = "regular";
  terminal.start();
  footer!.render(200);
  assert.deepEqual(progressCalls, settledCalls, "timer-only activity stays OSC-disabled across mode changes");
  footer?.dispose?.();
  await handlers.get("session_shutdown")!({ reason: "quit" });
});

test("raw background activity extends union time without changing foreground rates or requesting OSC", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const progressCalls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => progressCalls.push(active) };
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const settingsPath = join(cacheRoot, "activity-union.json");
  writeFileSync(settingsPath, JSON.stringify({
    ...DEFAULT_STATUSLINE_SETTINGS,
    extras: { ...DEFAULT_STATUSLINE_SETTINGS.extras, lastTurn: true },
  }));
  const events = {
    on: (channel: string, handler: (data: unknown) => void) => {
      const listeners = busHandlers.get(channel) ?? new Set<(data: unknown) => void>();
      listeners.add(handler);
      busHandlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit: (channel: string, data: unknown) => {
      for (const handler of busHandlers.get(channel) ?? []) handler(data);
    },
  };
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    events,
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "local", provider: "local", baseUrl: "http://localhost:1234" },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {}, terminal },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  try {
    statusline(pi, testCache(), settingsPath);
    await handlers.get("session_start")!({}, ctx);
    now = 1_000;
    events.emit("pi.agent-activity.v1:update", {
      version: 1,
      source: "subagents",
      active: true,
      terminalProgress: false,
    });
    now = 2_000;
    handlers.get("turn_start")!({ timestamp: now });
    now = 2_500;
    handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
    now = 3_500;
    handlers.get("message_end")!({ message: { role: "assistant" } });
    now = 4_000;
    await handlers.get("turn_end")!({
      message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20 } },
    }, ctx);
    const whileChildRuns = footer!.render(500)[0]!;
    assert.ok(whileChildRuns.includes("⚡↑200 ↓20 t/s"), whileChildRuns);
    assert.ok(whileChildRuns.includes("⏳ 3s (last 2s)"), whileChildRuns);

    now = 6_000;
    events.emit("pi.agent-activity.v1:update", {
      version: 1,
      source: "subagents",
      active: false,
      terminalProgress: false,
    });
    const settled = footer!.render(500)[0]!;
    assert.ok(settled.includes("⚡↑200 ↓20 t/s"), settled);
    assert.ok(settled.includes("⏳ 5s (last 2s)"), settled);
    assert.deepEqual(progressCalls, [], "raw timer activity must not imply terminal progress");
  } finally {
    footer?.dispose?.();
    await handlers.get("session_shutdown")?.({ reason: "quit" });
    Date.now = originalNow;
  }
});

test("reads generic extension statuses from footer data on every render", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const statuses = new Map<string, string>();
  let reads = 0;
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => {
              reads++;
              return statuses;
            },
            getAvailableProviderCount: () => 1,
            onBranchChange: () => () => {},
          },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  assert.equal(footer!.render(200)[0]!.includes("FAST"), false);

  const styled = "\x1b[31mREVIEW\x1b[0m";
  statuses.set("fast", "FAST");
  statuses.set("mcp", "MCP 3/3");
  statuses.set("review", styled);
  const populated = footer!.render(200)[0]!;
  assert.ok(populated.indexOf("FAST") < populated.indexOf("REVIEW"), populated);
  assert.ok(populated.includes(styled), populated);
  const content = populated.trimEnd();
  assert.ok(content.endsWith("MCP 3/3"), populated);
  assert.equal(content.slice(0, -"MCP 3/3".length).includes("MCP"), false, populated);

  statuses.clear();
  assert.equal(footer!.render(200)[0]!.includes("FAST"), false);
  assert.equal(reads, 3, "footer data must be queried on each render");
  footer?.dispose?.();
});

test("renders emoji segments with themed semantic colors", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const execCalls: unknown[][] = [];
  let colorMode = "truecolor";
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "medium",
    exec: async (...args: unknown[]) => {
      execCalls.push(args);
      return {
        code: 0,
        stdout: "# branch.head feature/statusline\0" + "# branch.ab +2 -1\0" + "1 .M N... modified.ts\0" + "? untracked.ts\0",
        stderr: "",
      };
    },
  } as never;
  const accountToken = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_theme" } })).toString("base64url")}.s`;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "gpt-5.6-terra", provider: "openai-codex", reasoning: true },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => accountToken },
    getContextUsage: () => ({ tokens: 110_000, percent: 55, contextWindow: 200_000 }),
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          {
            fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
            getColorMode: () => colorMode,
            getFgAnsi: (role: string) => ({
              success: "\x1b[38;2;0;255;0m",
              warning: "\x1b[38;2;255;165;0m",
              error: "\x1b[38;2;255;0;0m",
            } as Record<string, string>)[role] ?? "\x1b[39m",
          },
          { getGitBranch: () => "main", getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  const initial = footer!.render(500)[0]!;
  // Subscription (openai-codex + OAuth) hides the throughput ledger at idle; quota bars carry it.
  assert.equal(initial.includes(" t/s"), false);
  for (const label of ["🪟 </muted><success>55.0%/200K"]) assert.ok(initial.includes(label));
  assert.ok(initial.includes("📁 pi-statusline</muted><dim> > </dim><accent>feature/statusline</accent> <warning>● 2</warning> <warning>↓1</warning> <accent>↑2</accent>"));
  assert.deepEqual(execCalls[0], ["git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: process.cwd(), timeout: 2_000 }]);
  assert.equal(initial.includes("5h"), false);
  assert.equal(initial.includes("wk"), false);
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 850, output: 74 } } }, ctx);
  const resetAt = String(Math.floor((Date.now() + 3_600_000) / 1_000));
  await handlers.get("before_provider_request")!({}, ctx);
  handlers.get("after_provider_response")!({ headers: {
    "x-codex-primary-used-percent": "60",
    "x-codex-primary-window-minutes": "60",
    "x-codex-primary-reset-at": resetAt,
    "x-codex-secondary-used-percent": "80",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": resetAt,
  } }, ctx);
  const line = footer!.render(1_000)[0]!;
  for (const icon of ["📁", "🤖", "🧠", "🪟", "⏳"]) assert.ok(line.includes(icon));
  assert.ok(line.includes("1h"));
  assert.ok(line.includes("wk"));
  assert.equal(line.includes("5h"), false);
  assert.ok(line.includes("\x1b[38;2;"));
  assert.ok(line.includes("╺"));
  assert.ok(line.includes("╴"));
  assert.equal(line.includes("◖"), false);
  assert.equal(line.includes("◗"), false);
  assert.equal(line.split("↻").length - 1, 2);
  assert.ok(line.includes("<dim> > </dim>"));
  assert.ok(line.includes("<dim> ></dim>"));
  assert.equal(line.includes(" · "), false);

  colorMode = "16";
  const semanticLine = footer!.render(1_000)[0]!;
  assert.ok(semanticLine.includes("<success>╺━━━━━━</success><dim>────╴</dim> 60%"));
  assert.ok(semanticLine.includes("<warning>╺━━━━━━━━━</warning><dim>─╴</dim> 80%"));

  await handlers.get("model_select")!({}, ctx);
  assert.equal(footer!.render(500)[0]!.includes(" t/s"), false);
  footer?.dispose?.();
});

test("loads Anthropic limits at session start", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const entries: unknown[] = [];
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  let request: [string, RequestInit | undefined] | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    request = [String(input), init];
    return {
      ok: true,
      json: async () => ({
        five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day: { utilization: 41, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    } as never;
    const ctx = {
      cwd: process.cwd(),
      model: { id: "claude-opus-4-8", provider: "anthropic", reasoning: true },
      modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => "access-token" },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => entries },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
    await handlers.get("session_start")!({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(request?.[0], "https://api.anthropic.com/api/oauth/usage");
    assert.equal((request?.[1]?.headers as Record<string, string>)["anthropic-beta"], "oauth-2025-04-20");
    const line = footer!.render(500)[0]!;
    assert.ok(line.includes("5h ╺"));
    assert.ok(line.includes("wk ╺"));
    assert.equal(entries.length, 1);
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test("ignores provider refreshes from a replaced session", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let release!: (response: Response) => void;
  let stale = false;
  let staleReads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const context = (trackStaleness = false) => ({
      cwd: process.cwd(),
      get model() {
        if (trackStaleness && stale) staleReads++;
        return { id: "claude", provider: "anthropic" };
      },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: async () => "access-token",
        getAvailable: () => [{ provider: "anthropic", id: "claude" }],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        ),
        notify: () => {},
      },
    }) as never;

    statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
    await handlers.get("session_start")!({}, context(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stale = true;
    await handlers.get("session_start")!({}, context());
    release(new Response(JSON.stringify({
      five_hour: { utilization: 25, resets_at: Date.now() + 3_600_000 },
      seven_day: { utilization: 50, resets_at: Date.now() + 86_400_000 },
    }), { status: 200 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(staleReads, 0, "a late refresh must not read a stale extension context");
    handlers.get("session_shutdown")!({});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("restores Anthropic limits when a session reloads", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const entries: unknown[] = [];
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "claude-opus-4-8", provider: "anthropic", reasoning: true },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  const resetAt = String(Math.floor((Date.now() + 3_600_000) / 1_000));
  handlers.get("after_provider_response")!({ headers: {
    "anthropic-ratelimit-unified-5h-utilization": "0.23",
    "anthropic-ratelimit-unified-5h-reset": resetAt,
    "anthropic-ratelimit-unified-7d-utilization": "0.41",
    "anthropic-ratelimit-unified-7d-reset": resetAt,
  } }, ctx);
  await handlers.get("session_start")!({}, ctx);

  const line = footer!.render(500)[0]!;
  assert.equal(entries.length, 1);
  assert.ok(line.includes("5h ╺"));
  assert.ok(line.includes("wk ╺"));
  assert.equal(line.split("↻").length - 1, 2);
  assert.equal(line.includes("—"), false);
  assert.equal(line.includes(""), false);
  assert.equal(line.includes("⎇"), false);
  footer?.dispose?.();
});

test("estimates throughput from response text when a provider reports no usage", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "llama-local", provider: "llama-cpp", baseUrl: "http://localhost:8080/v1" },
    modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  handlers.get("context")!({ messages: [{ role: "user", content: "a".repeat(400) }] });
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({
    message: { role: "assistant", usage: { input: 0, output: 0 }, content: [{ type: "text", text: "b".repeat(200) }] },
  }, ctx);

  const line = footer!.render(500)[0]!;
  assert.ok(line.includes("↑100"));
  assert.ok(line.includes("↓50"));
  footer?.dispose?.();
});

test("shows an API token ledger (not a bogus prompt rate) for hosted providers when idle", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "claude-sonnet-4-5", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
    modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => [{
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 7_400, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.021 } },
        },
      }],
    },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  handlers.get("context")!({ messages: [{ role: "user", content: "a".repeat(30_000) }] });
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({
    message: { role: "assistant", usage: { input: 7_400, output: 200 }, content: [{ type: "text", text: "b".repeat(800) }] },
  }, ctx);
  handlers.get("agent_settled")!({});

  const line = footer!.render(500)[0]!;
  assert.ok(line.includes("🧾"), `expected API token ledger, got: ${line}`);
  assert.ok(line.includes("$0.021"), `expected session cost, got: ${line}`);
  assert.ok(!/↑\d+ ↓\d+ t\/s/.test(line), `should not show a bogus prompt rate, got: ${line}`);
  footer?.dispose?.();
});

test("renders a fresh active provider beneath the session line without duplicate quota", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    five_hour: { utilization: 25, resets_at: Date.now() + 3_600_000 },
    seven_day: { utilization: 50, resets_at: Date.now() + 86_400_000 },
  }), { status: 200 })) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const ctx = {
      cwd: process.cwd(),
      model: { id: "claude", provider: "anthropic" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: async () => "access-token",
        getAvailable: () => [{ provider: "anthropic" }],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
    await handlers.get("session_start")!({}, ctx);
    assert.ok(footer!.render(500)[1]?.includes("anthropic 5h — wk —"), "provider should render before its usage fetch completes");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lines = footer!.render(500);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.includes("5h"), false, `active session line duplicated quota: ${lines[0]}`);
    assert.ok(lines[1]!.includes("anthropic 5h"), `missing provider row: ${lines[1]}`);
    assert.ok(lines[1]!.includes("wk"), `provider windows were not preserved: ${lines[1]}`);
    assert.ok(lines.every((line) => line.startsWith(" ") && line.endsWith(" ")), "every footer row has outer padding");
    assert.equal(footer!.render(1).length, 2, "narrow widths must retain the provider row");
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test("shows a tracked provider's last-known cross-session cache at startup", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const configPath = join(cacheRoot, "tracked-cache.json");
  writeFileSync(configPath, JSON.stringify({ providerTracking: { selected: { anthropic: true }, order: ["anthropic"] } }));
  let clock = 1_000_000;
  const cache = new ProviderUsageCache(join(cacheRoot, String(cacheNumber++)), 10_000, 10_000, () => clock);
  await cache.refresh("anthropic", async () => ({ limits: [{ label: "5h", used: 0.25 }] }));
  clock += 6 * 60_000; // older than the normal 5-minute freshness window
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "glm", provider: "zai" },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: async () => undefined,
      // Anthropic is intentionally absent: another pi process supplied its cached quota.
      getAvailable: () => [{ provider: "zai", id: "glm" }],
    },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, cache, configPath);
  await handlers.get("session_start")!({}, ctx);
  assert.ok(footer!.render(500)[1]!.includes("anthropic 5h"));
  footer?.dispose?.();
});

test("keeps active quota on the session line when provider tracking is disabled", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const configPath = join(cacheRoot, "tracking-disabled.json");
  writeFileSync(configPath, JSON.stringify({ providerTracking: { enabled: false } }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    five_hour: { utilization: 25, resets_at: Date.now() + 3_600_000 },
    seven_day: { utilization: 50, resets_at: Date.now() + 86_400_000 },
  }), { status: 200 })) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const ctx = {
      cwd: process.cwd(),
      model: { id: "claude", provider: "anthropic" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: async () => "access-token",
        getAvailable: () => [{ provider: "anthropic" }],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi, testCache(), configPath);
    await handlers.get("session_start")!({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(footer!.render(500)[0]!.includes("5h"));
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

// Harness for the /statusline command: registers the extension, drives the settings app through
// the stubbed ctx.ui.custom, and exposes the captured component + notifications.
function settingsHarness(options: { mode?: string; settingsPath?: string } = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const notifications: Array<[string, string]> = [];
  const doneResults: unknown[] = [];
  const footerStates: boolean[] = [];
  let commandDef: { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: unknown } | undefined;
  let customCount = 0;
  let component: { render: (width: number) => string[]; handleInput?: (data: string) => void; dispose?: () => void } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, def: any) => { commandDef = def; },
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    appendEntry: () => {},
  } as never;
  const ctx = {
    mode: options.mode ?? "tui",
    cwd: process.cwd(),
    model: { id: "claude", provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: async () => undefined,
      getAvailable: () => [{ provider: "anthropic" }, { provider: "openai-codex" }],
    },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: unknown) => footerStates.push(Boolean(factory)),
      notify: (message: string, level: string) => notifications.push([message, level]),
      custom: (factory: any) => {
        customCount++;
        component = factory({ requestRender: () => {} }, {}, {}, (result: unknown) => doneResults.push(result ?? null));
        return Promise.resolve();
      },
    },
  } as never;

  statusline(pi, testCache(), options.settingsPath);
  return {
    handlers, notifications, doneResults, footerStates, ctx,
    get commandDef() { return commandDef!; },
    get customCount() { return customCount; },
    get component() { return component!; },
  };
}

// Raw terminal sequences translated by the extension's parseKey bridge.
const K = {
  enter: "\r", space: " ", escape: "\x1b", save: "s", discard: "d",
  down: "\x1b[B", up: "\x1b[A", end: "\x1b[F", home: "\x1b[H",
} as const;

test("bare /statusline in tui opens the settings app once at the root without legacy args", async () => {
  const h = settingsHarness();
  await h.handlers.get("session_start")!({}, h.ctx);

  assert.equal(h.commandDef.getArgumentCompletions, undefined, "legacy on/off/toggle completions must be removed");
  await h.commandDef.handler("", h.ctx);
  assert.equal(h.customCount, 1, "bare /statusline must open ctx.ui.custom exactly once");
  assert.equal(h.notifications.length, 0, "opening the app must not notify");
  const root = h.component.render(100);
  for (const label of ["Statusline & Providers", "Display", "Icons", "Reset all settings to default"]) {
    assert.ok(root.some((line) => line.includes(label)), `root screen missing ${label}: ${JSON.stringify(root)}`);
  }
});

test("non-empty tui args give one deterministic no-arguments notice; non-tui modes require the terminal UI", async () => {
  const tui = settingsHarness();
  await tui.handlers.get("session_start")!({}, tui.ctx);
  await tui.commandDef.handler("on", tui.ctx);
  assert.equal(tui.customCount, 0, "legacy arguments must not open or mutate anything");
  assert.equal(tui.notifications.length, 1, "exactly one notice for unexpected arguments");
  assert.match(tui.notifications[0]![0], /no arguments/i);

  for (const mode of ["rpc", "json", "print"]) {
    const off = settingsHarness({ mode });
    await off.handlers.get("session_start")!({}, off.ctx);
    await off.commandDef.handler("", off.ctx);
    assert.equal(off.customCount, 0, `${mode} mode must not open the interactive UI`);
    assert.equal(off.notifications.length, 1, `${mode} mode must notify rather than silently no-op`);
    assert.match(off.notifications[0]![0], /interactive terminal/i);
  }
});

test("saving a changed draft persists it; discarding leaves the file untouched", async () => {
  const savePath = join(cacheRoot, "save-flow.json");
  const h = settingsHarness({ settingsPath: savePath });
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.commandDef.handler("", h.ctx);
  const input = h.component.handleInput!;
  input(K.enter);   // open Providers
  input(K.space);   // toggle statusline enabled -> draft.enabled = false
  input(K.escape);  // back to root
  input(K.escape);  // dirty -> confirm-close prompt
  input(K.save);    // save
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(existsSync(savePath), "save must persist the settings file");
  assert.equal(JSON.parse(readFileSync(savePath, "utf8")).enabled, false, "persisted draft must reflect the toggle");
  assert.equal(h.doneResults.length, 1, "a successful save closes the app");
  assert.equal(h.footerStates.at(-1), false, "saving Disabled must leave the live footer removed");

  const enablePath = join(cacheRoot, "enable-flow.json");
  writeFileSync(enablePath, JSON.stringify({ version: 1, enabled: false }));
  const e = settingsHarness({ settingsPath: enablePath });
  await e.handlers.get("session_start")!({}, e.ctx);
  await e.commandDef.handler("", e.ctx);
  e.component.handleInput!(K.enter);
  e.component.handleInput!(K.space);
  e.component.handleInput!(K.escape);
  e.component.handleInput!(K.escape);
  e.component.handleInput!(K.save);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(e.footerStates.at(-1), true, "saving Enabled must install the live footer immediately");

  const discardPath = join(cacheRoot, "discard-flow.json");
  const d = settingsHarness({ settingsPath: discardPath });
  await d.handlers.get("session_start")!({}, d.ctx);
  await d.commandDef.handler("", d.ctx);
  const dInput = d.component.handleInput!;
  dInput(K.enter);
  dInput(K.space);
  dInput(K.escape);
  dInput(K.escape);
  dInput(K.discard);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(existsSync(discardPath), false, "discard must not write settings");
  assert.equal(d.doneResults.length, 1, "discard closes the app without saving");
});

test("an injected storage failure leaves the settings file unwritten and the save path uncommitted", async () => {
  const blocked = join(cacheRoot, "blocked-file");
  writeFileSync(blocked, "not a directory");
  const failPath = join(blocked, "statusline.json"); // parent is a file -> mkdir/write throws
  const h = settingsHarness({ settingsPath: failPath });
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.commandDef.handler("", h.ctx);
  const input = h.component.handleInput!;
  input(K.enter);
  input(K.space);
  input(K.escape);
  input(K.escape);
  input(K.save);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(existsSync(failPath), false, "a failed save must not create a partial file");
  assert.equal(h.doneResults.length, 0, "a failed save must not close the app (stays on the prompt)");
  assert.ok(h.component.render(100).some((line) => line.includes("Save failed:")), "the failure must surface in the prompt");
});

test("tracks every selected provider's usage simultaneously, not just the active model's", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const originalFetch = globalThis.fetch;
  const codexToken = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url")}.s`;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: Date.now() + 3_600_000 },
        seven_day: { utilization: 20, resets_at: Date.now() + 86_400_000 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 3_600, reset_at: Math.floor(Date.now() / 1_000) + 3_600 } },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const ctx = {
      cwd: process.cwd(),
      // The active model is Codex, not Anthropic. Before the fix, this alone hid Anthropic's row
      // (and any provider row but the active one) no matter what the settings menu had selected.
      model: { id: "gpt-5-codex", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
      modelRegistry: {
        isUsingOAuth: (model: { provider: string }) => model.provider === "anthropic",
        getApiKeyForProvider: async (provider: string) => (provider === "openai-codex" ? codexToken : "access-token"),
        getAvailable: () => [
          { provider: "anthropic", id: "claude" },
          { provider: "openai-codex", id: "gpt-5-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
        ],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 2, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
    await handlers.get("session_start")!({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lines = footer!.render(500);
    assert.ok(lines.some((line) => line.includes("anthropic") && line.includes("5h")), `expected an anthropic row despite Codex being active, got: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((line) => line.includes("openai-codex") && line.includes("≈0.0pp today")), `expected tracked daily Codex usage, got: ${JSON.stringify(lines)}`);
    assert.equal(existsSync(join(cacheRoot, "quota-history", "openai-codex.json")), true);
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test("ignores malformed Codex account claims without breaking session startup", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const malformedToken = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: 42 } })).toString("base64url")}.s`;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "gpt-5-codex", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: async () => malformedToken,
      getAvailable: () => [{ provider: "openai-codex", id: "gpt-5-codex", baseUrl: "https://chatgpt.com/backend-api/codex" }],
    },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: { setFooter: () => {}, notify: () => {} },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "malformed-account.json"));
  await assert.doesNotReject(async () => handlers.get("session_start")!({}, ctx));
  handlers.get("session_shutdown")!({ reason: "quit" });
});

test("an old-account Codex refresh cannot retain or restore stale provider health", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  let accountId: string | undefined = "acct_a";
  let tokenLookup: (() => Promise<string | undefined>) | undefined;
  let accountAFetches = 0;
  let resolveHeldAccountA!: (response: Response) => void;
  const heldAccountA = new Promise<Response>((resolve) => { resolveHeldAccountA = resolve; });
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let intervalId = 0;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const token = () => accountId
    ? `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.s`
    : undefined;
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    const id = ++intervalId;
    intervals.set(id, { callback, ms });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    intervals.delete(id as unknown as number);
  }) as typeof clearInterval;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const requestedAccount = new Headers(init?.headers).get("chatgpt-account-id");
    if (requestedAccount === "acct_a" && ++accountAFetches > 1) return heldAccountA;
    if (requestedAccount === "acct_c") return new Response("", { status: 503 });
    const usedPercent = requestedAccount === "acct_a" ? 20 : 70;
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 3_600, reset_at: Math.floor(Date.now() / 1_000) + 3_600 } },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const ctx = {
      cwd: process.cwd(),
      model: { id: "gpt-5-codex", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyForProvider: () => tokenLookup ? tokenLookup() : Promise.resolve(token()),
        getAvailable: () => [{ provider: "openai-codex", id: "gpt-5-codex", baseUrl: "https://chatgpt.com/backend-api/codex" }],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    const cache = new ProviderUsageCache(join(cacheRoot, String(cacheNumber++)), 0);
    statusline(pi, cache, join(cacheRoot, "account-switch.json"));
    await handlers.get("session_start")!({}, ctx);
    await settle();
    await settle();
    assert.ok(footer!.render(500).join("\n").includes("20%"));
    assert.equal(handlers.has("before_provider_headers"), false);
    await handlers.get("before_provider_request")!({}, ctx);
    assert.ok(footer!.render(500).join("\n").includes("20%"), "starting a request must not invalidate Codex quota");

    for (const interval of intervals.values()) if (interval.ms === 10_000) interval.callback();
    await settle();
    assert.equal(accountAFetches, 2);
    const accountAToken = token()!;
    let resolveTokenLookup!: (value: string | undefined) => void;
    const delayedTokenLookup = new Promise<string | undefined>((resolve) => { resolveTokenLookup = resolve; });
    tokenLookup = () => delayedTokenLookup;
    const pendingRequestStart = handlers.get("before_provider_request")!({}, ctx);
    accountId = "acct_b";
    handlers.get("model_select")!({}, ctx);
    resolveTokenLookup(accountAToken);
    await pendingRequestStart;
    handlers.get("after_provider_response")!({ headers: {
      "x-codex-primary-used-percent": "99",
      "x-codex-primary-window-minutes": "60",
    } }, ctx);
    assert.equal(footer!.render(500).join("\n").includes("99%"), false, "model selection must invalidate a request-start hook that is awaiting credentials");
    tokenLookup = undefined;
    handlers.get("model_select")!({}, ctx);
    await settle();
    await settle();
    resolveHeldAccountA(new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 3_600, reset_at: Math.floor(Date.now() / 1_000) + 3_600 } },
    }), { status: 200 }));
    await settle();
    await settle();
    for (const interval of intervals.values()) if (interval.ms === 10_000) interval.callback();
    await settle();
    await settle();

    let lines = footer!.render(500).join("\n");
    assert.ok(lines.includes("70%"), lines);
    assert.equal(lines.includes("20%"), false, lines);

    accountId = "acct_c";
    for (const interval of intervals.values()) if (interval.ms === 10_000) interval.callback();
    await settle();
    await settle();
    lines = footer!.render(500).join("\n");
    assert.equal(lines.includes("openai-codex"), false, lines);
    assert.equal(lines.includes("70%"), false, lines);

    handlers.get("after_provider_response")!({ headers: {
      "x-codex-primary-used-percent": "20",
      "x-codex-primary-window-minutes": "60",
    } }, ctx);
    lines = footer!.render(500).join("\n");
    assert.equal(lines.includes("20%"), false, lines);

    accountId = undefined;
    handlers.get("model_select")!({}, ctx);
    await settle();
    await settle();
    lines = footer!.render(500).join("\n");
    assert.equal(lines.includes("openai-codex"), false, lines);
    assert.equal(lines.includes("70%"), false, lines);
  } finally {
    footer?.dispose?.();
    handlers.get("session_shutdown")?.({ reason: "quit" });
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("refreshes git status on an interval independent of turn activity", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let intervalCallback: (() => void) | undefined;
  let intervalMs: number | undefined;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    intervalCallback = fn;
    intervalMs = ms;
    return 1;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let execCount = 0;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => {
        execCount++;
        return { code: 0, stdout: "", stderr: "" };
      },
    } as never;
    const ctx = {
      cwd: process.cwd(),
      ui: {
        setFooter: (factory: any) => {
          factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text },
            { getGitBranch: () => "main", getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
    await handlers.get("session_start")!({}, ctx);
    const countAfterStart = execCount;
    assert.ok(intervalCallback, "expected a periodic git refresh interval");
    assert.equal(intervalMs, 10_000);

    intervalCallback!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(execCount, countAfterStart + 1);

    intervalCallback!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(execCount, countAfterStart + 2);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("navigates into Display and Icons via the command handler; clean Escape closes without a dialog", async () => {
  const h = settingsHarness();
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.commandDef.handler("", h.ctx);
  const input = h.component.handleInput!;

  // Navigate down to Separators (index 1) and open it.
  input(K.down);
  input(K.enter);
  const sepLines = h.component.render(100);
  assert.ok(sepLines.some((line) => line.includes("Display")), `expected Display header, got: ${JSON.stringify(sepLines)}`);
  // Rows are prefixed with ">" (selected) or " " — text-based, no ANSI color dependency.
  assert.ok(sepLines.some((line) => line.includes("> Project / Git visibility")), "selected-row indicator must be plain text");

  // Escape back to root.
  input(K.escape);
  const rootAfterSep = h.component.render(100);
  for (const label of ["Statusline & Providers", "Display", "Icons", "Reset all settings to default"]) {
    assert.ok(rootAfterSep.some((line) => line.includes(label)), `root must show ${label} after backing out of Display`);
  }

  // Navigate down twice to Icons (index 2) and open it.
  input(K.down);
  input(K.down);
  input(K.enter);
  const emojiLines = h.component.render(100);
  assert.ok(emojiLines.some((line) => line.includes("Icons")), `expected Icons header, got: ${JSON.stringify(emojiLines)}`);

  // Escape back to root.
  input(K.escape);
  const rootAfterEmojis = h.component.render(100);
  assert.ok(rootAfterEmojis.some((line) => line.includes("Statusline & Providers")), "root must be restored after backing out of Icons");

  // A clean Escape at root (no dirty changes) must close the app without a confirm dialog.
  input(K.escape);
  assert.equal(h.doneResults.length, 1, "clean Escape at root must close the app");
  assert.equal(h.notifications.length, 0, "clean close must not notify");
});

test("Providers screen via command handler lists all discovered providers", async () => {
  const h = settingsHarness();
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.commandDef.handler("", h.ctx);
  const input = h.component.handleInput!;

  // Open Providers (first root row, already selected at index 0).
  input(K.enter);
  const lines = h.component.render(200);
  // The harness modelRegistry exposes anthropic and openai-codex; both must appear.
  assert.ok(lines.some((line) => line.includes("anthropic")), `Providers screen must list anthropic: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((line) => line.includes("openai-codex")), `Providers screen must list openai-codex: ${JSON.stringify(lines)}`);
  // No row should contain the term "catalog-only" or come from outside getAvailable().
  assert.equal(lines.some((line) => line.includes("catalog-only")), false, "catalog-only providers must not appear");
});

test("reads current session names on render across rename, clear, resume and new session", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const statuses = new Map<string, string>();
  let reads = 0;
  let sessionName: string | undefined;
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [], getSessionName: () => sessionName },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => {
              reads++;
              return statuses;
            },
            getAvailableProviderCount: () => 1,
            onBranchChange: () => () => {},
          },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi, testCache(), join(cacheRoot, "defaults.json"));
  await handlers.get("session_start")!({}, ctx);
  const unnamed = footer!.render(200)[0]!;
  sessionName = "First name";
  assert.ok(footer!.render(200)[0]!.trimEnd().endsWith(sessionName));
  sessionName = "Renamed";
  assert.ok(footer!.render(200)[0]!.trimEnd().endsWith(sessionName));
  sessionName = undefined;
  assert.equal(footer!.render(200)[0]!, unnamed);
  await handlers.get("session_shutdown")!({ reason: "quit" });
  sessionName = "Resumed session";
  await handlers.get("session_start")!({}, ctx);
  assert.ok(footer!.render(200)[0]!.trimEnd().endsWith(sessionName));
  await handlers.get("session_shutdown")!({ reason: "quit" });
  sessionName = undefined;
  await handlers.get("session_start")!({}, ctx);
  assert.equal(footer!.render(200)[0]!, unnamed);
  footer?.dispose?.();
  await handlers.get("session_shutdown")!({ reason: "quit" });
});

test("settings overlay re-reads renamed and cleared session names on each preview render", async () => {
  const h = settingsHarness();
  let sessionName: string | undefined = "Overlay title";
  (h.ctx as any).sessionManager.getSessionName = () => sessionName;
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.commandDef.handler("", h.ctx);
  assert.ok(h.component.render(100).join("\n").includes("Overlay title"));
  sessionName = "Renamed overlay";
  const renamed = h.component.render(100).join("\n");
  assert.ok(renamed.includes(sessionName), renamed);
  assert.equal(renamed.includes("Overlay title"), false);
  sessionName = undefined;
  assert.equal(h.component.render(100).join("\n").includes("Renamed overlay"), false);
  h.component.dispose?.();
  await h.handlers.get("session_shutdown")!({ reason: "quit" });
});
