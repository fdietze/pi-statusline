import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, rateLevel, sumTextLength, TurnMeter } from "../src/throughput.ts";

test("estimates tokens from character counts for providers that omit usage", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(3), 1);
  assert.equal(estimateTokens(400), 100);
});

test("sums text across nested message content, ignoring non-text fields", () => {
  assert.equal(sumTextLength("abcd"), 4);
  assert.equal(sumTextLength([{ type: "text", text: "ab" }, { type: "thinking", thinking: "cde" }]), 5);
  assert.equal(sumTextLength({ role: "user", content: [{ type: "text", text: "abcdefgh" }] }), 8);
  assert.equal(sumTextLength([{ role: "assistant", content: "hi" }, { role: "toolResult", toolCallId: "1" }]), 2);
  assert.equal(sumTextLength(undefined), 0);
});

test("measures streamed windows and independently falls back to the whole turn", () => {
  const meter = new TurnMeter(() => 0);
  meter.startTurn(0);
  meter.markFirstUpdate(10_000);
  meter.markMessageEnd(20_000);
  meter.finishTurn({ input: 8_500, output: 620 }, 20_000);
  assert.equal(meter.snapshot(20_000).inputRate, 850);
  assert.equal(meter.snapshot(20_000).outputRate, 62);

  meter.startTurn(20_000);
  meter.finishTurn({ input: 100, output: 200 }, 30_000);
  assert.equal(meter.snapshot(30_000).inputRate, 10);
  assert.equal(meter.snapshot(30_000).outputRate, 20);

  meter.startTurn(30_000);
  meter.finishTurn({ input: 10, output: 10 }, 30_000);
  assert.equal(meter.snapshot(30_000).inputRate, 0);
  assert.equal(meter.snapshot(30_000).outputRate, 0);
});

test("reports live output rate and prompt-wait time while a turn streams", () => {
  const meter = new TurnMeter(() => 0);
  meter.startTurn(0);
  assert.equal(meter.snapshot(3_000).waitingMs, 3_000);
  assert.equal(meter.snapshot(3_000).outputRate, undefined);

  meter.markFirstUpdate(3_000);
  meter.updateOutputChars(40); // 10 tokens at 4 chars/token
  assert.equal(meter.snapshot(4_000).waitingMs, undefined);
  assert.equal(meter.snapshot(4_000).outputRate, 10);

  meter.updateOutputChars(80);
  assert.equal(meter.snapshot(5_000).outputRate, 10);

  meter.markMessageEnd(5_000);
  meter.finishTurn({ input: 5, output: 20 }, 5_000);
  assert.equal(meter.snapshot(5_000).waitingMs, undefined);
  assert.equal(meter.snapshot(5_000).outputRate, 10);
});

test("averages recent turns instead of freezing on the last one", () => {
  const meter = new TurnMeter(() => 0);
  const finish = (start: number, rate: number) => {
    meter.startTurn(start);
    meter.markFirstUpdate(start);
    meter.markMessageEnd(start + 1_000);
    meter.finishTurn({ input: rate, output: rate }, start + 1_000);
  };
  finish(0, 100);
  assert.equal(meter.snapshot(1_000).avgOutputRate, 100);
  finish(1_000, 50);
  assert.equal(meter.snapshot(2_000).avgOutputRate, 75);
});

test("classifies rates with directional baselines and an output floor", () => {
  assert.equal(rateLevel(68, [70, 71, 69, 70, 70]), "success");
  assert.equal(rateLevel(48, [70, 71, 69, 70, 70]), "warning");
  assert.equal(rateLevel(30, [70, 71, 69, 70, 70]), "error");
  assert.equal(rateLevel(1_000, [1_200, 1_200, 1_200]), "warning");
  assert.equal(rateLevel(100, [100, 100]), "muted");
  assert.equal(rateLevel(15, [], true), "error");
});

test("caps histories and resets displayed throughput on model changes", () => {
  const meter = new TurnMeter(() => 0);
  const finish = (start: number, rate: number) => {
    meter.startTurn(start);
    meter.finishTurn({ input: rate, output: rate }, start + 1_000);
  };
  for (let turn = 0; turn < 5; turn++) finish(turn * 1_000, 100);
  finish(5_000, 0);
  finish(6_000, 73);
  assert.equal(meter.snapshot(7_000).inputLevel, "success");

  meter.resetThroughput();
  assert.equal(meter.snapshot(7_000).inputRate, undefined);
  finish(7_000, 10);
  assert.equal(meter.snapshot(8_000).inputLevel, "muted");
  assert.equal(meter.snapshot(8_000).outputLevel, "error");
});

test("finalizes a foreground turn without conflating its throughput window with active time", () => {
  const meter = new TurnMeter(() => 0);
  meter.setActive(true, 1_000);
  meter.startTurn(1_000);
  assert.equal(meter.liveElapsedMs(2_000), 1_000);
  meter.finalizeActiveTurn(4_000);
  assert.equal(meter.liveElapsedMs(5_000), 0);
  assert.equal(meter.liveActiveMs(5_000), 4_000, "aggregate activity can outlive the foreground turn");
  meter.setActive(false, 5_000);
  assert.equal(meter.snapshot(5_000).activeMs, 4_000);
  assert.equal(meter.snapshot(5_000).lastTurnMs, 3_000);
  assert.equal(meter.snapshot(5_000).inputRate, undefined);
});

test("retains idle result, resets on turn start, and accumulates active time", () => {
  const meter = new TurnMeter(() => 1_000);
  assert.equal(meter.snapshot(1_000).lastTurnMs, undefined);
  for (const [start, duration] of [[1_000, 5_000], [7_000, 10_000], [20_000, 3_000]] as const) {
    meter.setActive(true, start);
    meter.startTurn(start);
    meter.markFirstUpdate(start + 1_000);
    meter.markMessageEnd(start + duration);
    meter.finishTurn({ input: 100, output: 100 }, start + duration);
    meter.setActive(false, start + duration);
  }
  const idle = meter.snapshot(30_000);
  assert.equal(idle.activeMs, 18_000);
  assert.equal(idle.lastTurnMs, 3_000);
  assert.equal(idle.elapsedMs, 29_000);
  assert.ok(idle.outputRate);

  meter.setActive(true, 31_000);
  meter.startTurn(31_000);
  assert.equal(meter.snapshot(31_000).outputRate, undefined);
  meter.finishTurn({ input: 0, output: 0 }, 35_000);
  meter.setActive(false, 35_000);
  assert.equal(meter.snapshot(35_000).activeMs, 22_000);
});

test("active time counts the union of overlapping main and background work once", () => {
  const meter = new TurnMeter(() => 0);
  meter.setActive(true, 1_000); // main starts
  meter.setActive(true, 2_000); // child overlaps: idempotent
  meter.startTurn(1_000);
  meter.finishTurn({ input: 10, output: 10 }, 4_000); // main ends, child remains
  assert.equal(meter.liveActiveMs(6_000), 5_000);
  meter.setActive(false, 7_000); // final child ends
  meter.setActive(false, 8_000); // repeated stop: idempotent
  assert.equal(meter.snapshot(9_000).activeMs, 6_000);
  assert.equal(meter.snapshot(9_000).lastTurnMs, 3_000, "last-turn remains foreground-only");
});
