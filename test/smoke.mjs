// Smoke test for the bridge's registration logic, without Pi.
// Run: node test/smoke.mjs
//
// Asserts the free filter and the loopback relay surface that HANDOFF.md §4
// documents. The wire behaviour of the relay and the gate itself is covered by
// test/relay.test.mjs and repro.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

const registryExists = [
	join(homedir(), ".cache", "opencode", "models.json"),
	join(homedir(), ".config", "opencode", "models.json"),
].some(existsSync);
assert.ok(registryExists, "no OpenCode registry found — run this on a machine with opencode installed");

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
const bridge = (await import("../index.ts")).default;
bridge(pi);

assert.ok(captured, "provider was not registered");
const { name, config } = captured;

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

// S3/S10: exactly the filtered free set
const ids = config.models.map((m) => m.id).sort();
assert.deepEqual(ids, [...REQUIRED_MODELS].sort(), `unexpected model set: ${ids.join(", ")}`);

// S5: excluded models never reach the picker
for (const excluded of EXCLUDED_MODELS) {
	assert.ok(!ids.includes(excluded), `${excluded} must not be registered`);
}

// No paid model may slip in
for (const model of config.models) {
	assert.equal(model.cost.input, 0, `${model.id} has a non-zero input cost`);
	assert.equal(model.cost.output, 0, `${model.id} has a non-zero output cost`);
}

// S35: every model talks to the same relay, never to the upstream surface.
assert.equal(config.headers, undefined, "the relay owns the gate headers, not the provider");
for (const model of config.models) {
	assert.equal(model.baseUrl, config.baseUrl, `${model.id} must use the relay baseUrl`);
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