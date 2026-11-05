// Tests for the pure helpers of `relay.mjs`.
//
// Run: node --test test/relay.test.mjs
//
// The relay is the Bun process that makes the upstream call (GATE-DIAGNOSIS.md
// §5). Its server half cannot be exercised without Bun and the network, so the
// helpers are exported and covered here under plain Node: importing the module
// must not start a server.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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

import { egressOrder, parkDurationMs, PARK_MARGIN_MS, updateWarpPreference, WARP_MODES } from "../relay.mjs";

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

// ---------------------------------------------------------------------------
// Local egress parking (S16, S17)
// ---------------------------------------------------------------------------
// A 429 on the LOCAL egress means that IP spent its day. `retry-after` says when
// it resets, so the relay stops offering local first until then instead of
// burning a real turn on a known-burnt IP. The window comes from the header —
// never from midnight UTC, which is wrong in every other time zone.

test("egressOrder: a parked local egress hands the first slot to warp", () => {
	assert.deepEqual(egressOrder("auto", false, true), ["warp", "local"]);
	assert.deepEqual(egressOrder("auto", true, true), ["warp", "local"]);
});

test("egressOrder: parking never removes local from the chain", () => {
	// Deprioritised, not excluded: a dead WARP must still have somewhere to fall
	// back to, and a request rejected by the gate costs no quota (S4).
	assert.equal(egressOrder("auto", false, true).includes("local"), true);
});

test("egressOrder: parking cannot change off or on", () => {
	assert.deepEqual(egressOrder("off", false, true), ["local"]);
	assert.deepEqual(egressOrder("on", false, true), ["warp"]);
});

test("parkDurationMs: retry-after plus a margin", () => {
	assert.equal(parkDurationMs("3600"), 3_600_000 + PARK_MARGIN_MS);
	assert.equal(parkDurationMs("0"), PARK_MARGIN_MS);
	assert.equal(PARK_MARGIN_MS, 10_000);
});

test("parkDurationMs: no usable header parks nothing", () => {
	// Guessing the reset here is exactly the bug this replaces, so every shape
	// that is not plain seconds parks nothing at all.
	for (const value of [undefined, null, "", "   ", "later", "-60", "1.5", "3600s"]) {
		assert.equal(parkDurationMs(value), undefined, `retry-after ${JSON.stringify(value)}`);
	}
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
	LOG_LIMIT_BYTES,
	logLine,
	makeEventLogger,
	manualWarpRecycle,
	resetWarpStateForTests,
	setLogFileForTests,
	shouldRotateLog,
	warpControlRoute,
	resendAfterRotation,
	rotateWarpExit,
	setDeliveringStreamsForTests,
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

test("rotateWarpExit: a rotation waits for the responses still being delivered", async () => {
	// A rotation replaces the exit, and replacing it kills every response riding
	// that tunnel. One that already passed the gate is going to succeed on its
	// own, so it is worth the wait. The request that ate the 429 is not counted:
	// it holds an error, not a delivery.
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
				setWarpRotationTimingForTests(500, 1, 10_000);
				setDeliveringStreamsForTests(1);
				const peerFinishes = setTimeout(() => setDeliveringStreamsForTests(0), 120);
				const startedAt = Date.now();
				const confirmed = await rotateWarpExit(WARP_CONFIG, undefined);
				const elapsed = Date.now() - startedAt;
				clearTimeout(peerFinishes);

				assert.equal(confirmed, true);
				assert.equal(recyclePosts(fake.calls).length, 1);
				assert.ok(elapsed >= 100, `it waited for the peer, took ${elapsed}ms`);
				assert.ok(
					stderr.some((line) => line.includes("waited") && line.includes("in-flight warp responses")),
					"the wait is observable in stderr",
				);
			},
		);
	} finally {
		process.stderr.write = originalWrite;
	}
});

test("rotateWarpExit: the drain valve releases a rotation the wait would trap", async () => {
	// A stream that never finishes must not take the request that ate the 429
	// down with it. The valve is that escape hatch, and it says so on stderr.
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
				setWarpRotationTimingForTests(500, 1, 80);
				setDeliveringStreamsForTests(3);
				const startedAt = Date.now();
				const confirmed = await rotateWarpExit(WARP_CONFIG, undefined);
				const elapsed = Date.now() - startedAt;

				assert.equal(confirmed, true, "the rotation still happens");
				assert.equal(recyclePosts(fake.calls).length, 1);
				assert.ok(elapsed < 1_500, `the valve bounded it, took ${elapsed}ms`);
				assert.ok(
					stderr.some((line) => line.includes("valve hit")),
					"a trapped rotation is visible in stderr",
				);
			},
		);
	} finally {
		process.stderr.write = originalWrite;
		setWarpRotationTimingForTests();
	}
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

// ---------------------------------------------------------------------------
// The drain wait, end to end (S20)
// ---------------------------------------------------------------------------
// The two tests above pin the wait itself. These pin the things the first
// version of this change got wrong and the suite still passed: the POST must
// come AFTER the wait, only one POST may exist per rotation, and the counter is
// only correct if a real `forward()` increments and releases it on every exit
// path. `forward` is exported for exactly this.

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { forward } from "../relay.mjs";

test("rotateWarpExit: /recycle is posted only after the drain wait (S20)", async () => {
	// Asserting `elapsed >= 100` is not enough: a POST-then-wait implementation
	// satisfies it. Only the POST's own timestamp does.
	const nextHealth = recyclingThenQuiet();
	const postedAt = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (u.endsWith("/health")) return healthJson(nextHealth());
		if (u.endsWith("/recycle")) {
			postedAt.push(Date.now());
			return new Response("", { status: 200 });
		}
		return new Response("", { status: 200 });
	};
	try {
		resetWarpStateForTests();
		setWarpRotationTimingForTests(500, 1, 5_000);
		setDeliveringStreamsForTests(1);
		const peerFinishes = setTimeout(() => setDeliveringStreamsForTests(0), 120);
		const startedAt = Date.now();
		const confirmed = await rotateWarpExit(WARP_CONFIG, undefined);
		clearTimeout(peerFinishes);

		assert.equal(confirmed, true);
		assert.equal(postedAt.length, 1);
		const postedAfter = postedAt[0] - startedAt;
		assert.ok(postedAfter >= 100, `POST /recycle came ${postedAfter}ms in — it must come after the wait`);
	} finally {
		globalThis.fetch = originalFetch;
		setWarpRotationTimingForTests();
		resetWarpStateForTests();
	}
});

test("rotateWarpExit: a client that left does not hold a rotation hostage (S20)", async () => {
	// Nobody is waiting for the resend, so waiting out a peer and then tearing
	// the tunnel down would cost the other tenants their own retry for a turn
	// that is already abandoned. The wait stops, and no POST leaves.
	const nextHealth = recyclingThenQuiet();
	try {
		await driveWarp(
			(call) => {
				if (call.url.endsWith("/health")) return healthJson(nextHealth());
				return new Response("", { status: 200 });
			},
			async (fake) => {
				setWarpRotationTimingForTests(500, 1, 10_000);
				setDeliveringStreamsForTests(1); // a peer that never finishes
				const startedAt = Date.now();
				const confirmed = await rotateWarpExit(WARP_CONFIG, { gone: true });
				const elapsed = Date.now() - startedAt;

				assert.equal(confirmed, false, "no resend for a client that is gone");
				assert.equal(recyclePosts(fake.calls).length, 0, "the tunnel is not torn down");
				assert.ok(elapsed < 1_000, `it did not wait out the valve, took ${elapsed}ms`);
			},
		);
	} finally {
		setWarpRotationTimingForTests();
	}
});

test("rotateWarpExit: a second 429 during the drain gets no second POST (C7)", async () => {
	// The wait must not hold the single-flight guard: that would stretch every
	// peer's "no resend" window from one rotation to one drain. The guard is
	// taken after the wait, so the peer still loses its resend — as it always
	// did — but only for the POST, not for the whole drain.
	const nextHealth = recyclingThenQuiet();
	const posts = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (u.endsWith("/health")) return healthJson(nextHealth());
		if (u.endsWith("/recycle")) {
			posts.push(u);
			return new Response("", { status: 200 });
		}
		return new Response("", { status: 200 });
	};
	try {
		resetWarpStateForTests();
		setWarpRotationTimingForTests(500, 1, 5_000);
		setDeliveringStreamsForTests(1);
		const peerFinishes = setTimeout(() => setDeliveringStreamsForTests(0), 150);
		const first = rotateWarpExit(WARP_CONFIG, undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = await rotateWarpExit(WARP_CONFIG, undefined);
		assert.equal(await first, true);
		clearTimeout(peerFinishes);

		assert.equal(second, false, "the loser delivers its original 429 instead of stacking a rotation");
		assert.equal(posts.length, 1, "exactly one POST /recycle across both callers");
	} finally {
		globalThis.fetch = originalFetch;
		setWarpRotationTimingForTests();
		resetWarpStateForTests();
	}
});

function fakeRelayRes() {
	const res = new EventEmitter();
	res.headersSent = false;
	res.writableEnded = false;
	res.status = 0;
	const chunks = [];
	res.writeHead = (status) => {
		res.status = status;
		res.headersSent = true;
		return res;
	};
	res.write = (chunk) => (chunks.push(Buffer.from(chunk)), true);
	res.end = (chunk) => {
		if (chunk) chunks.push(Buffer.from(chunk));
		res.writableEnded = true;
		res.emit("close");
		return res;
	};
	res.body = () => Buffer.concat(chunks).toString("utf8");
	return res;
}

const fakeReq = (payload) => Readable.from([Buffer.from(JSON.stringify(payload))]);
const FORWARD_CONFIG = { ...WARP_CONFIG, cwd: ".", warpMode: "on", sessionSource: "test" };

test("forward: a warp delivery is counted once and released on every exit path (S20)", async () => {
	// C1/C2/C4/C5 have no coverage from the tests above: they set the counter by
	// hand instead of earning it. A leaked or double-decremented counter would
	// pass everything else and hang or free a rotation at the wrong moment.
	const originalFetch = globalThis.fetch;
	let ctrl;
	let upstreamStatus = 200;
	let duringRotation = -1;
	const install = (status) => {
		upstreamStatus = status;
		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u.endsWith("/recycle")) {
				duringRotation = warpStateForTests().deliveringWarpStreams;
				return new Response("", { status: 200 });
			}
			if (u.endsWith("/health")) return new Response(JSON.stringify({ recycling: false, exits: ["warp-a"] }));
			if (upstreamStatus >= 400) return new Response(GATE_429_BODY, { status: upstreamStatus });
			return new Response(new ReadableStream({ start(c) { ctrl = c; } }), {
				status: upstreamStatus,
				headers: { "content-type": "text/event-stream" },
			});
		};
	};
	try {
		// A held-open delivery counts once and is released when it ends.
		resetWarpStateForTests();
		install(200);
		let res = fakeRelayRes();
		let done = forward(fakeReq({ marker: "held" }), res, RESEND_PATH, FORWARD_CONFIG);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(warpStateForTests().deliveringWarpStreams, 1, "a held-open warp response is counted once");
		ctrl.enqueue(Buffer.from("data: x\n\n"));
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(warpStateForTests().deliveringWarpStreams, 1, "still counted while delivering");
		ctrl.close();
		await done;
		assert.equal(warpStateForTests().deliveringWarpStreams, 0, "released when the upstream stream ends");
		assert.equal(res.status, 200);

		// A client that walks away releases it exactly once.
		resetWarpStateForTests();
		install(200);
		res = fakeRelayRes();
		done = forward(fakeReq({ marker: "gone" }), res, RESEND_PATH, FORWARD_CONFIG);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(warpStateForTests().deliveringWarpStreams, 1);
		res.emit("close");
		ctrl.enqueue(Buffer.from("data: y\n\n"));
		await done;
		assert.equal(warpStateForTests().deliveringWarpStreams, 0, "a disconnect releases the count exactly once");

		// The request that ate the 429 never counts itself.
		resetWarpStateForTests();
		setWarpRotationTimingForTests(150, 1, 5_000);
		duringRotation = -1;
		install(429);
		res = fakeRelayRes();
		await forward(fakeReq({ marker: "429" }), res, RESEND_PATH, FORWARD_CONFIG);
		assert.equal(duringRotation, 0, "the request that ate the 429 never counts itself");
		assert.equal(warpStateForTests().deliveringWarpStreams, 0);
		assert.equal(res.status, 429);

		// Off-tunnel traffic never enters the wait.
		resetWarpStateForTests();
		install(200);
		res = fakeRelayRes();
		done = forward(fakeReq({ marker: "local" }), res, RESEND_PATH, { ...FORWARD_CONFIG, warpMode: "off" });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(warpStateForTests().deliveringWarpStreams, 0, "local traffic never enters the drain wait");
		res.emit("close");
		ctrl.enqueue(Buffer.from("data: z\n\n"));
		await done;
		assert.equal(warpStateForTests().deliveringWarpStreams, 0);
	} finally {
		globalThis.fetch = originalFetch;
		setWarpRotationTimingForTests();
		resetWarpStateForTests();
	}
});

test("maybeRecycleWarp: the auto fallback rotation waits too (S20)", async () => {
	// `auto` with warp first is the everyday path: warp 429, then a local 200.
	// That rotation comes from the streak, not from the resend path, and it POSTs
	// from a different place. The wait has to live next to the POST, not inside
	// one of its callers — this is the hole the first version of the change left.
	const originalFetch = globalThis.fetch;
	const postedAt = [];
	let warpStatus = 200;
	// `warp` is preferred in `auto` only after a turn that SUCCEEDED through it,
	// so the warm-up has to be a local failure answered by warp.
	let localStatus = 200;
	globalThis.fetch = async (url, opts = {}) => {
		const u = String(url);
		if (u.endsWith("/recycle")) {
			postedAt.push(Date.now());
			return new Response("", { status: 200 });
		}
		if (u.endsWith("/health")) return new Response(JSON.stringify({ recycling: false, exits: ["warp-a"] }));
		// warp and local hit the SAME upstream URL: the egress is the proxy option.
		if (opts.proxy) {
			if (warpStatus >= 400) return new Response(GATE_429_BODY, { status: warpStatus });
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(Buffer.from("data: w\n\n"));
						c.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}
		if (localStatus >= 400) return new Response("{\"type\":\"rate_limit\"}", { status: localStatus });
		return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		resetWarpStateForTests();
		setWarpRotationTimingForTests(150, 1, 5_000);
		const autoConfig = { ...FORWARD_CONFIG, warpMode: "auto" };

		// Earn `warpPreferred`: local fails, warp answers, so the next turn starts
		// with warp first — the everyday `auto` state.
		localStatus = 429;
		let res = fakeRelayRes();
		await forward(fakeReq({ marker: "warm" }), res, RESEND_PATH, autoConfig);
		assert.equal(res.status, 200, "warp answered the warm-up");
		assert.equal(warpStateForTests().warpPreferred, true, "auto now prefers warp");

		localStatus = 200;
		warpStatus = 429;
		setDeliveringStreamsForTests(1);
		const peerFinishes = setTimeout(() => setDeliveringStreamsForTests(0), 120);
		res = fakeRelayRes();
		const startedAt = Date.now();
		await forward(fakeReq({ marker: "fallback" }), res, RESEND_PATH, autoConfig);
		clearTimeout(peerFinishes);

		assert.equal(res.status, 200, "the local fallback delivered");
		assert.equal(postedAt.length, 1, "the burnt exit was rotated");
		const postedAfter = postedAt[0] - startedAt;
		assert.ok(postedAfter >= 100, `POST /recycle came ${postedAfter}ms in — the streak rotation must wait too`);
	} finally {
		globalThis.fetch = originalFetch;
		setWarpRotationTimingForTests();
		resetWarpStateForTests();
	}
});

// ---------------------------------------------------------------------------
// warp event log (S1, S2)
// ---------------------------------------------------------------------------
//
// The relay writes one JSON object per line so an incident can be read back
// later. The format is the contract: a human greps it, and a future watchdog
// parses it. It must never carry a body, a header or a prompt — only the event
// name and the small numbers that explain a decision.

const logDir = () => mkdtempSync(join(tmpdir(), "pfb-relay-log-"));

const readEvents = (file) =>
	readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));

test("logLine: exactly one JSON line with its timestamp and fields", () => {
	const line = logLine("warp_429", { egress: "warp", streak: 2 }, Date.UTC(2026, 10, 4, 22, 54, 16));
	assert.ok(line.endsWith("\n"), "a line carries its own terminator");
	assert.equal(line.trimEnd().includes("\n"), false, "one event is one line, not several");
	const parsed = JSON.parse(line);
	assert.equal(parsed.ev, "warp_429");
	assert.equal(parsed.egress, "warp");
	assert.equal(parsed.streak, 2);
	assert.equal(parsed.t, "2026-11-04T22:54:16.000Z");
});

test("logLine: a reason carrying a newline cannot forge a second event", () => {
	const line = logLine("rotate_failed", { reason: "HTTP 500\nev: deliver 200" });
	assert.equal(line.trimEnd().includes("\n"), false, "the newline is escaped, not emitted");
	assert.equal(JSON.parse(line).reason, "HTTP 500\nev: deliver 200");
});

test("shouldRotateLog: rolls at the limit, never before it", () => {
	assert.equal(shouldRotateLog(0), false);
	assert.equal(shouldRotateLog(LOG_LIMIT_BYTES - 1), false);
	assert.equal(shouldRotateLog(LOG_LIMIT_BYTES), true);
	assert.equal(shouldRotateLog(LOG_LIMIT_BYTES + 1), true);
	assert.equal(shouldRotateLog(Number.NaN), false, "an unreadable size never rolls");
});

test("makeEventLogger: no path means no file is created", () => {
	const dir = logDir();
	const log = makeEventLogger("");
	assert.equal(typeof log, "function");
	log("warp_429", { streak: 1 });
	assert.deepEqual(readdirSync(dir), [], "nothing was written anywhere");
});

test("makeEventLogger: appends one parseable line per event", () => {
	const file = join(logDir(), "relay.jsonl");
	const log = makeEventLogger(file);
	log("warp_429", { streak: 1 });
	log("rotate_ok", { recycles: 1 });
	const events = readEvents(file);
	assert.deepEqual(
		events.map((event) => event.ev),
		["warp_429", "rotate_ok"],
	);
	assert.equal(events[0].streak, 1);
});

test("makeEventLogger: past the limit it rolls to .1 and keeps only one generation", () => {
	const file = join(logDir(), "relay.jsonl");
	const log = makeEventLogger(file, { limit: 120 });
	for (let i = 0; i < 20; i += 1) log("warp_429", { streak: i });
	assert.ok(existsSync(`${file}.1`), "the previous generation is kept");
	assert.ok(statSync(file).size < 400, "the live file restarted after rolling");
	for (let i = 0; i < 40; i += 1) log("warp_429", { streak: i });
	assert.ok(existsSync(`${file}.1`), "the roll never removes the kept generation");
	assert.equal(existsSync(`${file}.2`), false, "only one previous generation is kept");
});

test("resendAfterRotation: the recycle it runs is on disk for later (S1)", async () => {
	const file = join(logDir(), "relay.jsonl");
	const nextHealth = recyclingThenQuiet();
	setLogFileForTests(file);
	try {
		await driveWarp(
			(call) => {
				if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
				if (call.url.includes("/health")) return healthJson(nextHealth());
				return new Response("ok", { status: 200 });
			},
			async () => {
				await resendAfterRotation(WARP_CONFIG, RESEND_PATH, {}, { ...ORIGINAL_429 }, undefined);
			},
		);
	} finally {
		setLogFileForTests("");
	}
	const names = readEvents(file).map((event) => event.ev);
	assert.ok(names.includes("rotate_start"), `the request for a rotation was recorded: ${names}`);
	assert.ok(names.includes("rotate_ok"), `the confirmed rotation was recorded: ${names}`);
	assert.equal(
		JSON.stringify(readEvents(file)).includes(GATE_429_BODY),
		false,
		"the gate body never reaches the log",
	);
});

// ---------------------------------------------------------------------------
// Manual rotation (S3)
// ---------------------------------------------------------------------------
//
// The escape hatch. It exists because today the only manual recovery is a raw
// `POST /recycle` straight to the proxy, which skips the drain and tears down
// every stream multiplexed over the tunnel. The manual path must be the automatic
// path, invoked by hand: same guards, same drain, same confirmation.

test("warpControlRoute: only the exact manual path is a control request", () => {
	assert.equal(warpControlRoute("POST", "/warp/recycle"), "recycle");
	assert.equal(warpControlRoute("GET", "/warp/recycle"), undefined, "a GET never rotates");
	assert.equal(warpControlRoute("POST", "/v1/messages"), undefined, "a proxied path is never eaten");
	assert.equal(warpControlRoute("POST", "/warp/recyclex"), undefined, "no prefix matching");
	assert.equal(warpControlRoute("POST", "/health"), undefined);
});

test("manualWarpRecycle: it rotates once, reports it and confirms the new exit", async () => {
	const nextHealth = recyclingThenQuiet();
	const result = await driveWarp(
		(call) => {
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			if (call.url.includes("/health")) return healthJson(nextHealth());
			return new Response("ok", { status: 200 });
		},
		(fake) => manualWarpRecycle(WARP_CONFIG).then((out) => ({ out, fake })),
	);
	assert.equal(result.out.ok, true, "a confirmed rotation reports ok");
	assert.equal(result.out.warpRecycles, 1, "the counter the command prints moved");
	assert.equal(recyclePosts(result.fake.calls).length, 1, "exactly one POST");
	assert.equal(result.out.cooldownMs > 0, true, "the cooldown is armed and reported");
});

test("manualWarpRecycle: a second call inside the cooldown rotates nothing and says why", async () => {
	const nextHealth = recyclingThenQuiet();
	const handler = (call) => {
		if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
		if (call.url.includes("/health")) return healthJson(nextHealth());
		return new Response("ok", { status: 200 });
	};
	const both = await driveWarp(handler, async (fake) => {
		const first = await manualWarpRecycle(WARP_CONFIG);
		const second = await manualWarpRecycle(WARP_CONFIG);
		return { first, second, calls: fake.calls };
	});
	assert.equal(both.first.ok, true);
	assert.equal(both.second.ok, false, "the cooldown refuses the second rotation");
	assert.equal(both.second.reason, "cooldown");
	assert.equal(recyclePosts(both.calls).length, 1, "the burnt cooldown spent no POST");
});

test("manualWarpRecycle: it waits for in-flight warp streams before cutting the tunnel", async () => {
	const nextHealth = recyclingThenQuiet();
	const postedAt = [];
	const startedAt = Date.now();
	const out = await driveWarp(
		(call) => {
			if (call.url.endsWith("/recycle")) {
				postedAt.push(Date.now());
				return new Response("{}", { status: 200 });
			}
			if (call.url.includes("/health")) return healthJson(nextHealth());
			return new Response("ok", { status: 200 });
		},
		async () => {
			setDeliveringStreamsForTests(1);
			const peerFinishes = setTimeout(() => setDeliveringStreamsForTests(0), 120);
			try {
				return await manualWarpRecycle(WARP_CONFIG);
			} finally {
				clearTimeout(peerFinishes);
			}
		},
	);
	assert.equal(out.ok, true, "the manual rotation completed once the stream was done");
	assert.equal(postedAt.length, 1, "exactly one POST");
	const waited = postedAt[0] - startedAt;
	assert.ok(waited >= 100, `the POST came ${waited}ms in — it must wait for the stream`);
});
