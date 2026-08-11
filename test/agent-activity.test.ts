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

test("terminal multiplexer reasserts effective progress after a transport restart", () => {
  const calls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => calls.push(active) };
  const mux = new TerminalProgressMultiplexer(terminal);

  mux.reassert();
  assert.deepEqual(calls, [], "idle transport restarts stay idle");

  mux.setExternal(true);
  mux.reassert();
  terminal.setProgress(true); // overlapping native source does not duplicate the logical edge
  mux.reassert();
  assert.deepEqual(calls, [true, true, true]);

  terminal.setProgress(false); // external source still owns progress
  mux.setExternal(false);
  mux.reassert();
  assert.deepEqual(calls, [true, true, true, false], "settled state is not spuriously reasserted");
});

test("terminal multiplexer reasserts native-only progress", () => {
  const calls: boolean[] = [];
  const terminal = { setProgress: (active: boolean) => calls.push(active) };
  const mux = new TerminalProgressMultiplexer(terminal);
  terminal.setProgress(true);
  mux.reassert();
  assert.deepEqual(calls, [true, true]);
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

test("overlapping reload takes terminal ownership without retaining the stale wrapper", () => {
  const calls: boolean[] = [];
  const transportSetProgress = (active: boolean) => calls.push(active);
  const terminal = { setProgress: transportSetProgress };

  const first = new TerminalProgressMultiplexer(terminal);
  first.setExternal(true);
  const second = new TerminalProgressMultiplexer(terminal);

  second.setExternal(true);
  transportSetProgress(false); // ProcessTerminal.stop() clears the physical transport.
  second.reassert();
  assert.deepEqual(calls, [true, false, true], "the replacement delegates to the real transport");

  const replacementMethod = terminal.setProgress;
  first.dispose();
  assert.equal(terminal.setProgress, replacementMethod, "stale teardown cannot remove the new owner");
  second.dispose();
  assert.equal(terminal.setProgress, transportSetProgress);
  assert.deepEqual(calls, [true, false, true, false]);
});

test("overlapping reload stays owner-safe when the replacement tears down first", () => {
  const calls: boolean[] = [];
  const transportSetProgress = (active: boolean) => calls.push(active);
  const terminal = { setProgress: transportSetProgress };

  const first = new TerminalProgressMultiplexer(terminal);
  first.setExternal(true);
  const second = new TerminalProgressMultiplexer(terminal);
  second.setExternal(true);
  second.dispose();
  assert.equal(terminal.setProgress, transportSetProgress);

  first.dispose();
  assert.equal(terminal.setProgress, transportSetProgress);
  assert.deepEqual(calls, [true, false]);
});

test("retained stale wrappers route native progress and starts through the replacement owner", () => {
  const calls: Array<boolean | "start"> = [];
  const transportSetProgress = (active: boolean) => calls.push(active);
  const transportStart = () => calls.push("start");
  const terminal = { setProgress: transportSetProgress, start: transportStart };

  const first = new TerminalProgressMultiplexer(terminal);
  const staleSetProgress = terminal.setProgress;
  const staleStart = terminal.start;
  first.setExternal(true);

  const second = new TerminalProgressMultiplexer(terminal);
  second.setExternal(true);
  staleSetProgress(false);
  assert.deepEqual(calls, [true], "stale native calls still honor the current external union");

  transportSetProgress(false); // ProcessTerminal.stop()
  staleStart();
  assert.deepEqual(calls, [true, false, "start", true], "stale starts reassert through the current owner");

  first.dispose();
  second.dispose();
  assert.equal(terminal.setProgress, transportSetProgress);
  assert.equal(terminal.start, transportStart);
});

test("terminal restart reasserts progress only after the transport starts", () => {
  const calls: Array<boolean | "start"> = [];
  const transportSetProgress = (active: boolean) => calls.push(active);
  const transportStart = () => calls.push("start");
  const terminal = { setProgress: transportSetProgress, start: transportStart };
  const mux = new TerminalProgressMultiplexer(terminal);

  mux.setExternal(true);
  transportSetProgress(false); // ProcessTerminal.stop()
  assert.deepEqual(calls, [true, false]);

  terminal.start();
  assert.deepEqual(calls, [true, false, "start", true]);

  mux.setExternal(false);
  mux.dispose();
  assert.equal(terminal.setProgress, transportSetProgress);
  assert.equal(terminal.start, transportStart);
});
