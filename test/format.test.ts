import assert from "node:assert/strict";
import test from "node:test";
import { formatPercent, formatResetCountdown, formatWindow } from "../src/format.ts";

test("formats windows, percentages, and reset countdowns", () => {
  assert.equal(formatWindow(128_000), "128K");
  assert.equal(formatWindow(200_000), "200K");
  assert.equal(formatWindow(1_000_000), "1.0M");
  assert.equal(formatPercent(0.55), "55.0%");
  assert.equal(formatResetCountdown(1_000_000, 1_000_000), "now");
  assert.equal(formatResetCountdown(1_000_000 + 42 * 60_000, 1_000_000), "42m");
  assert.equal(formatResetCountdown(1_000_000 + 134 * 60_000, 1_000_000), "2h14m");
  assert.equal(formatResetCountdown(1_000_000 + 76 * 3_600_000, 1_000_000), "3d4h");
});
