import assert from "node:assert/strict";
import test from "node:test";
import { formatResetCountdown, formatWindow, msUntilResetCountdownChange } from "../src/format.ts";

test("formats windows and reset countdowns", () => {
  assert.equal(formatWindow(128_000), "128K");
  assert.equal(formatWindow(200_000), "200K");
  assert.equal(formatWindow(1_000_000), "1.0M");
  assert.equal(formatResetCountdown(1_000_000, 1_000_000), "now");
  assert.equal(formatResetCountdown(1_000_000 + 42 * 60_000, 1_000_000), "42m");
  assert.equal(formatResetCountdown(1_000_000 + 134 * 60_000, 1_000_000), "2h14m");
  assert.equal(formatResetCountdown(1_000_000 + 76 * 3_600_000, 1_000_000), "3d4h");
});

test("reset countdown change delay lands exactly where the shown minute drops", () => {
  const now = 1_000_000;
  for (const remaining of [1, 59_999, 60_000, 60_001, 90_000, 134 * 60_000 + 7, 1_440 * 60_000, 76 * 3_600_000 + 90_000]) {
    const delay = msUntilResetCountdownChange(now + remaining, now)!;
    assert.ok(delay > 0 && delay <= (remaining > 1_440 * 60_000 ? 3_600_000 : 60_000));
    const before = formatResetCountdown(now + remaining, now + delay - 1);
    assert.equal(before, formatResetCountdown(now + remaining, now));
    assert.notEqual(formatResetCountdown(now + remaining, now + delay), before);
  }
  // Beyond a day the text shows whole hours: "3d3h" (4559 min) holds for 60 minutes, not 1.
  assert.equal(msUntilResetCountdownChange(now + 4_559 * 60_000, now), 3_600_000);
  assert.equal(msUntilResetCountdownChange(now, now), undefined);
  assert.equal(msUntilResetCountdownChange(now - 1, now), undefined);
});
