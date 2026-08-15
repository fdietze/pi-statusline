import assert from "node:assert/strict";
import test from "node:test";
import { deriveRateLimitPace, parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, parseZaiUsage } from "../src/ratelimit.ts";

const fixture = {
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "anthropic-ratelimit-unified-5h-reset": "2026-07-15T18:00:00Z",
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": "1784246400000",
};

test("parses Anthropic unified windows", () => {
  assert.deepEqual(parseRateLimits(fixture), [
    { key: "five-hour", label: "5h", used: 0.23, resetAt: Date.parse("2026-07-15T18:00:00Z") },
    { key: "seven-day", label: "wk", used: 0.41, resetAt: 1_784_246_400_000 },
  ]);
});

test("parses Anthropic OAuth usage", () => {
  assert.deepEqual(parseAnthropicUsage({
    five_hour: { utilization: 23, resets_at: "2026-07-15T18:00:00Z" },
    seven_day: { utilization: 41, resets_at: 1_784_246_400 },
  }), [
    { key: "five-hour", label: "5h", used: 0.23, resetAt: Date.parse("2026-07-15T18:00:00Z") },
    { key: "seven-day", label: "wk", used: 0.41, resetAt: 1_784_246_400_000 },
  ]);
});

test("parses only the Codex windows actually reported", () => {
  assert.deepEqual(parseRateLimits({
    "X-Codex-Primary-Used-Percent": "23",
    "X-Codex-Primary-Window-Minutes": "60",
    "X-Codex-Primary-Reset-At": "1784246400",
    "X-Codex-Secondary-Used-Percent": "41",
    "X-Codex-Secondary-Window-Minutes": "10080",
  }), [
    { key: "primary", label: "1h", used: 0.23, resetAt: 1_784_246_400_000, durationMs: 3_600_000 },
    { key: "secondary", label: "wk", used: 0.41, durationMs: 604_800_000 },
  ]);
  assert.deepEqual(parseRateLimits({
    "x-codex-primary-used-percent": "41",
    "x-codex-primary-window-minutes": "43200",
  }), [{ key: "primary", label: "30d", used: 0.41, durationMs: 2_592_000_000 }]);
});

test("parses Codex account usage by the windows returned by the account", () => {
  assert.deepEqual(parseCodexUsage({
    rate_limit: {
      primary_window: null,
      secondary_window: {
        used_percent: 63,
        limit_window_seconds: 604_800,
        reset_at: 1_784_246_400,
      },
    },
  }), [{ key: "secondary", label: "wk", used: 0.63, resetAt: 1_784_246_400_000, durationMs: 604_800_000 }]);
  assert.deepEqual(parseCodexUsage({ rate_limit: null }), []);
});

test("derives approximate fixed-window pace and hides unusable boundaries", () => {
  const durationMs = 100_000;
  const now = 1_000_000;
  const window = (used: number, remainingFraction = 0.5) => ({
    label: "test",
    used,
    durationMs,
    resetAt: now + durationMs * remainingFraction,
  });

  const over = deriveRateLimitPace(window(0.56), now);
  const under = deriveRateLimitPace(window(0.44), now);
  const onPace = deriveRateLimitPace(window(0.506), now);
  assert.equal(over?.relation, "over");
  assert.equal(under?.relation, "under");
  assert.equal(onPace?.relation, "on-pace");
  assert.ok(Math.abs(over!.percentagePoints - 6) < 1e-9);
  assert.ok(Math.abs(under!.percentagePoints - 6) < 1e-9);
  assert.ok(Math.abs(onPace!.percentagePoints - 0.6) < 1e-9);
  assert.equal(deriveRateLimitPace(window(0, 1), now)?.relation, "on-pace", "a fresh window still has a measurable pace");
  assert.equal(deriveRateLimitPace({ ...window(0.5), resetAt: now }, now), undefined, "expired window");
  assert.equal(deriveRateLimitPace({ label: "legacy", used: 0.5, resetAt: now + 1 }, now), undefined, "legacy cache has no duration");
});

test("parses Z.AI TOKENS_LIMIT windows, ordering the untouched/sooner-resetting one as 5h", () => {
  assert.deepEqual(parseZaiUsage({
    data: {
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: 1_787_999_449_996 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 5, nextResetTime: 1_785_753_049_998 },
      ],
      level: "pro",
    },
    success: true,
  }), [
    { key: "five-hour", label: "5h", used: 0 },
    { key: "weekly", label: "wk", used: 0.05, resetAt: 1_785_753_049_998 },
  ]);
});

test("orders two reset-bearing Z.AI windows by which resets sooner", () => {
  assert.deepEqual(parseZaiUsage({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", percentage: 40, nextResetTime: 1_785_753_049_998 },
        { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1_785_000_049_998 },
      ],
    },
  }), [
    { key: "five-hour", label: "5h", used: 0.1, resetAt: 1_785_000_049_998 },
    { key: "weekly", label: "wk", used: 0.4, resetAt: 1_785_753_049_998 },
  ]);
});

test("hides Z.AI usage on any unexpected shape rather than guessing", () => {
  assert.deepEqual(parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10 }] } }), []);
  assert.deepEqual(parseZaiUsage({ data: { limits: [] } }), []);
  assert.deepEqual(parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 101 }, { type: "TOKENS_LIMIT", percentage: 5 }] } }), []);
  assert.deepEqual(parseZaiUsage({}), []);
  assert.deepEqual(parseZaiUsage(null), []);
});

test("restores only valid saved windows", () => {
  assert.deepEqual(parseStoredRateLimits([
    { key: "saved-five-hour", label: "5h", used: 0.23, resetAt: 1_784_246_400, durationMs: 18_000_000 },
    { key: "saved-week", label: "wk", used: 0.41, durationMs: -1 },
    { key: "bad", label: "bad", used: 2 },
    null,
  ]), [
    { key: "saved-five-hour", label: "5h", used: 0.23, resetAt: 1_784_246_400_000, durationMs: 18_000_000 },
    { key: "saved-week", label: "wk", used: 0.41 },
  ]);
  assert.deepEqual(parseStoredRateLimits({}), []);
});

test("hides absent, unrecognized, or invalid windows without hiding valid siblings", () => {
  assert.deepEqual(parseRateLimits({}), []);
  assert.deepEqual(parseRateLimits({ "x-ratelimit-5h": "0.2" }), []);
  assert.deepEqual(parseRateLimits({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }), [
    { key: "five-hour", label: "5h", used: 0.2 },
  ]);
  assert.deepEqual(parseRateLimits({ ...fixture, "anthropic-ratelimit-unified-7d-utilization": "unknown" }), [
    { key: "five-hour", label: "5h", used: 0.23, resetAt: Date.parse("2026-07-15T18:00:00Z") },
  ]);
});
