import assert from "node:assert/strict";
import test from "node:test";
import { contextSeverity, deriveContext, deriveEffort, deriveModel, deriveProject, isLocalEndpoint } from "../src/derive.ts";

test("derives project, model, and effort applicability", () => {
  assert.equal(deriveProject("/tmp/pi-statusline"), "pi-statusline");
  assert.equal(deriveModel({ id: "claude-sonnet-4-5" }), "claude-sonnet-4-5");
  assert.equal(deriveModel(undefined), "");
  assert.equal(deriveEffort("off", { reasoning: false }), "");
  assert.equal(deriveEffort("off", { reasoning: true }), "off");
  assert.equal(deriveEffort("high", { reasoning: true }), "high");
});

test("treats loopback/LAN endpoints as local, hosted providers as not", () => {
  assert.equal(isLocalEndpoint("http://localhost:11434/v1"), true);
  assert.equal(isLocalEndpoint("http://127.0.0.1:8080"), true);
  assert.equal(isLocalEndpoint("http://192.168.1.50:1234/v1"), true);
  assert.equal(isLocalEndpoint("https://api.anthropic.com"), false);
  assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isLocalEndpoint(undefined), false);
  assert.equal(isLocalEndpoint("not a url"), false);
});

test("context uses provided percent/window and hides unavailable values", () => {
  assert.deepEqual(deriveContext({ tokens: 110_000, percent: 55, contextWindow: 200_000 }), {
    label: "55.0%/200K",
    percent: 55,
    tokens: 110_000,
  });
  assert.equal(deriveContext(undefined), undefined);
  assert.equal(deriveContext({ tokens: null, percent: null, contextWindow: 200_000 }), undefined);
});

test("context severity warns on absolute tokens and small-window percentages", () => {
  assert.equal(contextSeverity({ percent: 17, tokens: 170_000 }), "error");
  assert.equal(contextSeverity({ percent: 13, tokens: 130_000 }), "warning");
  assert.equal(contextSeverity({ percent: 11, tokens: 119_999 }), "success");
  // Small-window models still redline on percent under the absolute thresholds.
  assert.equal(contextSeverity({ percent: 92, tokens: 50_000 }), "error");
  assert.equal(contextSeverity({ percent: 80, tokens: 50_000 }), "warning");
});
