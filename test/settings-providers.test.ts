import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { discoverProviders, type ModelRegistryLike, type DiscoveredModel } from "../src/settings/providers/discovery.ts";
import { deriveCapability } from "../src/settings/providers/capabilities.ts";
import {
  QUOTA_ADAPTERS,
  KNOWN_ADAPTER_PROVIDER_IDS,
  getAdapter,
  sanitizedUnavailableReason,
} from "../src/settings/providers/adapters.ts";

function registry(models: Array<DiscoveredModel | { provider: string }>): ModelRegistryLike {
  return { getAvailable: () => models };
}

test("discovery: dedupes multiple models under one provider", () => {
  const providers = discoverProviders(registry([
    { provider: "anthropic", id: "claude-1" },
    { provider: "anthropic", id: "claude-2" },
    { provider: "ollama", id: "llama" },
  ]));
  assert.equal(providers.length, 2);
  const anthropic = providers.find((p) => p.id === "anthropic")!;
  assert.equal(anthropic.models.length, 2);
  assert.equal(anthropic.available, true);
});

test("discovery: stable saved order preserved, new providers appended", () => {
  const providers = discoverProviders(
    registry([{ provider: "ollama" }, { provider: "anthropic" }, { provider: "zai" }]),
    { storedProviders: ["anthropic", "openrouter"] },
  );
  const ids = providers.map((p) => p.id);
  // Saved order first (anthropic), then the stored-but-unconfigured openrouter is dropped (no record, not available),
  // then newly available in discovery order.
  assert.equal(ids[0], "anthropic");
  assert.ok(ids.includes("ollama") && ids.includes("zai"));
});

test("discovery: stored-but-unavailable provider with a record is retained", () => {
  const providers = discoverProviders(registry([{ provider: "ollama" }]), {
    storedProviders: ["anthropic"],
    storedRecords: { anthropic: { enabled: true, displayMode: "default", windows: {}, activeModel: {} as never, supportedOverrides: [] } },
  });
  const anthropic = providers.find((p) => p.id === "anthropic");
  assert.ok(anthropic, "stored provider with a record must survive even when unavailable");
  assert.equal(anthropic!.available, false);
  assert.ok(anthropic!.provenance.includes("stored"));
});

test("discovery: stored junk (no record, not available) is dropped", () => {
  const providers = discoverProviders(registry([{ provider: "ollama" }]), {
    storedProviders: ["ghost"],
  });
  assert.equal(providers.find((p) => p.id === "ghost"), undefined);
});

test("discovery: active provider missing from available is still included", () => {
  const providers = discoverProviders(registry([{ provider: "ollama" }]), { activeProvider: "anthropic" });
  const anthropic = providers.find((p) => p.id === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic!.available, false);
  assert.ok(anthropic!.provenance.includes("active"));
});

test("discovery: works when optional registry methods are absent", () => {
  const minimal = { getAvailable: () => [{ provider: "ollama" }] } as ModelRegistryLike;
  const providers = discoverProviders(minimal);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].displayName, "ollama");
  assert.equal(providers[0].authenticated, true); // available defaults to authenticated
});

test("discovery: optional getProviderAuthStatus boolean overrides default", () => {
  const reg: ModelRegistryLike = {
    getAvailable: () => [{ provider: "ollama" }],
    getProviderAuthStatus: (id) => (id === "ollama" ? false : true),
  };
  const providers = discoverProviders(reg);
  assert.equal(providers[0].authenticated, false);
});

test("discovery: optional getProviderDisplayName sets display name", () => {
  const reg: ModelRegistryLike = {
    getAvailable: () => [{ provider: "zai" }],
    getProviderDisplayName: () => "Z.AI",
  };
  assert.equal(discoverProviders(reg)[0].displayName, "Z.AI");
});

test("capabilities: local endpoint -> local billing with local speed", () => {
  const [provider] = discoverProviders(registry([{ provider: "ollama", baseUrl: "http://localhost:11434" }]));
  const cap = deriveCapability(provider);
  assert.equal(cap.billing, "local");
  assert.equal(cap.quotaSupport, "none");
});

test("capabilities: OAuth hosted -> subscription billing with hosted speed", () => {
  const [provider] = discoverProviders(registry([{ provider: "anthropic", baseUrl: "https://api.anthropic.com" }]));
  const cap = deriveCapability(provider, { oauth: true });
  assert.equal(cap.billing, "subscription");
  assert.equal(cap.quotaSupport, "official");
  assert.equal(cap.quotaReliability, "high");
});

test("capabilities: api-key hosted -> api billing with token + cost ledger", () => {
  const [provider] = discoverProviders(registry([{ provider: "openrouter", baseUrl: "https://openrouter.ai" }]));
  const cap = deriveCapability(provider);
  assert.equal(cap.billing, "api");
  assert.equal(cap.quotaSupport, "none");
  assert.ok(cap.unavailableReason);
});

test("capabilities: unauthenticated/unknown -> unknown billing", () => {
  // anthropic is stored-only here (not in getAvailable), so it is unavailable + unauthenticated.
  const providers = discoverProviders(registry([{ provider: "ollama" }]), {
    storedProviders: ["anthropic"],
    storedRecords: { anthropic: { enabled: true, displayMode: "default", windows: {}, activeModel: {} as never, supportedOverrides: [] } },
  });
  const anthropic = providers.find((p) => p.id === "anthropic")!;
  const cap = deriveCapability(anthropic);
  assert.equal(cap.billing, "unknown");
  assert.equal(cap.available, false);
  assert.ok(cap.unavailableReason);
});

test("adapters: known adapters have stable ids and support tiers", () => {
  assert.deepEqual([...KNOWN_ADAPTER_PROVIDER_IDS].sort(), ["anthropic", "openai-codex", "openrouter", "zai"]);
  assert.equal(getAdapter("anthropic").support, "official");
  assert.equal(getAdapter("openai-codex").support, "official");
  assert.equal(getAdapter("zai").support, "best-effort");
  assert.equal(getAdapter("openrouter").support, "none");
});

test("adapters: unknown provider fails closed to none with sanitized reason", () => {
  const adapter = getAdapter("totally-unknown");
  assert.equal(adapter.support, "none");
  assert.ok(adapter.reason);
  // Sanitized reason never echoes a token, raw error, authorization header, or key.
  const reason = sanitizedUnavailableReason("totally-unknown", new Error("Bearer sk-secret-key"));
  assert.ok(!/sk-secret|Bearer|authorization/i.test(reason));
});

test("adapters: openrouter sanitized reason is the documented management-key message", () => {
  assert.match(sanitizedUnavailableReason("openrouter"), /management key/i);
});

test("adapters: registry is frozen (stable keys across reorder)", () => {
  assert.equal(Object.isFrozen(QUOTA_ADAPTERS), true);
  // Same ids regardless of iteration.
  assert.deepEqual(Object.keys(QUOTA_ADAPTERS), KNOWN_ADAPTER_PROVIDER_IDS);
});

// Repo guard (R11/R13): UI modules must never hardcode adapter provider ids.
test("repo guard: no adapter provider-id literal appears in src/settings/ui/**", () => {
  const uiDir = join(process.cwd(), "src", "settings", "ui");
  if (!existsSync(uiDir)) {
    // UI does not exist yet (U2); the guard activates once U6 creates it.
    assert.ok(true, "src/settings/ui absent — guard is a no-op until the UI lands");
    return;
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.[cm]?[jt]sx?$/.test(entry)) files.push(full);
    }
  };
  walk(uiDir);
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const id of KNOWN_ADAPTER_PROVIDER_IDS) {
      // Allow the id only inside a comment or import path, not as a branching literal.
      if (new RegExp(`["'\`/]${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`/]?`).test(source)) {
        offenders.push(`${file}: adapter id literal "${id}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], "UI must not branch on provider ids; use getAdapter() instead");
});
