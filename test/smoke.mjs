// Smoke test for the bridge's registration logic, without Pi.
// Run: node test/smoke.mjs
//
// Asserts the free filter and the loopback relay surface that HANDOFF.md §4
// documents. The wire behaviour of the relay and the gate itself is covered by
// test/relay.test.mjs and repro.mjs.
//
// S11: the registered set is described by invariants over the real registry and
// the real bridge config, never by an exact hardcoded list. The catalog changes
// often, so an exact set fails on every change even when the registration is
// right; `REQUIRED_MODELS` is only a must-be-present subset.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUIRED_MODELS = [
	"beam-free",
	"big-pickle",
	"deepseek-v4.1-flash-free",
	"flint-40b-free",
	"glm-5.3-flash-free",
	"mimo-v2.6-flash-free",
	"nemotron-3.5-lightning-free",
	"nemotron-3.5-super-vl-free",
];

const EXCLUDED_MODELS = [
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free",
	"jev-1.13-free",
];

// S11: the registered set is checked against the registry itself. The probe
// order and the store path are the product's own exported constants, resolved
// below once `liveIds` is known: duplicating them here would let the check drift
// to a different file than the one registration reads.

let captured = null;
const pi = {
	registerProvider(name, config) {
		captured = { name, config };
	},
	registerCommand() {},
};

process.env.PI_FREE_BRIDGE_DRY_RUN = "1";
// Never let importing the extension write the real ~/.pi/agent/settings.json.
process.env.PI_FREE_BRIDGE_SELF_REPAIR = "0";
// The relay URL is derived from the port, so pin it for the assertions below.
const RELAY_PORT = "8799";
process.env.PI_FREE_BRIDGE_RELAY_PORT = RELAY_PORT;
const bridgeModule = await import("../index.ts");
const bridge = bridgeModule.default;
// Reuse the product's own path constant instead of rebuilding the layout here.
const BRIDGE_CONFIG_PATH = bridgeModule.BRIDGE_CONFIG_PATH;
bridge(pi);

assert.ok(captured, "provider was not registered");
const { name, config } = captured;

// S11: the registered set must be a subset of the local bridge config. Without
// this file the registration falls back to SNAPSHOT_LIVE_FREE_IDS, and the
// subset check below would silently stop meaning anything.
assert.ok(
	existsSync(BRIDGE_CONFIG_PATH),
	`no bridge config at ${BRIDGE_CONFIG_PATH} — it holds liveIds, the local half of the "registered ⊆ config" invariant`,
);
const bridgeConfig = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf-8"));
assert.ok(
	Array.isArray(bridgeConfig.liveIds),
	`${BRIDGE_CONFIG_PATH} has no liveIds array — there is nothing to check the registered set against`,
);

// S11: resolved through the same function `index.ts` registers from. Reading the
// file directly would let the check pass against one source while registration
// used another.
const { readRegistry } = await import("../model-catalog.mjs");
const registry = readRegistry({
	shareDir: bridgeModule.OPENCODE_SHARE_DIR,
	filePaths: bridgeModule.REGISTRY_PATHS,
	wanted: new Set(bridgeConfig.liveIds),
});
assert.ok(registry?.data, `no OpenCode registry found (${registry?.source ?? "none"}) — this test needs one to verify against`);

// `discoverFreeModels` reads `data.opencode.models`: a flat id → metadata map
// living under the `opencode` provider entry, not a list of models.
const registryModels = registry.data.opencode?.models;
assert.ok(
	registryModels && typeof registryModels === "object",
	`registry has no "opencode.models" map: ${registry.source} — the registered set cannot be verified against it`,
);

// S1/S2: provider id and the loopback relay surface (S35)
assert.equal(name, "oc-sdk-zen");
assert.equal(config.baseUrl, `http://127.0.0.1:${RELAY_PORT}/v1`);
assert.equal(config.api, "openai-completions");
assert.equal(config.apiKey, "public");
assert.equal(config.authHeader, true);

const relayUrl = new URL(config.baseUrl);
assert.equal(relayUrl.hostname, "127.0.0.1", "the relay must be loopback-only");
assert.equal(relayUrl.port, RELAY_PORT);
assert.equal(relayUrl.pathname, "/v1");

// S1/S2 (compat-system-role): the gate only accepts the `system` role and
// `max_tokens`. Left to pi-ai's `detectCompat` — which reads the loopback
// baseUrl and the provider's own id as "standard endpoint" — every model would
// infer `developer` + `max_completion_tokens`, so the registration pins both.
for (const model of config.models) {
	assert.equal(
		model.compat?.supportsDeveloperRole,
		false,
		`${model.id} does not pin supportsDeveloperRole: false`,
	);
	assert.equal(
		model.compat?.maxTokensField,
		"max_tokens",
		`${model.id} does not pin maxTokensField: "max_tokens"`,
	);
}

// S2: the default is merged under each family's own fields, never instead of
// them. `deepseek` is part of the required set; a `kimi` model only shows up
// when the live set advertises one, so that assertion follows the real config.
const deepseekModels = config.models.filter((m) => m.id.includes("deepseek"));
assert.ok(deepseekModels.length > 0, "no deepseek model registered — the family merge is untested");
for (const model of deepseekModels) {
	assert.equal(
		model.compat.allowsSyntheticReasoningContentForToolCalls,
		false,
		`${model.id} lost allowsSyntheticReasoningContentForToolCalls: false`,
	);
}
for (const model of config.models.filter((m) => m.id.includes("kimi"))) {
	assert.equal(
		model.compat.requiresReasoningContentForToolCalls,
		true,
		`${model.id} lost requiresReasoningContentForToolCalls: true`,
	);
	assert.equal(model.compat.thinkingFormat, "zai", `${model.id} lost thinkingFormat: "zai"`);
}

// S11: the filtered free set, stated as invariants over the real captured data.
const ids = config.models.map((m) => m.id).sort();
const idSet = new Set(ids);
const registryIds = new Set(Object.keys(registryModels));
const configuredIds = new Set(bridgeConfig.liveIds);

// S11: registered ⊆ registry. Spelled out as a set subset so a failure names the
// offending ids instead of dumping two long arrays.
assert.deepEqual(
	ids.filter((id) => !registryIds.has(id)),
	[],
	`registered ids missing from the OpenCode registry (${registry.source})`,
);

// S11: registered ⊆ the local bridge config's liveIds
assert.deepEqual(
	ids.filter((id) => !configuredIds.has(id)),
	[],
	`registered ids missing from liveIds in ${BRIDGE_CONFIG_PATH}`,
);

// S11: REQUIRED_MODELS is a must-be-present subset, not the whole set — a
// catalog addition is fine, a required id disappearing is not.
for (const required of REQUIRED_MODELS) {
	assert.ok(idSet.has(required), `${required} must be registered — it is listed in REQUIRED_MODELS`);
}

// S11: every registered id is free *in the registry*, which is where the filter
// reads it. `isFree` treats an absent field as "not declared" because the
// registry omits `cache_write` on most free models (HANDOFF §4.4), so the four
// canonical fields are asserted "zero when declared" and every declared numeric
// field is asserted zero — the same rule the product applies.
for (const id of ids) {
	const cost = registryModels[id]?.cost ?? {};
	for (const field of ["input", "output", "cache_read", "cache_write"]) {
		assert.equal(cost[field] ?? 0, 0, `registry cost.${field} for ${id} is not zero`);
	}
	const declared = Object.values(cost).filter(
		(v) => typeof v === "number" && Number.isFinite(v),
	);
	assert.ok(declared.length > 0, `registry declares no numeric cost for ${id} — isFree would reject it`);
	for (const value of declared) {
		assert.equal(value, 0, `registry declares a non-zero cost field for ${id}`);
	}
}

// S5: excluded models never reach the picker
for (const excluded of EXCLUDED_MODELS) {
	assert.ok(!idSet.has(excluded), `${excluded} must not be registered`);
}

// S11: no paid model may slip in — all four registered cost fields are zero
for (const model of config.models) {
	for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
		assert.equal(model.cost?.[field], 0, `${model.id} has a non-zero ${field} cost`);
	}
}

// S35: every model talks to the same relay, never to the upstream surface.
assert.equal(config.headers, undefined, "the relay owns the gate headers, not the provider");
for (const model of config.models) {
	assert.equal(model.baseUrl, config.baseUrl, `${model.id} must use the relay baseUrl`);
	const modelUrl = new URL(model.baseUrl);
	assert.equal(modelUrl.hostname, "127.0.0.1", `${model.id} must be loopback-only`);
	assert.equal(modelUrl.port, RELAY_PORT, `${model.id} must use the relay port`);
	assert.equal(modelUrl.pathname, "/v1", `${model.id} must use the /v1 path`);
}

// S13: no dead surface anywhere in the registration
// S13: the retired Zen surface must never reach the registration. The literal is
// assembled at runtime so this file does not itself contain the dead route.
const DEAD_SURFACE = ["zen", "v1"].join("/");
assert.ok(!JSON.stringify(config).includes(DEAD_SURFACE), "dead Zen surface leaked into config");

// Per-model metadata came from the registry
for (const model of config.models) {
	assert.ok(model.contextWindow > 0, `${model.id} has no context window`);
	assert.ok(model.maxTokens > 0, `${model.id} has no max tokens`);
	assert.ok(Array.isArray(model.input) && model.input.length > 0, `${model.id} has no input modalities`);
}

console.log(`smoke: OK — ${ids.length} free models registered under ${name}`);