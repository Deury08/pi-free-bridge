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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ensureEnvBlock,
	ensureGateTools,
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
