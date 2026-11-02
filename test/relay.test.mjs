// Tests for the pure helpers of `relay.mjs`.
//
// Run: node --test test/relay.test.mjs
//
// The relay is the Bun process that makes the upstream call (GATE-DIAGNOSIS.md
// §5). Its server half cannot be exercised without Bun and the network, so the
// helpers are exported and covered here under plain Node: importing the module
// must not start a server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ensureEnvBlock,
	ensureGateTools,
	resolveRelaySession,
	resolveSessionFromStore,
	toUpstreamUrl,
} from "../relay.mjs";

// ---------------------------------------------------------------------------
// ensureEnvBlock (S21)
// ---------------------------------------------------------------------------

const CWD = "C:\\Users\\Polanco\\pi-free-bridge";
const POSIX_CWD = "C:/Users/Polanco/pi-free-bridge";
const ENV_LINE = `<env>\n  Working directory: ${POSIX_CWD}\n  Platform: win32\n</env>`;

test("ensureEnvBlock: appends the env block to a system message without one", () => {
	const messages = [
		{ role: "system", content: "You are a helpful assistant." },
		{ role: "user", content: "hi" },
	];

	const result = ensureEnvBlock(messages, CWD);

	assert.equal(result.length, 2);
	assert.equal(
		result[0].content,
		`You are a helpful assistant.\n\n${ENV_LINE}`,
		"the block must be appended after a blank line",
	);
	assert.equal(result[1], messages[1], "unrelated messages must be reused as-is");
});

test("ensureEnvBlock: leaves a conforming block untouched (idempotent)", () => {
	const content = `You are Pi.\n\n${ENV_LINE}`;
	const messages = [{ role: "system", content }];

	const result = ensureEnvBlock(messages, "C:\\somewhere\\else");

	assert.deepEqual(result, messages, "a conforming block must not be duplicated");
	assert.equal(result[0].content, content, "the system prompt must survive untouched");
});

test("ensureEnvBlock: accepts the developer role", () => {
	const messages = [
		{ role: "developer", content: "rules" },
		{ role: "user", content: "hi" },
	];

	const result = ensureEnvBlock(messages, CWD);

	assert.equal(result[0].role, "developer", "the developer message keeps its role");
	assert.match(result[0].content, /Working directory: C:\/Users\/Polanco\/pi-free-bridge/);
	assert.equal(result.length, 2, "no extra message is prepended");
});

test("ensureEnvBlock: prepends a system message when there is none", () => {
	const messages = [{ role: "user", content: "hi" }];

	const result = ensureEnvBlock(messages, CWD);

	assert.equal(result.length, 2);
	assert.deepEqual(result[0], { role: "system", content: ENV_LINE });
	assert.equal(result[1], messages[0], "the original user message must be reused");
});

test("ensureEnvBlock: a non-conforming <env> block still gets a working directory", () => {
	const messages = [
		{ role: "system", content: "<env>\n  Platform: linux\n</env>" },
		{ role: "user", content: "hi" },
	];

	const result = ensureEnvBlock(messages, CWD);

	assert.match(result[0].content, /Working directory: /);
	assert.match(result[0].content, /Platform: win32/);
	assert.equal(result.length, 2);
});

test("ensureEnvBlock: non-string content does not crash and still gets the block", () => {
	const messages = [
		{ role: "system", content: [{ type: "text", text: "parts" }] },
		{ role: "user", content: "hi" },
	];

	const result = ensureEnvBlock(messages, CWD);

	assert.equal(result.length, 2);
	assert.ok(Array.isArray(result[0].content), "the parts array is preserved");
	assert.equal(result[0].content.length, 2, "the block is appended as one more part");
	assert.match(JSON.stringify(result[0].content), /Working directory: /);
});

test("ensureEnvBlock: never mutates the input array or its messages", () => {
	const messages = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "hi" },
	];
	const snapshot = JSON.parse(JSON.stringify(messages));

	ensureEnvBlock(messages, CWD);

	assert.deepEqual(messages, snapshot, "the caller's messages must be untouched");
});

// ---------------------------------------------------------------------------
// ensureGateTools (S22)
// ---------------------------------------------------------------------------

const names = (tools) =>
	tools
		.map((tool) => tool?.function?.name ?? tool?.name)
		.filter((name) => typeof name === "string")
		.sort();

test("ensureGateTools: injects read and bash when tools is absent", () => {
	const body = { model: "m", messages: [] };

	const result = ensureGateTools(body);

	assert.deepEqual(names(result.tools), ["bash", "read"]);
	assert.equal(result.tool_choice, "none");
	assert.equal(body.tools, undefined, "the input body must not be mutated");
});

test("ensureGateTools: injects read and bash when tools is empty", () => {
	const result = ensureGateTools({ tools: [] });

	assert.deepEqual(names(result.tools), ["bash", "read"]);
	assert.equal(result.tool_choice, "none");
});

test("ensureGateTools: leaves a complete tool set unchanged", () => {
	const body = {
		tools: [
			{ type: "function", function: { name: "read", parameters: {} } },
			{ type: "function", function: { name: "bash", parameters: {} } },
		],
	};

	const result = ensureGateTools(body);

	assert.deepEqual(result.tools, body.tools);
	assert.equal(result.tool_choice, undefined, "no override when nothing was injected");
});

test("ensureGateTools: accepts the bare-name tool shape", () => {
	const body = { tools: [{ name: "read" }, { name: "bash" }] };

	const result = ensureGateTools(body);

	assert.deepEqual(result.tools, body.tools);
	assert.equal(result.tool_choice, undefined);
});

test("ensureGateTools: appends only the missing declaration", () => {
	const existing = { type: "function", function: { name: "read", parameters: {} } };
	const body = { tools: [existing] };

	const result = ensureGateTools(body);

	assert.deepEqual(names(result.tools), ["bash", "read"]);
	assert.equal(result.tools[0], existing, "the existing declaration must be kept");
	assert.equal(result.tools.length, 2, "no duplicates");
	assert.equal(result.tool_choice, "none");
});

test("ensureGateTools: does not mutate the input body", () => {
	const body = { tools: [{ name: "read" }], model: "m" };
	const snapshot = JSON.parse(JSON.stringify(body));

	ensureGateTools(body);

	assert.deepEqual(body, snapshot);
});

// ---------------------------------------------------------------------------
// toUpstreamUrl
// ---------------------------------------------------------------------------

const BASE = "https://opencode.ai/inference/v1";

test("toUpstreamUrl: does not double /v1", () => {
	assert.equal(
		toUpstreamUrl(BASE, "/v1/chat/completions"),
		"https://opencode.ai/inference/v1/chat/completions",
	);
});

test("toUpstreamUrl: preserves other /v1 paths", () => {
	assert.equal(toUpstreamUrl(BASE, "/v1/models"), `${BASE}/models`);
	assert.equal(toUpstreamUrl(BASE, "/v1/responses"), `${BASE}/responses`);
});

test("toUpstreamUrl: joins a path without the /v1 prefix", () => {
	assert.equal(toUpstreamUrl(BASE, "/chat/completions"), `${BASE}/chat/completions`);
});

test("toUpstreamUrl: keeps /v1 when the base does not end with it", () => {
	assert.equal(toUpstreamUrl("https://example.test/gateway", "/v1/chat/completions"), "https://example.test/gateway/v1/chat/completions");
});

test("toUpstreamUrl: tolerates a trailing slash on the base", () => {
	assert.equal(toUpstreamUrl(`${BASE}/`, "/v1/chat/completions"), `${BASE}/chat/completions`);
});

// ---------------------------------------------------------------------------
// Session harvest (S31, S36)
// ---------------------------------------------------------------------------

/** A throwaway OpenCode-shaped store. No SQLite fixture: the DB path is only
 *  exercised through its fall-through behaviour. */
function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	mkdirSync(join(dir, "storage", "session_diff"), { recursive: true });
	return dir;
}

function writeDiff(store, name, mtimeSeconds) {
	const file = join(store, "storage", "session_diff", name);
	writeFileSync(file, "{}");
	utimesSync(file, mtimeSeconds, mtimeSeconds);
}

test("resolveSessionFromStore: empty store resolves nothing", async () => {
	const result = await resolveSessionFromStore({ shareDir: makeStore() });
	assert.equal(result, undefined);
});

test("resolveSessionFromStore: missing store directory resolves nothing", async () => {
	const result = await resolveSessionFromStore({ shareDir: join(tmpdir(), "pfb-relay-does-not-exist") });
	assert.equal(result, undefined);
});

test("resolveSessionFromStore: falls back to a session_diff file when the DB is absent", async () => {
	const store = makeStore();
	writeDiff(store, "ses_testfallback0000000000000.json", 1_600_000_000);

	const result = await resolveSessionFromStore({ shareDir: store });

	assert.deepEqual(result, { sessionId: "ses_testfallback0000000000000", source: "session-diff" });
});

test("resolveSessionFromStore: the newest session_diff file wins by mtime", async () => {
	const store = makeStore();
	writeDiff(store, "ses_testolder0000000000000000.json", 1_600_000_000);
	writeDiff(store, "ses_testnewer0000000000000000.json", 1_700_000_000);

	const result = await resolveSessionFromStore({ shareDir: store });

	assert.equal(result?.sessionId, "ses_testnewer0000000000000000");
	assert.equal(result?.source, "session-diff");
});

test("resolveSessionFromStore: ignores session_diff files that are not ses_*.json", async () => {
	const store = makeStore();
	writeDiff(store, "notes.json", 1_700_000_000);
	writeDiff(store, "ses_missing-extension", 1_700_000_000);

	const result = await resolveSessionFromStore({ shareDir: store });

	assert.equal(result, undefined);
});

// Importing the module must not have started the server: if it had, this test
// file would never exit. This assertion documents that contract explicitly.
test("importing relay.mjs has no side effects", () => {
	assert.equal(typeof ensureEnvBlock, "function");
	assert.equal(typeof ensureGateTools, "function");
	assert.equal(typeof resolveSessionFromStore, "function");
	assert.equal(typeof toUpstreamUrl, "function");
});

// ---------------------------------------------------------------------------
// resolveRelaySession precedence (bun-upgrades S2)
// ---------------------------------------------------------------------------

function writeStore(shareDir, files) {
	mkdirSync(join(shareDir, "storage", "session_diff"), { recursive: true });
	for (const [name, when] of files) {
		writeFileSync(join(shareDir, "storage", "session_diff", name), "{}");
		utimesSync(join(shareDir, "storage", "session_diff", name), when, when);
	}
}

test("resolveRelaySession: user override wins over a Pi-supplied id", async () => {
	process.env.RELAY_SESSION = "ses_override";
	process.env.RELAY_SESSION_SOURCE = "env";
	process.env.RELAY_SESSION_PI = "ses_pi_harvest";
	try {
		const result = await resolveRelaySession({ shareDir: join(tmpdir(), "pfb-empty-none-00") });
		assert.equal(result.sessionId, "ses_override");
		assert.equal(result.source, "env");
	} finally {
		delete process.env.RELAY_SESSION;
		delete process.env.RELAY_SESSION_SOURCE;
		delete process.env.RELAY_SESSION_PI;
	}
});

test("resolveRelaySession: Pi-supplied id beats the relay's local store", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	writeStore(shareDir, [["ses_local.json", new Date("2026-01-01")]]);
	process.env.RELAY_SESSION_PI = "ses_pi_harvest";
	try {
		const result = await resolveRelaySession({ shareDir });
		assert.equal(result.sessionId, "ses_pi_harvest");
		assert.equal(result.source, "pi-harvest");
	} finally {
		delete process.env.RELAY_SESSION_PI;
	}
});

test("resolveRelaySession: without a Pi-supplied id, the relay harvests locally", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	writeStore(shareDir, [["ses_local.json", new Date("2026-01-01")]]);
	const result = await resolveRelaySession({ shareDir });
	assert.equal(result.sessionId, "ses_local");
	assert.equal(result.source, "session-diff");
});

// ---------------------------------------------------------------------------
// Egress selection (bun-upgrades S5)
// ---------------------------------------------------------------------------

import { egressOrder, updateWarpPreference, WARP_MODES } from "../relay.mjs";

test("egressOrder: off is always local-only", () => {
	assert.deepEqual(egressOrder("off", false), ["local"]);
	assert.deepEqual(egressOrder("off", true), ["local"]);
});

test("egressOrder: on is always warp-only", () => {
	assert.deepEqual(egressOrder("on", false), ["warp"]);
});

test("egressOrder: auto starts local and elevates after a warp-only success", () => {
	assert.deepEqual(egressOrder("auto", false), ["local", "warp"]);
	assert.deepEqual(egressOrder("auto", true), ["warp", "local"]);
});

test("egressOrder: unknown mode falls back to off", () => {
	assert.deepEqual(egressOrder("banana", false), ["local"]);
});

test("updateWarpPreference: auto elevates when warp was the final egress", () => {
	assert.equal(updateWarpPreference("auto", "warp", true), true);
	assert.equal(updateWarpPreference("auto", "local", true), false);
	assert.equal(updateWarpPreference("off", "warp", true), false);
});

test("updateWarpPreference: a failure never elevates warp", () => {
	assert.equal(updateWarpPreference("auto", "warp", false), false);
});

test("WARP_MODES: exactly off, auto, on", () => {
	assert.deepEqual(WARP_MODES, ["off", "auto", "on"]);
});

// ---------------------------------------------------------------------------
// Hot warp-mode resolution (relay-warp-hot-reload)
// ---------------------------------------------------------------------------

import {
	bumpWarp429Streak,
	needsWarpRecycle,
	readFileWarpMode,
	resolveWarpModeHot,
} from "../relay.mjs";

test("resolveWarpModeHot: override wins over the file value", () => {
	assert.equal(resolveWarpModeHot("on", "off"), "on");
});

test("resolveWarpModeHot: override is normalized before it wins", () => {
	assert.equal(resolveWarpModeHot("  ON ", "off"), "on");
});

test("resolveWarpModeHot: a valid file value wins when there is no override", () => {
	assert.equal(resolveWarpModeHot(undefined, "auto"), "auto");
	assert.equal(resolveWarpModeHot("", "on"), "on");
});

test("resolveWarpModeHot: a garbage file value falls through to off", () => {
	assert.equal(resolveWarpModeHot(undefined, "banana"), "off");
	assert.equal(resolveWarpModeHot(undefined, undefined), "off");
	assert.equal(resolveWarpModeHot("", ""), "off");
});

test("resolveWarpModeHot: a garbage override falls through to the file value", () => {
	assert.equal(resolveWarpModeHot("banana", "auto"), "auto");
});

test("readFileWarpMode: reads warpEnabled from the extension's config file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	const file = join(dir, "config.json");
	writeFileSync(file, JSON.stringify({ warpEnabled: "on" }));
	assert.equal(readFileWarpMode(file), "on");
});

test("readFileWarpMode: a file value outside WARP_MODES is rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	const file = join(dir, "config.json");
	writeFileSync(file, JSON.stringify({ warpEnabled: "banana" }));
	assert.equal(readFileWarpMode(file), undefined);
});

test("readFileWarpMode: a malformed config file never throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	const file = join(dir, "config.json");
	writeFileSync(file, "{ not json");
	assert.equal(readFileWarpMode(file), undefined);
});

test("bumpWarp429Streak: only warp-egress outcomes move the streak", () => {
	assert.equal(bumpWarp429Streak(0, 429, "warp"), 1);
	assert.equal(bumpWarp429Streak(1, 429, "warp"), 2);
	assert.equal(bumpWarp429Streak(2, 429, "local"), 2);
	assert.equal(bumpWarp429Streak(3, 429, "local"), 3);
});

test("bumpWarp429Streak: only a warp-egress success resets it — a local fallback 200 does not erase warp 429s", () => {
	assert.equal(bumpWarp429Streak(2, 200, "warp"), 0);
	// auto mode: warp 429 -> local fallback delivers 200; the streak must survive
	assert.equal(bumpWarp429Streak(2, 200, "local"), 2);
	assert.equal(bumpWarp429Streak(2, 500, "local"), 2);
	assert.equal(bumpWarp429Streak(2, 502, "warp"), 2);
});

test("needsWarpRecycle: fires at the threshold, not during cooldown", () => {
	assert.equal(needsWarpRecycle(2, 3, false), false);
	assert.equal(needsWarpRecycle(3, 3, false), true);
	assert.equal(needsWarpRecycle(5, 3, true), false);
});

test("readFileWarpMode: tolerates a UTF-8 BOM in the config file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	const file = join(dir, "config.json");
	writeFileSync(file, "﻿" + JSON.stringify({ warpEnabled: "auto" }), "utf8");
	assert.equal(readFileWarpMode(file), "auto");
	writeFileSync(file, "﻿" + "{ broken", "utf8");
	assert.equal(readFileWarpMode(file), undefined);
});

test("readFileWarpMode: a missing config file never throws", () => {
	assert.equal(readFileWarpMode(join(tmpdir(), "pfb-relay-nope/x.json")), undefined);
});

// ---------------------------------------------------------------------------
// Extension relay wiring (relay-warp-hot-reload, T3/T5)
// ---------------------------------------------------------------------------
// The extension module is TypeScript; it is imported here the same way
// test/smoke.mjs does it, with the dry-run/self-repair guards set BEFORE the
// import so it never writes the real settings file.

const withIndex = async () => {
	delete process.env.PI_FREE_BRIDGE_WARP_MODE;
	const mod = await import("../index.ts");
	return mod;
};

test("relayKey: the cache key is port and session id only — no warpMode", async () => {
	const { relayKey } = await withIndex();
	assert.equal(relayKey(8788, "ses_abc"), "8788\u0000ses_abc");
	assert.equal(relayKey(8788), "8788\u0000");
});

test("relayEnv: RELAY_WARP_MODE is omitted when there is no env override", async () => {
	const mod = await withIndex();
	const env = mod.relayEnv({ port: 8788, upstream: "https://example.test", cwd: "." });
	assert.equal(env.RELAY_WARP_MODE, undefined);
});

test("relayEnv: a real PI_FREE_BRIDGE_WARP_MODE override is injected as RELAY_WARP_MODE", async () => {
	const mod = await withIndex();
	process.env.PI_FREE_BRIDGE_WARP_MODE = "on";
	try {
		const env = mod.relayEnv({ port: 8788, upstream: "https://example.test", cwd: "." });
		assert.equal(env.RELAY_WARP_MODE, "on");
	} finally {
		delete process.env.PI_FREE_BRIDGE_WARP_MODE;
	}
});

test("relayEnv: RELAY_CONFIG_PATH points at the extension's config file", async () => {
	const mod = await withIndex();
	const env = mod.relayEnv({ port: 8788, upstream: "https://example.test", cwd: "." });
	assert.equal(env.RELAY_CONFIG_PATH, mod.BRIDGE_CONFIG_PATH);
});

test("fetchRelayHealth: parses warpModeSource from the /health payload", async () => {
	const { fetchRelayHealth } = await withIndex();
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				service: "pi-free-bridge-relay",
				ok: true,
				sessionId: "ses_x",
				sessionSource: "env",
				warpMode: "auto",
				warpModeSource: "config",
				lastEgress: "local",
				pid: 1234,
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const health = await fetchRelayHealth(server.address().port);
		assert.equal(health?.warpMode, "auto");
		assert.equal(health?.warpModeSource, "config");
	} finally {
		server.close();
	}
});

test("fetchRelayHealth: an old relay without warpModeSource reads as undefined", async () => {
	const { fetchRelayHealth } = await withIndex();
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({ service: "pi-free-bridge-relay", ok: true, warpMode: "off", pid: 1234 }),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const health = await fetchRelayHealth(server.address().port);
		assert.equal(health?.warpMode, "off");
		assert.equal(health?.warpModeSource, undefined);
	} finally {
		server.close();
	}
});
