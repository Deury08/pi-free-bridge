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
	forwardedHeaders,
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
	assert.equal(updateWarpPreference("auto", "warp", 200), true);
	assert.equal(updateWarpPreference("auto", "local", 200), false);
	assert.equal(updateWarpPreference("off", "warp", 200), false);
});

test("updateWarpPreference: only a success status may elevate warp", () => {
	// A 429 delivered via warp used to pin warp as preferred, because the call
	// site passed `true` for `ok` unconditionally. The status is the argument
	// now, so that mistake cannot be written again.
	assert.equal(updateWarpPreference("auto", "warp", 429), false);
	assert.equal(updateWarpPreference("auto", "warp", 500), false);
	assert.equal(updateWarpPreference("auto", "warp", 200), true);
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

test("needsWarpRecycle: rotates on the FIRST warp 429, never during cooldown", () => {
	// The meter has exactly one correct value: rotate on the first 429. Any
	// larger threshold would deliver that many 429s before the exit rotates,
	// which is strictly worse once the relay resends after a rotation.
	assert.equal(needsWarpRecycle(0, false), false);
	assert.equal(needsWarpRecycle(1, false), true);
	assert.equal(needsWarpRecycle(4, false), true);
	assert.equal(needsWarpRecycle(1, true), false);
	assert.equal(needsWarpRecycle(9, true), false);
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
// Resend after a confirmed warp rotation (S5, S6, S7, S10, S18)
// ---------------------------------------------------------------------------
// The relay only spends its one resend once the proxy has proven that a fresh
// exit was enrolled. These helpers are that whole decision, kept pure so the
// `recycling: false` false-positive cannot come back.

import {
	isRotationConfirmed,
	resetWarpStateForTests,
	resendAfterRotation,
	rotateWarpExit,
	setWarpRotationTimingForTests,
	warpHealthState,
	warpHealthUrl,
	warpResendEnabled,
	warpStateForTests,
} from "../relay.mjs";

// Verbatim shape of warp-minimal's /health (L26). The published entry is
// `<name> (<state>, streams=N)`: only the name is identity (D1), and for this
// proxy even that name is a fixed pool label (L26), so the usable signal is the
// `recycling` window, never the entry.
const WARP_HEALTH_SAMPLE =
	'{"active":1,"cooling_down":0,"exits":["warp-18e (in_use, streams=1)"],"healthy":1,"ok":true,"pool_size":2,"recycling":false}';

test("warpHealthUrl: defaults to /health on the default proxy", () => {
	assert.equal(warpHealthUrl(undefined, undefined), "http://127.0.0.1:8789/health");
	assert.equal(warpHealthUrl("", ""), "http://127.0.0.1:8789/health");
});

test("warpHealthUrl: trims the proxy and strips trailing slashes", () => {
	assert.equal(warpHealthUrl(" http://127.0.0.1:8789/ ", "/health"), "http://127.0.0.1:8789/health");
	assert.equal(warpHealthUrl("http://127.0.0.1:8789///", "/health"), "http://127.0.0.1:8789/health");
});

test("warpHealthUrl: honours the health_path from the shared config", () => {
	assert.equal(warpHealthUrl("http://127.0.0.1:9000", "/status"), "http://127.0.0.1:9000/status");
});

test("warpHealthUrl: a path without a leading slash falls back to the default", () => {
	assert.equal(warpHealthUrl("http://127.0.0.1:9000", "status"), "http://127.0.0.1:9000/health");
	assert.equal(warpHealthUrl("http://127.0.0.1:9000", 42), "http://127.0.0.1:9000/health");
});

test("warpHealthState: the real /health sample reduces to recycling + exit names", () => {
	assert.deepEqual(warpHealthState(JSON.parse(WARP_HEALTH_SAMPLE)), {
		recycling: false,
		exits: ["warp-18e"],
	});
});

test("warpHealthState: a non-object body is undefined", () => {
	for (const value of [undefined, null, "body", 42, true, []]) {
		assert.equal(warpHealthState(value), undefined, `${String(value)} must not parse`);
	}
});

test("warpHealthState: recycling is a strict boolean and non-string exits are dropped", () => {
	assert.deepEqual(warpHealthState({ recycling: "true" }), { recycling: false, exits: [] });
	assert.deepEqual(warpHealthState({ recycling: true, exits: ["a", 2, null, {}, "b"] }), {
		recycling: true,
		exits: ["a", "b"],
	});
	assert.deepEqual(warpHealthState({ exits: "warp-18e" }), { recycling: false, exits: [] });
});

const EXIT_NAME = "warp-18e";
const BEFORE = { recycling: false, exits: [EXIT_NAME] };
const NOT_RECYCLING = { recycling: false, exits: [EXIT_NAME] };

test("warpHealthState: an exit name is cut at the first space or paren and empties are dropped", () => {
	assert.deepEqual(
		warpHealthState({ exits: ["  warp-18e4af (idle, streams=0) ", "warp-19a\t(in_use)", "native", ""] }),
		{ recycling: false, exits: ["warp-18e4af", "warp-19a", "native"] },
	);
	assert.deepEqual(warpHealthState({ exits: ["   ", "(in_use, streams=1)"] }), {
		recycling: false,
		exits: [],
	});
});

test("isRotationConfirmed: an invalid health or an in-progress recycle is not a confirmation", () => {
	assert.equal(isRotationConfirmed(BEFORE, undefined, true), false);
	assert.equal(
		isRotationConfirmed(BEFORE, { recycling: true, exits: [EXIT_NAME] }, true),
		false,
		"still recycling: the exit is not in service yet",
	);
	assert.equal(
		isRotationConfirmed(BEFORE, { recycling: false, exits: [] }, true),
		false,
		"no exit at all: nothing to resend on",
	);
});

test("isRotationConfirmed: observing recycling during the poll confirms the rotation", () => {
	assert.equal(isRotationConfirmed(BEFORE, NOT_RECYCLING, true), true);
});

test("isRotationConfirmed: a changed exit list confirms the rotation", () => {
	assert.equal(
		isRotationConfirmed(BEFORE, { recycling: false, exits: ["warp-19a"] }, false),
		true,
	);
});

test("isRotationConfirmed: recycling: false with unchanged exits is NOT a rotation", () => {
	// The regression that matters (S6): the exit label is a stable pool label
	// (L26), so `recycling: false` alone would "confirm" a rotation that never
	// ran and spend the one resend on the same burnt IP.
	assert.equal(isRotationConfirmed(BEFORE, NOT_RECYCLING, false), false);
	assert.equal(
		isRotationConfirmed(undefined, NOT_RECYCLING, false),
		false,
		"no pre-POST snapshot means no evidence",
	);
	assert.equal(isRotationConfirmed({}, NOT_RECYCLING, false), false);
});

test("isRotationConfirmed: the same exit with another stream count never confirms", () => {
	// D1, on the raw bodies: the label carries the runtime annotation, so a
	// poll that reads `streams=1` before and `streams=2` after would look like a
	// new exit and confirm a rotation that never happened. Identity is the name.
	const before = warpHealthState(JSON.parse(WARP_HEALTH_SAMPLE));
	const later = warpHealthState(
		JSON.parse(WARP_HEALTH_SAMPLE.replace("streams=1", "streams=2")),
	);
	assert.deepEqual(later, { recycling: false, exits: ["warp-18e"] });
	assert.equal(isRotationConfirmed(before, later, false), false);
});

test("warpResendEnabled: only an explicit 0 disables the resend", () => {
	for (const value of [undefined, null, "", "1", "true", "no"]) {
		assert.equal(warpResendEnabled(value), true, `${String(value)} must keep the resend on`);
	}
	for (const value of ["0", " 0 ", 0]) {
		assert.equal(warpResendEnabled(value), false, `${String(value)} must disable the resend`);
	}
});

// ---------------------------------------------------------------------------
// The request path: rotation, resend and fallback with a fake network (S5, S7,
// S8, S10, S13)
// ---------------------------------------------------------------------------
// `relay.mjs` reaches the network through the global `fetch`, so replacing it
// drives the real `rotateWarpExit` / `resendAfterRotation` instead of a copy of
// their logic. Each case starts from reset module state and a rotation window
// shrunk to milliseconds; a real 10s poll would cost the suite seconds.

const GATE_429_BODY =
	'{"type":"FreeUsageLimitError","message":"Free usage limit reached."}';
const ORIGINAL_429 = {
	status: 429,
	contentType: "application/json",
	body: Buffer.from(GATE_429_BODY),
};
const RESEND_PATH = "/v1/messages";
const WARP_CONFIG = {
	upstream: "https://gate.example.test",
	userAgent: "pi-free-bridge-test",
	apiKey: "public",
	session: "ses_test",
	warpMode: "auto",
	warpProxy: "http://127.0.0.1:8789",
	warpHealthPath: "/health",
};

const healthJson = (state) =>
	new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });

/** Install a recording fake `fetch`; the caller restores it in `finally`. */
function installFakeFetch(handler) {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, opts = {}) => {
		const call = { url: String(url), method: String(opts.method ?? "GET").toUpperCase() };
		calls.push(call);
		return handler(call);
	};
	return { calls, restore: () => (globalThis.fetch = original) };
}

/** One case: fresh warp state, fake network, millisecond rotation window. */
async function driveWarp(handler, run) {
	resetWarpStateForTests();
	setWarpRotationTimingForTests(500, 1);
	const fake = installFakeFetch(handler);
	try {
		return await run(fake);
	} finally {
		fake.restore();
		setWarpRotationTimingForTests();
	}
}

/** Health bodies that walk a full recycle: quiet, recycling, quiet again. The
 *  entry name never changes, so only the observed window can confirm it. */
function recyclingThenQuiet() {
	const states = [
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: true, exits: ["warp-18e (in_use, streams=0)"] },
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
	];
	let index = 0;
	return () => states[Math.min(index++, states.length - 1)];
}

const recyclePosts = (calls) =>
	calls.filter((call) => call.method === "POST" && call.url.endsWith("/recycle"));
const upstreamCalls = (calls) =>
	calls.filter((call) => call.url.startsWith(WARP_CONFIG.upstream));

test("resendAfterRotation: a confirmed rotation posts /recycle once and resends once", async () => {
	const nextHealth = recyclingThenQuiet();
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return healthJson(nextHealth());
			if (call.url.endsWith("/recycle")) return new Response("", { status: 200 });
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		async (fake) => {
			const delivered = await resendAfterRotation(
				WARP_CONFIG,
				RESEND_PATH,
				{ model: "m", messages: [] },
				ORIGINAL_429,
				undefined,
			);

			assert.equal(delivered.response.status, 200);
			assert.equal(delivered.egress, "warp", "a resend only ever leaves through warp");
			assert.equal(recyclePosts(fake.calls).length, 1, "exactly one POST /recycle");
			assert.equal(upstreamCalls(fake.calls).length, 1, "exactly one upstream resend");
			const state = warpStateForTests();
			assert.equal(state.warpResends, 1);
			assert.equal(state.warpRecycles, 1);
			assert.equal(state.warp429Streak, 0, "the delivered success resets the streak");
		},
	);
});

test("rotateWarpExit: a rotation inside its cooldown never posts /recycle again", async () => {
	// B1: two warp 429s a moment apart used to POST twice, and the second POST
	// tore down the first request's in-flight resend stream.
	const nextHealth = recyclingThenQuiet();
	const stderr = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = (chunk) => (stderr.push(String(chunk)), true);
	try {
		await driveWarp(
			(call) => {
				if (call.url.endsWith("/health")) return healthJson(nextHealth());
				return new Response("", { status: 200 });
			},
			async (fake) => {
				assert.equal(await rotateWarpExit(WARP_CONFIG, undefined), true);
				assert.equal(
					warpStateForTests().warpRecycleNotBefore > Date.now(),
					true,
					"the 2xx armed the cooldown",
				);

				assert.equal(await rotateWarpExit(WARP_CONFIG, undefined), false);
				assert.equal(recyclePosts(fake.calls).length, 1, "no second POST /recycle");
				assert.equal(
					stderr.filter((line) => /already within its cooldown/.test(line)).length,
					1,
					"one line says why the original 429 is what gets delivered",
				);
			},
		);
	} finally {
		process.stderr.write = originalWrite;
	}
});

test("resendAfterRotation: a 429 resend delivers the original bytes, status and content-type", async () => {
	const nextHealth = recyclingThenQuiet();
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return healthJson(nextHealth());
			if (call.url.endsWith("/recycle")) return new Response("", { status: 200 });
			return new Response('{"type":"FreeUsageLimitError"}', { status: 429 });
		},
		async (fake) => {
			const delivered = await resendAfterRotation(
				WARP_CONFIG,
				RESEND_PATH,
				{ model: "m", messages: [] },
				ORIGINAL_429,
				undefined,
			);

			assert.equal(upstreamCalls(fake.calls).length, 1, "the resend happened");
			assert.equal(delivered.response.status, 429);
			assert.equal(delivered.egress, undefined, "the original keeps its own egress");
			assert.equal(delivered.response.headers.get("content-type"), "application/json");
			assert.equal(await delivered.response.text(), GATE_429_BODY);
			const state = warpStateForTests();
			assert.equal(state.warp429Streak, 1, "A2: the resend's own 429 counts");
			assert.equal(state.warpResends, 0, "a refused resend is not a delivered resend");
		},
	);
});

test("resendAfterRotation: a 4xx resend is refused and the original 429 is delivered", async () => {
	// B2: adopting anything below 500 delivered a 400/401/403 from the fresh
	// exit in place of the real rate limit.
	const nextHealth = recyclingThenQuiet();
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return healthJson(nextHealth());
			if (call.url.endsWith("/recycle")) return new Response("", { status: 200 });
			return new Response('{"error":"forbidden"}', { status: 403 });
		},
		async (fake) => {
			const delivered = await resendAfterRotation(
				WARP_CONFIG,
				RESEND_PATH,
				{ model: "m", messages: [] },
				ORIGINAL_429,
				undefined,
			);

			assert.equal(upstreamCalls(fake.calls).length, 1, "the resend happened");
			assert.equal(delivered.response.status, 429);
			assert.equal(await delivered.response.text(), GATE_429_BODY);
			assert.equal(warpStateForTests().warpResends, 0);
		},
	);
});

test("resendAfterRotation: a rotation that never confirms delivers the original and resends nothing", async () => {
	await driveWarp(
		(call) => {
			// recycling stays true: the exit never comes back into service.
			if (call.url.endsWith("/health"))
				return healthJson({ recycling: true, exits: ["warp-18e (in_use, streams=0)"] });
			return new Response("", { status: 200 });
		},
		async (fake) => {
			setWarpRotationTimingForTests(120, 5); // deadline, not patience
			const delivered = await resendAfterRotation(
				WARP_CONFIG,
				RESEND_PATH,
				{ model: "m", messages: [] },
				ORIGINAL_429,
				undefined,
			);

			assert.equal(recyclePosts(fake.calls).length, 1, "the rotation was attempted");
			assert.equal(upstreamCalls(fake.calls).length, 0, "an unconfirmed rotation buys no resend");
			assert.equal(delivered.response.status, 429);
			assert.equal(await delivered.response.text(), GATE_429_BODY);
			assert.equal(warpStateForTests().warpResends, 0);
		},
	);
});

test("resendAfterRotation: it reports the egress instead of writing the module global", async () => {
	// A1: `lastEgress` is request state, so a handler may only publish it once,
	// from its own value. The helper must not touch it.
	const nextHealth = recyclingThenQuiet();
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return healthJson(nextHealth());
			if (call.url.endsWith("/recycle")) return new Response("", { status: 200 });
			return new Response("", { status: 200 });
		},
		async () => {
			assert.equal(warpStateForTests().lastEgress, undefined);
			const delivered = await resendAfterRotation(
				WARP_CONFIG,
				RESEND_PATH,
				{ model: "m", messages: [] },
				ORIGINAL_429,
				undefined,
			);
			assert.equal(delivered.egress, "warp");
			assert.equal(
				warpStateForTests().lastEgress,
				undefined,
				"only forward() publishes lastEgress, once per finished request",
			);
		},
	);
});

// ---------------------------------------------------------------------------
// Forwarded upstream headers (S15)
// ---------------------------------------------------------------------------
// A gate 429 carries `retry-after` in seconds: it is the only thing that says
// when the quota resets, and it is what the client — and our own egress parking
// — needs in order to wait exactly once instead of guessing midnight UTC. The
// relay forwarded only `content-type`, so that evidence was thrown away.

/** The shape `forwardedHeaders` accepts: anything with a `get`. A real
 *  `Headers` and this stub are interchangeable there. */
const headerSource = (map) => ({ get: (name) => map[String(name).toLowerCase()] });

test("forwardedHeaders: retry-after survives an upstream error", () => {
	const headers = forwardedHeaders(
		headerSource({ "content-type": "application/json", "retry-after": "3600" }),
	);
	assert.deepEqual(headers, { "content-type": "application/json", "retry-after": "3600" });
});

test("forwardedHeaders: a header the upstream did not send is not invented", () => {
	assert.deepEqual(forwardedHeaders(headerSource({ "content-type": "application/json" })), {
		"content-type": "application/json",
	});
});

test("forwardedHeaders: retry-after alone is enough", () => {
	assert.deepEqual(forwardedHeaders(headerSource({ "retry-after": "60" })), { "retry-after": "60" });
});

test("forwardedHeaders: every other upstream header stays upstream", () => {
	const headers = forwardedHeaders(
		headerSource({
			"content-type": "text/event-stream",
			"x-ratelimit-remaining": "0",
		"set-cookie": "session=secret",
		}),
	);
	assert.deepEqual(headers, { "content-type": "text/event-stream" });
});

test("forwardedHeaders: a source without get never throws", () => {
	assert.deepEqual(forwardedHeaders(undefined), {});
	assert.deepEqual(forwardedHeaders({}), {});
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

// ---------------------------------------------------------------------------
// Shared-config WARP target (warp-minimal's own config.json)
// ---------------------------------------------------------------------------
// warp-minimal's config file is the single source of truth for the listen
// address and health path; the extension only READS it. Every fixture below is
// a throwaway temp directory — the real user config is never touched.

function writeWarpConfig(text) {
	const dir = mkdtempSync(join(tmpdir(), "pfb-warp-config-"));
	const file = join(dir, "config.json");
	writeFileSync(file, text, "utf8");
	return file;
}

test("parseListen: accepts every listen shape warp-minimal emits", async () => {
	const { parseListen } = await withIndex();
	assert.deepEqual(parseListen("127.0.0.1:8789"), { host: "127.0.0.1", port: 8789 });
	assert.deepEqual(parseListen(":9000"), { host: "127.0.0.1", port: 9000 });
	assert.deepEqual(parseListen("9000"), { host: "127.0.0.1", port: 9000 });
	assert.deepEqual(parseListen("[::1]:9000"), { host: "::1", port: 9000 });
	assert.deepEqual(parseListen("192.168.1.50:8789"), { host: "192.168.1.50", port: 8789 });
});

test("parseListen: returns undefined for anything unparseable", async () => {
	const { parseListen } = await withIndex();
	for (const value of ["garbage", "host:0", "host:99999", undefined, ""]) {
		assert.equal(parseListen(value), undefined, `${String(value)} must not parse`);
	}
});

test("warpHostUrl: brackets a bare IPv6 literal and leaves IPv4 alone", async () => {
	const { warpHostUrl } = await withIndex();
	assert.equal(warpHostUrl("::1"), "[::1]");
	assert.equal(warpHostUrl("[::1]"), "[::1]");
	assert.equal(warpHostUrl("127.0.0.1"), "127.0.0.1");
});

test("isLoopbackHost: only loopback literals count as local", async () => {
	const { isLoopbackHost } = await withIndex();
	for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.53"]) {
		assert.equal(isLoopbackHost(host), true, `${host} must be loopback`);
	}
	for (const host of ["192.168.1.50", "warp.example.test"]) {
		assert.equal(isLoopbackHost(host), false, `${host} must not be loopback`);
	}
});

test("resolveWarpTarget: a missing config file means the warp-minimal defaults", async () => {
	const { resolveWarpTarget } = await withIndex();
	const target = resolveWarpTarget(join(tmpdir(), "pfb-warp-config-absent", "config.json"));
	assert.equal(target.port, 8789);
	assert.equal(target.healthPath, "/health");
	assert.equal(target.source, "default");
	assert.equal(target.isLoopback, true);
	assert.equal(target.url, "http://127.0.0.1:8789");
	assert.equal(target.healthUrl, "http://127.0.0.1:8789/health");
});

test("resolveWarpTarget: listen and health_path come from the shared config file", async () => {
	const { resolveWarpTarget } = await withIndex();
	const file = writeWarpConfig(
		JSON.stringify({
			listen: "127.0.0.1:9000",
			health_path: "/status",
			pool_size: 7,
			stack: "ipv4",
			log_path: "/tmp/warp.log",
		}),
	);

	const target = resolveWarpTarget(file);

	assert.equal(target.port, 9000);
	assert.equal(target.healthPath, "/status");
	assert.equal(target.healthUrl, "http://127.0.0.1:9000/status");
	assert.equal(target.source, "config");
	assert.equal(target.isLoopback, true);
});

test("resolveWarpTarget: malformed JSON falls back to the defaults and never throws", async () => {
	const { resolveWarpTarget } = await withIndex();
	const file = writeWarpConfig("{ not json");

	const target = resolveWarpTarget(file);

	assert.equal(target.source, "default");
	assert.equal(target.port, 8789);
	assert.equal(target.healthPath, "/health");
});

test("resolveWarpTarget: an unusable listen falls back to the defaults and reports no file origin", async () => {
	const { resolveWarpTarget } = await withIndex();
	const file = writeWarpConfig(JSON.stringify({ listen: "not-a-listen", health_path: 42 }));

	const target = resolveWarpTarget(file);

	assert.equal(target.port, 8789);
	assert.equal(target.healthPath, "/health");
	assert.equal(
		target.source,
		"default",
		"a file that contributes nothing usable must not claim the defaults came from it",
	);
	assert.equal(target.isLoopback, true);
});

test("resolveWarpTarget: a non-loopback listen marks the target remote", async () => {
	const { resolveWarpTarget } = await withIndex();
	const file = writeWarpConfig(JSON.stringify({ listen: "192.168.1.50:8789" }));

	const target = resolveWarpTarget(file);

	assert.equal(target.isLoopback, false);
	assert.equal(target.url, "http://192.168.1.50:8789");
});

test("relayEnv: RELAY_WARP_PROXY is dropped when no target is resolved", async () => {
	const mod = await withIndex();
	process.env.RELAY_WARP_PROXY = "http://127.0.0.1:9999";
	try {
		const env = mod.relayEnv({ port: 8788, upstream: "https://example.test", cwd: "." });
		assert.equal(env.RELAY_WARP_PROXY, undefined, "a stale value must never be inherited");
	} finally {
		delete process.env.RELAY_WARP_PROXY;
	}
});

test("relayEnv: RELAY_WARP_PROXY carries the resolved target", async () => {
	const mod = await withIndex();
	const env = mod.relayEnv({
		port: 8788,
		upstream: "https://example.test",
		cwd: ".",
		warpProxy: "http://127.0.0.1:9000",
	});
	assert.equal(env.RELAY_WARP_PROXY, "http://127.0.0.1:9000");
});

// PRESERVE: the proxy wiring sits next to the existing relay-env contract and
// must not disturb it — the config path and the warp-mode override still reach
// the relay, and a stale proxy value is replaced, never inherited.
test("relayEnv: a resolved proxy leaves the existing relay env contract intact", async () => {
	const mod = await withIndex();
	process.env.PI_FREE_BRIDGE_WARP_MODE = "auto";
	process.env.RELAY_WARP_PROXY = "http://127.0.0.1:9999";
	try {
		const env = mod.relayEnv({
			port: 8788,
			upstream: "https://example.test",
			cwd: ".",
			warpProxy: "http://127.0.0.1:9000",
		});
		assert.equal(env.RELAY_CONFIG_PATH, mod.BRIDGE_CONFIG_PATH);
		assert.equal(env.RELAY_WARP_MODE, "auto");
		assert.equal(env.RELAY_WARP_PROXY, "http://127.0.0.1:9000", "the resolved target wins over a stale env value");
	} finally {
		delete process.env.PI_FREE_BRIDGE_WARP_MODE;
		delete process.env.RELAY_WARP_PROXY;
	}
});

// S14: the health path is warp-minimal's, read through resolveWarpTarget, so the
// relay must never inherit a stale one and must never hardcode /health itself.
test("relayEnv: RELAY_WARP_HEALTH_PATH carries the resolved target and never a stale value", async () => {
	const mod = await withIndex();
	process.env.RELAY_WARP_HEALTH_PATH = "/bogus";
	try {
		const withoutTarget = mod.relayEnv({ port: 8788, upstream: "https://example.test", cwd: "." });
		assert.equal(
			withoutTarget.RELAY_WARP_HEALTH_PATH,
			undefined,
			"no resolved target means no health path to pass",
		);

		const env = mod.relayEnv({
			port: 8788,
			upstream: "https://example.test",
			cwd: ".",
			warpProxy: "http://127.0.0.1:9000",
		});
		assert.equal(typeof env.RELAY_WARP_HEALTH_PATH, "string");
		assert.ok(env.RELAY_WARP_HEALTH_PATH.startsWith("/"));
		assert.notEqual(env.RELAY_WARP_HEALTH_PATH, "/bogus", "a stale inherited value must be replaced");
	} finally {
		delete process.env.RELAY_WARP_HEALTH_PATH;
	}
});
