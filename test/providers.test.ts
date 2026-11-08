import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRefreshCoordinator, sanitizedReason } from "../src/providers.ts";

const usage = { limits: [{ label: "5h", used: 0.2 }] };

test("refreshes providers independently and recovers after a failure", async () => {
  let anthro = 0, codex = 0;
  const coordinator = new ProviderRefreshCoordinator(new Map([
    ["anthropic", { refresh: async () => { anthro++; throw new Error("Bearer secret response body"); } }],
    ["openai-codex", { refresh: async () => { codex++; return usage; } }],
  ]), () => {}, 10, 20);
  await Promise.all([coordinator.refresh("anthropic"), coordinator.refresh("openai-codex")]);
  assert.equal(codex, 1);
  assert.deepEqual(coordinator.get("openai-codex"), { state: "fresh", usage, updatedAt: coordinator.get("openai-codex").updatedAt });
  assert.deepEqual(coordinator.get("anthropic"), { state: "hidden", reason: "usage unavailable" });
  assert.equal(JSON.stringify(coordinator.get("anthropic")).includes("secret"), false);
  (coordinator as any).adapters.set("anthropic", { refresh: async () => { anthro++; return usage; } });
  await coordinator.refresh("anthropic");
  assert.equal(coordinator.get("anthropic").state, "fresh");
  assert.equal(anthro, 2);
});

test("renders cached usage before its background refresh completes", () => {
  const coordinator = new ProviderRefreshCoordinator(new Map([
    ["anthropic", { refresh: () => new Promise<never>(() => {}) }],
  ]), () => {}, 10, 20);
  coordinator.prime("anthropic", usage, Date.now());
  assert.equal(coordinator.get("anthropic").state, "fresh");
  coordinator.prime("future", usage, Date.now() + 60_000);
  assert.equal(coordinator.get("future").state, "hidden");
});

test("keeps a cached provider visible when this process cannot refresh it", async () => {
  const coordinator = new ProviderRefreshCoordinator(new Map(), () => {}, 10, 20);
  coordinator.prime("anthropic", usage, Date.now());
  await coordinator.refresh("anthropic");
  assert.equal(coordinator.get("anthropic").state, "fresh");
});

test("keeps default provider usage visible through missed refreshes", async () => {
  const coordinator = new ProviderRefreshCoordinator(new Map([
    ["anthropic", { refresh: async () => usage }],
  ]), () => {});
  await coordinator.refresh("anthropic");
  const fresh = coordinator.get("anthropic");
  assert.equal(coordinator.get("anthropic", fresh.updatedAt! + 30_000).state, "fresh");
});

test("keeps the last fresh usage through a transient refresh failure", async () => {
  let available = true;
  const coordinator = new ProviderRefreshCoordinator(new Map([
    ["anthropic", { refresh: async () => available ? usage : undefined }],
  ]), () => {}, 10, 20);
  await coordinator.refresh("anthropic");
  const fresh = coordinator.get("anthropic");
  available = false;
  await coordinator.refresh("anthropic");
  assert.deepEqual(coordinator.get("anthropic"), fresh);
  assert.deepEqual(coordinator.get("anthropic", fresh.updatedAt! + 21), {
    state: "hidden",
    reason: "usage data is stale",
    updatedAt: fresh.updatedAt,
  });
});

test("publishes a fast provider's usage without waiting on a hanging refresh", async () => {
  const coordinator = new ProviderRefreshCoordinator(new Map([
    ["anthropic", { refresh: () => new Promise<never>(() => {}) }],
    ["openai-codex", { refresh: async () => usage }],
  ]), () => {}, 10, 10_000);
  void coordinator.refresh("anthropic");
  await coordinator.refresh("openai-codex");
  assert.equal(coordinator.get("openai-codex").state, "fresh");
  assert.equal(coordinator.get("anthropic").state, "hidden");
});

test("recovers a failed provider on a later scheduled refresh", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback: (() => void) | undefined;
  let intervalMs: number | undefined;
  globalThis.setInterval = ((fn: () => void, ms: number) => { intervalCallback = fn; intervalMs = ms; return 1; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    let attempts = 0;
    const coordinator = new ProviderRefreshCoordinator(new Map([
      ["anthropic", { refresh: async () => { attempts++; if (attempts === 1) throw new Error("usage endpoint down"); return usage; } }],
    ]), () => {}, 50, 10_000);
    coordinator.start(["anthropic"]);
    await settle();
    assert.equal(intervalMs, 50);
    assert.equal(attempts, 1);
    assert.equal(coordinator.get("anthropic").state, "hidden");
    intervalCallback!();
    await settle();
    assert.equal(attempts, 2);
    assert.equal(coordinator.get("anthropic").state, "fresh");
    coordinator.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("hides stale results and reports specific reasons for providers without an adapter", async () => {
  const coordinator = new ProviderRefreshCoordinator(new Map([["anthropic", { refresh: async () => usage }]]), () => {}, 10, 20);
  await coordinator.refresh("anthropic");
  assert.deepEqual(coordinator.get("anthropic", Date.now() + 21), { state: "hidden", reason: "usage data is stale", updatedAt: coordinator.get("anthropic").updatedAt });
  assert.equal(sanitizedReason("zai"), "usage unavailable");
  assert.equal(sanitizedReason("openrouter"), "usage requires an OpenRouter management key pi doesn't manage");
});

test("start polls exactly the given providers: idempotent for the same list, an empty list stops", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const live = new Set<number>();
  let nextId = 0;
  globalThis.setInterval = (() => { live.add(++nextId); return nextId; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { live.delete(id); }) as unknown as typeof clearInterval;
  try {
    let refreshes = 0;
    const coordinator = new ProviderRefreshCoordinator(new Map([
      ["anthropic", { refresh: async () => { refreshes++; return usage; } }],
    ]), () => {}, 50, 10_000);
    coordinator.start([]);
    assert.equal(live.size, 0, "nothing to show, no timer");
    coordinator.start(["anthropic"]);
    coordinator.start(["anthropic"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(live.size, 1);
    assert.equal(refreshes, 1, "an unchanged list neither restarts nor refetches");
    coordinator.start([]);
    assert.equal(live.size, 0, "an empty list stops polling");
    coordinator.start(["anthropic"]);
    assert.equal(live.size, 1, "polling resumes after a stop");
    coordinator.stop();
    assert.equal(live.size, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
