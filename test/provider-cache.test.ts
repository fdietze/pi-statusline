import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { RateLimitedError } from "../src/providers.ts";

const usage = { limits: [{ label: "5h", used: 0.2 }] };
type Usage = typeof usage;

test("shares one fresh provider usage result between sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  try {
    let fetches = 0;
    const first = new ProviderUsageCache(dir, 10_000);
    const second = new ProviderUsageCache(dir, 10_000);
    assert.deepEqual(await first.refresh("anthropic", async () => { fetches++; return usage; }), usage);
    assert.deepEqual((await second.refresh("anthropic", async () => { fetches++; return undefined; }))?.limits, usage.limits);
    assert.equal(fetches, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isolates provider usage by optional account scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  const cache = new ProviderUsageCache(dir, 10_000);
  const accountA = { limits: [{ label: "wk", used: 0.2 }] };
  const accountB = { limits: [{ label: "wk", used: 0.7 }] };
  try {
    await cache.refresh("openai-codex", async () => accountA, "account-a");
    await cache.refresh("openai-codex", async () => accountB, "account-b");
    assert.deepEqual(cache.get("openai-codex", "account-a")?.limits, accountA.limits);
    assert.deepEqual(cache.get("openai-codex", "account-b")?.limits, accountB.limits);
    assert.equal(cache.get("openai-codex"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows only one simultaneous refresh per provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let resolve!: (usage: Usage) => void;
  try {
    const first = new ProviderUsageCache(dir, 10_000);
    const second = new ProviderUsageCache(dir, 10_000);
    const pending = first.refresh("anthropic", () => new Promise<Usage>((done) => { resolve = done; }));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(await second.refresh("anthropic", async () => usage), undefined);
    resolve(usage);
    assert.deepEqual(await pending, usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backs off with a growing delay when the usage endpoint returns 429", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let clock = 1_000_000;
  let fetches = 0;
  const fail429 = async () => { fetches++; throw new RateLimitedError(); };
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
  try {
    await cache.refresh("anthropic", fail429); // first 429 -> 60s backoff
    assert.equal(fetches, 1);
    clock += 5_000; // still inside the 60s window
    await cache.refresh("anthropic", fail429);
    assert.equal(fetches, 1); // backed off, fetch not invoked
    clock += 60_000; // 60s elapsed -> retry
    await cache.refresh("anthropic", fail429); // 429 again -> escalate to 120s
    assert.equal(fetches, 2);
    clock += 60_000; // inside the 120s window
    await cache.refresh("anthropic", fail429);
    assert.equal(fetches, 2);
    clock += 60_000; // 120s elapsed -> retry
    await cache.refresh("anthropic", fail429); // 429 again -> escalate to 300s
    assert.equal(fetches, 3);
    clock += 300_000; // cap elapsed -> retry
    await cache.refresh("anthropic", fail429); // 429 again -> stays capped at 300s
    assert.equal(fetches, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clears the 429 backoff once a refresh succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let clock = 1_000_000;
  let fetches = 0;
  let throttled = true;
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
  try {
    await cache.refresh("anthropic", async () => { fetches++; if (throttled) throw new RateLimitedError(); return usage; });
    assert.notEqual(cache.get("anthropic")?.retryAt, undefined);
    clock += 60_000; // backoff elapsed
    throttled = false;
    const result = await cache.refresh("anthropic", async () => { fetches++; return usage; });
    assert.deepEqual(result?.limits, usage.limits);
    assert.equal(cache.get("anthropic")?.retryAt, undefined); // backoff cleared
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps serving the last known usage when a refresh returns no data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let clock = 1_000_000;
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
  try {
    await cache.refresh("anthropic", async () => usage);
    clock += 20_000;
    assert.deepEqual(await cache.refresh("anthropic", async () => undefined), usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps serving the last known usage while a 429 backoff is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let clock = 1_000_000;
  let fetches = 0;
  let throttled = false;
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
  try {
    await cache.refresh("anthropic", async () => { fetches++; return usage; }); // seed good usage
    throttled = true;
    clock += 20_000; // past refreshMs
    const during = await cache.refresh("anthropic", async () => { fetches++; if (throttled) throw new RateLimitedError(); return usage; });
    assert.deepEqual(during?.limits, usage.limits); // stale-but-good data still served
    clock += 5_000; // inside the new 60s backoff
    const again = await cache.refresh("anthropic", async () => { fetches++; throw new RateLimitedError(); });
    assert.deepEqual(again?.limits, usage.limits);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shares one 429 backoff across cache instances (sessions)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let clock = 1_000_000;
  let fetches = 0;
  const a = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
  const b = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
  try {
    await a.refresh("anthropic", async () => { fetches++; throw new RateLimitedError(); });
    assert.equal(fetches, 1);
    // Second session sees the persisted retryAt and skips its own fetch entirely.
    await b.refresh("anthropic", async () => { fetches++; throw new RateLimitedError(); });
    assert.equal(fetches, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("honors a per-provider refresh cadence longer than the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let clock = 1_000_000;
  let fetches = 0;
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => clock, { anthropic: 30_000 });
  try {
    await cache.refresh("anthropic", async () => { fetches++; return usage; });
    assert.equal(fetches, 1);
    clock += 20_000; // past the default 10s, under anthropic's 30s
    await cache.refresh("anthropic", async () => { fetches++; return usage; });
    assert.equal(fetches, 1); // anthropic cadence not elapsed
    clock += 11_000; // 31s total, past anthropic's 30s
    await cache.refresh("anthropic", async () => { fetches++; return usage; });
    assert.equal(fetches, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
