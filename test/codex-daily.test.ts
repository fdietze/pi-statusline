import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDailyUsage, operationalDayStart } from "../src/codex-daily.ts";
import type { RateLimitWindow } from "../src/ratelimit.ts";

const window = (used: number, resetAt = Date.now() + 604_800_000, durationMs = 604_800_000): RateLimitWindow => ({
  key: "primary",
  label: "wk",
  used,
  resetAt,
  durationMs,
});

function temporaryTracker(now: { value: number }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-daily-"));
  return {
    dir,
    tracker: new CodexDailyUsage(dir, () => now.value),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function localTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

test("operationalDayStart uses the local 05:00 boundary", () => {
  assert.equal(operationalDayStart(localTime(2026, 8, 16, 4, 59)), localTime(2026, 8, 15, 5));
  assert.equal(operationalDayStart(localTime(2026, 8, 16, 5)), localTime(2026, 8, 16, 5));
});

test("operational day remains calendar-based across a DST transition", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    assert.equal(operationalDayStart(localTime(2026, 3, 29, 4, 59)), localTime(2026, 3, 28, 5));
    assert.equal(operationalDayStart(localTime(2026, 3, 29, 5)), localTime(2026, 3, 29, 5));
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("tracks positive quota changes and survives tracker restarts", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { dir, tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  try {
    assert.equal(tracker.observe("acct_1", [window(0.2, resetAt)])[0]!.dailyUsed, 0);
    now.value += 1_000;
    assert.ok(Math.abs(tracker.observe("acct_1", [window(0.26, resetAt)])[0]!.dailyUsed! - 0.06) < 1e-9);

    now.value += 1_000;
    const restarted = new CodexDailyUsage(dir, () => now.value);
    assert.ok(Math.abs(restarted.observe("acct_1", [window(0.3, resetAt)])[0]!.dailyUsed! - 0.1) < 1e-9);
    assert.equal(readFileSync(join(dir, "openai-codex.json"), "utf8").includes("acct_1"), false);
  } finally {
    cleanup();
  }
});

test("carries the last pre-05:00 sample into the next operational day", () => {
  const now = { value: localTime(2026, 8, 16, 4, 50) };
  const { tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  try {
    tracker.observe("acct_1", [window(0.22, resetAt)]);
    now.value = localTime(2026, 8, 16, 9);
    assert.ok(Math.abs(tracker.observe("acct_1", [window(0.25, resetAt)])[0]!.dailyUsed! - 0.03) < 1e-9);
  } finally {
    cleanup();
  }
});

test("a multi-day gap, account change, or duration change starts a new baseline", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  try {
    tracker.observe("acct_1", [window(0.2, resetAt)]);
    now.value += 1_000;
    assert.equal(tracker.observe("acct_2", [window(0.3, resetAt)])[0]!.dailyUsed, 0);
    now.value += 1_000;
    assert.equal(tracker.observe("acct_2", [window(0.4, resetAt, 86_400_000)])[0]!.dailyUsed, 0);
    now.value = localTime(2026, 8, 18, 10);
    assert.equal(tracker.observe("acct_2", [window(0.5, resetAt, 86_400_000)])[0]!.dailyUsed, 0);
  } finally {
    cleanup();
  }
});

test("keeps account histories isolated across same-process switches", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  try {
    tracker.observe("acct_1", [window(0.2, resetAt)]);
    now.value += 1_000;
    tracker.observe("acct_1", [window(0.3, resetAt)]);
    now.value += 1_000;
    tracker.observe("acct_2", [window(0.5, resetAt)]);
    now.value += 1_000;
    tracker.observe("acct_2", [window(0.55, resetAt)]);

    tracker.selectAccount("acct_1");
    assert.ok(Math.abs(tracker.decorate([window(0.3, resetAt)])[0]!.dailyUsed! - 0.1) < 1e-9);
    tracker.selectAccount("acct_2");
    assert.ok(Math.abs(tracker.decorate([window(0.55, resetAt)])[0]!.dailyUsed! - 0.05) < 1e-9);
  } finally {
    cleanup();
  }
});

test("adds post-reset usage when a quota window rolls over during the day", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { tracker, cleanup } = temporaryTracker(now);
  const duration = 3_600_000;
  const firstReset = now.value + duration;
  try {
    tracker.observe("acct_1", [window(0.8, firstReset, duration)]);
    now.value += 1_000;
    tracker.observe("acct_1", [window(0.9, firstReset, duration)]);
    now.value = firstReset + 1_000;
    const result = tracker.observe("acct_1", [window(0.2, firstReset + duration, duration)]);
    assert.ok(Math.abs(result[0]!.dailyUsed! - 0.3) < 1e-9);
  } finally {
    cleanup();
  }
});

test("rejects stale writers and recovers a corrupt state file", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { dir, tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  try {
    tracker.observe("acct_1", [window(0.2, resetAt)], now.value);
    now.value += 2_000;
    tracker.observe("acct_1", [window(0.3, resetAt)], now.value);
    const stale = new CodexDailyUsage(dir, () => now.value);
    assert.ok(Math.abs(stale.observe("acct_1", [window(0.25, resetAt)], now.value - 1_000)[0]!.dailyUsed! - 0.1) < 1e-9);

    writeFileSync(join(dir, "openai-codex.json"), "not json");
    now.value += 1_000;
    assert.equal(new CodexDailyUsage(dir, () => now.value).observe("acct_1", [window(0.4, resetAt)])[0]!.dailyUsed, 0);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, "openai-codex.json"), "utf8")));
  } finally {
    cleanup();
  }
});

test("restores only the selected account and stops decorating after day rollover", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { dir, tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  try {
    tracker.observe("acct_1", [window(0.2, resetAt)]);
    now.value += 1_000;
    tracker.observe("acct_1", [window(0.25, resetAt)]);
    const restarted = new CodexDailyUsage(dir, () => now.value);
    assert.equal(restarted.decorate([window(0.25, resetAt)])[0]!.dailyUsed, undefined);
    restarted.selectAccount("acct_1");
    assert.ok(Math.abs(restarted.decorate([window(0.25, resetAt)])[0]!.dailyUsed! - 0.05) < 1e-9);
    restarted.selectAccount("acct_2");
    restarted.selectAccount("acct_2");
    assert.equal(restarted.decorate([window(0.25, resetAt)])[0]!.dailyUsed, undefined);
    now.value = localTime(2026, 8, 17, 5);
    tracker.selectAccount("acct_1");
    assert.equal(tracker.decorate([window(0.25, resetAt)])[0]!.dailyUsed, undefined);
  } finally {
    cleanup();
  }
});

test("merges stale partial snapshots per window instead of discarding the whole response", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const { dir, tracker, cleanup } = temporaryTracker(now);
  const resetAt = now.value + 604_800_000;
  const secondary = (used: number): RateLimitWindow => ({ ...window(used, resetAt), key: "secondary", label: "5h" });
  try {
    tracker.observe("acct_1", [window(0.2, resetAt), secondary(0.4)], now.value);
    now.value += 2_000;
    tracker.observe("acct_1", [window(0.3, resetAt)], now.value);
    const stale = new CodexDailyUsage(dir, () => now.value);
    assert.ok(Math.abs(stale.observe("acct_1", [secondary(0.45)], now.value - 1_000)[0]!.dailyUsed! - 0.05) < 1e-9);

    const restored = new CodexDailyUsage(dir, () => now.value);
    restored.selectAccount("acct_1");
    const [primaryResult, secondaryResult] = restored.decorate([window(0.3, resetAt), secondary(0.45)]);
    assert.ok(Math.abs(primaryResult!.dailyUsed! - 0.1) < 1e-9);
    assert.ok(Math.abs(secondaryResult!.dailyUsed! - 0.05) < 1e-9);
  } finally {
    cleanup();
  }
});

test("history storage failure never hides the core quota snapshot", () => {
  const now = { value: localTime(2026, 8, 16, 10) };
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-daily-blocked-"));
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory");
  try {
    const limits = [window(0.2)];
    assert.deepEqual(new CodexDailyUsage(join(blocked, "child"), () => now.value).observe("acct_1", limits), limits);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
