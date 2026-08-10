import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivitySources, TerminalProgressMultiplexer } from "../src/agent-activity.ts";

test("activity sources aggregate independent raw activity and progress projections", () => {
  const sources = new AgentActivitySources();
  assert.deepEqual(sources.snapshot(), { active: false, terminalProgress: false });
  assert.equal(sources.update({ version: 1, source: "timer-only", active: true, terminalProgress: false }), true);
  assert.deepEqual(sources.snapshot(), { active: true, terminalProgress: false });
  assert.equal(sources.update({ version: 1, source: "progress-only", active: false, terminalProgress: true }), true);
  assert.deepEqual(sources.snapshot(), { active: true, terminalProgress: true });

  assert.equal(sources.update({ version: 1, source: "timer-only", active: false, terminalProgress: false }), true);
  assert.deepEqual(sources.snapshot(), { active: false, terminalProgress: true });
  assert.equal(sources.update({ version: 1, source: "progress-only", active: false, terminalProgress: false }), true);
  assert.deepEqual(sources.snapshot(), { active: false, terminalProgress: false });
});

test("activity sources reject malformed updates, deduplicate, and reset", () => {
  const sources = new AgentActivitySources();
  for (const malformed of [
    undefined,
    {},
    { version: 2, source: "x", active: true, terminalProgress: true },
    { version: 1, source: "", active: true, terminalProgress: true },
    { version: 1, source: "x", active: "yes", terminalProgress: true },
  ]) assert.equal(sources.update(malformed), false);

  const update = { version: 1, source: "x", active: true, terminalProgress: true };
  assert.equal(sources.update(update), true);
  assert.equal(sources.update(update), false);
  assert.equal(sources.clear(), true);
  assert.equal(sources.clear(), false);
});

test("terminal multiplexer ORs native and external state through one underlying writer", () => {
  const calls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => calls.push(active) };
  const original = terminal.setProgress;
  const mux = new TerminalProgressMultiplexer(terminal);

  terminal.setProgress(true); // native starts
  mux.setExternal(true); // already effective: no duplicate
  terminal.setProgress(false); // external keeps it active
  mux.setExternal(false); // last source clears
  assert.deepEqual(calls, [true, false]);

  mux.setExternal(true);
  assert.deepEqual(calls, [true, false, true]);
  mux.dispose(); // clears only the external contribution and restores the method
  assert.deepEqual(calls, [true, false, true, false]);
  assert.equal(terminal.setProgress, original);
});

test("terminal multiplexer disposal preserves an outstanding native request", () => {
  const calls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => calls.push(active) };
  const original = terminal.setProgress;
  const mux = new TerminalProgressMultiplexer(terminal);
  terminal.setProgress(true);
  mux.setExternal(true);
  mux.dispose();
  assert.deepEqual(calls, [true]);
  assert.equal(terminal.setProgress, original);
  terminal.setProgress(false);
  assert.deepEqual(calls, [true, false]);
});

test("sequential reload cycles restore and reacquire terminal method ownership exactly once", () => {
  const calls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => calls.push(active) };
  const original = terminal.setProgress;

  const first = new TerminalProgressMultiplexer(terminal);
  assert.notEqual(terminal.setProgress, original);
  first.setExternal(true);
  first.dispose();
  assert.equal(terminal.setProgress, original);

  const second = new TerminalProgressMultiplexer(terminal);
  assert.notEqual(terminal.setProgress, original);
  second.setExternal(true);
  second.dispose();
  assert.equal(terminal.setProgress, original);
  assert.deepEqual(calls, [true, false, true, false]);
});
