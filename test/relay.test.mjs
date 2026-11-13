// Tests for the pure helpers of `relay.mjs`.
//
// Run: node --test test/relay.test.mjs
//
// The relay is the Bun process that makes the upstream call (GATE-DIAGNOSIS.md
// §5). Its server half cannot be exercised without Bun and the network, so the
// helpers are exported and covered here under plain Node: importing the module
// must not start a server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
	basicAuthFor,
	catalogPrice,
	classifyGate429,
	freeCatalog,
	relayCatalog,
	RELAY_VERSION,
	ensureEnvBlock,
	forwardedHeaders,
	ensureGateTools,
	generateSessionId,
	harvestNewestSessionId,
	mintSessionFromService,
	parseServiceRegistration,
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

// ---------------------------------------------------------------------------
// harvestNewestSessionId: OpenCode v1 vs v2 schema
// ---------------------------------------------------------------------------
//
// OpenCode v1 stores sessions in `session`, v2 in `session_v2`. The harvest has
// to read whichever schema the local store has. `bun:sqlite` is a Bun-only
// import, so the table resolution is a pure function over a db-like object and
// is covered here under plain Node.

/** A `runSql` stand-in: throws for tables this fake schema does not have, so
 *  the harvest exercises the same absent-table path as a real driver. */
function fakeRun(tables) {
	return (sql) => {
		const table = /^select id from (\w+)/.exec(sql)?.[1];
		if (table === undefined || !(table in tables)) {
			throw new Error(`no such table: ${table}`);
		}
		return tables[table].map((id) => ({ id }));
	};
}

test("harvestNewestSessionId: reads the v1 `session` table", () => {
	assert.equal(harvestNewestSessionId(fakeRun({ session: ["ses_newest", "ses_older"] })), "ses_newest");
});

test("harvestNewestSessionId: reads the v2 `session_v2` table when `session` is absent", () => {
	assert.equal(harvestNewestSessionId(fakeRun({ session_v2: ["ses_v2_newest"] })), "ses_v2_newest");
});

test("harvestNewestSessionId: an empty v1 table does not shadow a populated v2 table", () => {
	assert.equal(harvestNewestSessionId(fakeRun({ session: [], session_v2: ["ses_from_v2"] })), "ses_from_v2");
});

test("harvestNewestSessionId: skips rows whose id is not a ses_ id", () => {
	assert.equal(harvestNewestSessionId(fakeRun({ session: ["not-a-session", "ses_real"] })), "ses_real");
});

test("harvestNewestSessionId: resolves nothing when no candidate table exists", () => {
	assert.equal(harvestNewestSessionId(fakeRun({})), undefined);
});

// The extension harvests the store with `node:sqlite`, whose DatabaseSync has
// `prepare()` and no `query()`. Driving the real driver here is what pins that
// API contract: a `query()`-based harvest compiles, resolves nothing, and the
// v2 schema below turns GREEN only when `prepare()` is the path taken.
test("harvestNewestSessionId: reads a real `session_v2` store through node:sqlite", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const store = mkdtempSync(join(tmpdir(), "pfb-sqlite-"));
	const dbPath = join(store, "opencode.db");

	const seed = new DatabaseSync(dbPath);
	seed.exec("create table session_v2 (id text, time_created integer)");
	seed.prepare("insert into session_v2 values (?, ?)").run("ses_old", 1);
	seed.prepare("insert into session_v2 values (?, ?)").run("ses_new", 2);
	seed.close();

	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const id = harvestNewestSessionId((sql) => db.prepare(sql).all());
		assert.equal(id, "ses_new");
	} finally {
		db.close();
	}
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

// Every precedence test injects a minter: without one the real
// mintSessionFromService would reach the machine's own OpenCode daemon and
// create a session as a test side effect.
const noService = async () => undefined;

test("resolveRelaySession: user override wins over a Pi-supplied id", async () => {
	process.env.RELAY_SESSION = "ses_override";
	process.env.RELAY_SESSION_SOURCE = "env";
	process.env.RELAY_SESSION_PI = "ses_pi_harvest";
	try {
		const result = await resolveRelaySession({
			shareDir: join(tmpdir(), "pfb-empty-none-00"),
			mintSession: noService,
		});
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
		const result = await resolveRelaySession({ shareDir, mintSession: noService });
		assert.equal(result.sessionId, "ses_pi_harvest");
		assert.equal(result.source, "pi-harvest");
	} finally {
		delete process.env.RELAY_SESSION_PI;
	}
});

test("resolveRelaySession: without a Pi-supplied id, the relay harvests locally", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	writeStore(shareDir, [["ses_local.json", new Date("2026-01-01")]]);
	const result = await resolveRelaySession({ shareDir, mintSession: noService });
	assert.equal(result.sessionId, "ses_local");
	assert.equal(result.source, "session-diff");
});

// ---------------------------------------------------------------------------
// The local OpenCode service (gate-decode S4, S7)
// ---------------------------------------------------------------------------
//
// The gate validates session ids against OpenCode's registry, so a fabricated
// id is rejected while a server-issued one is accepted even though it never
// served a request. Asking the server replaces scraping `opencode.db`, which is
// what broke on v2 (`session` -> `session_v2`).

/** Run `fn` against a throwaway loopback server, so the minter is exercised end
 *  to end without the machine's real daemon. */
async function withFakeService(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	try {
		return await fn(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test("parseServiceRegistration: accepts a loopback registration", () => {
	const parsed = parseServiceRegistration(
		JSON.stringify({ url: "http://127.0.0.1:49374", password: "pw", pid: 1, version: "2.2.7" }),
	);

	assert.deepEqual(parsed, { url: "http://127.0.0.1:49374", password: "pw" });
});

test("parseServiceRegistration: rejects a registration pointing off loopback", () => {
	assert.equal(parseServiceRegistration(JSON.stringify({ url: "http://10.0.0.5:49374", password: "pw" })), undefined);
});

test("parseServiceRegistration: rejects a registration without a password", () => {
	assert.equal(parseServiceRegistration(JSON.stringify({ url: "http://127.0.0.1:1" })), undefined);
});

test("parseServiceRegistration: rejects garbage instead of throwing", () => {
	assert.equal(parseServiceRegistration("not json"), undefined);
	assert.equal(parseServiceRegistration("{}"), undefined);
});

test("basicAuthFor: builds the credential the local server expects", () => {
	assert.equal(basicAuthFor("pw"), `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
});

test("mintSessionFromService: returns the id the local server issues", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-service-"));
	const servicePath = join(dir, "service.json");
	const seen = [];

	await withFakeService((req, res) => {
		seen.push({ url: req.url, method: req.method, auth: req.headers.authorization });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: { id: "ses_from_service" } }));
	}, async (url) => {
		writeFileSync(servicePath, JSON.stringify({ url, password: "pw" }));
		assert.equal(await mintSessionFromService({ servicePath }), "ses_from_service");
	});

	assert.deepEqual(seen, [{ url: "/api/session", method: "POST", auth: basicAuthFor("pw") }]);
});

test("mintSessionFromService: an absent registration resolves nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-service-"));

	assert.equal(await mintSessionFromService({ servicePath: join(dir, "service.json") }), undefined);
});

test("mintSessionFromService: a refused port resolves nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-service-"));
	const servicePath = join(dir, "service.json");
	// Port 1 on loopback is refused; the minter must swallow it, not throw.
	writeFileSync(servicePath, JSON.stringify({ url: "http://127.0.0.1:1", password: "pw" }));

	assert.equal(await mintSessionFromService({ servicePath, timeoutMs: 500 }), undefined);
});

test("mintSessionFromService: a foreign service shape resolves nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-service-"));
	const servicePath = join(dir, "service.json");

	await withFakeService((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id: "not-our-shape" }));
	}, async (url) => {
		writeFileSync(servicePath, JSON.stringify({ url, password: "pw" }));
		assert.equal(await mintSessionFromService({ servicePath }), undefined);
	});
});

test("resolveRelaySession: the local service beats the store harvest", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	writeStore(shareDir, [["ses_local.json", new Date("2026-01-01")]]);

	const result = await resolveRelaySession({ shareDir, mintSession: async () => "ses_service" });

	assert.equal(result.sessionId, "ses_service");
	assert.equal(result.source, "service");
});

test("resolveRelaySession: an absent local service falls through to the store", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	writeStore(shareDir, [["ses_local.json", new Date("2026-01-01")]]);

	const result = await resolveRelaySession({ shareDir, mintSession: noService });

	assert.equal(result.sessionId, "ses_local");
	assert.equal(result.source, "session-diff");
});

test("resolveRelaySession: a minter returning a non-ses_ id is ignored", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	writeStore(shareDir, [["ses_local.json", new Date("2026-01-01")]]);

	const result = await resolveRelaySession({ shareDir, mintSession: async () => "garbage" });

	assert.equal(result.sessionId, "ses_local");
	assert.equal(result.source, "session-diff");
});

// ---------------------------------------------------------------------------
// classifyGate429: the vendor's 429 label is not evidence (gate-decode S3)
// ---------------------------------------------------------------------------
//
// Measured 2026-11-12 against the live gate: `FreeUsageLimitError` is returned
// for an unknown session id, for a contract violation and for a real daily
// quota, always with the same 00:00-UTC `retry-after`. The classifier therefore
// ranks what the relay can justify instead of repeating the vendor's label.

test("classifyGate429: never claims quota when the relay cannot justify it", () => {
	const result = classifyGate429({ sessionSource: "service" });

	assert.equal(result.cause, "undetermined");
	assert.match(result.detail, /do not report quota/);
});

test("classifyGate429: an unverified session id is the first suspect", () => {
	for (const sessionSource of ["env", "config"]) {
		assert.equal(classifyGate429({ sessionSource }).cause, "session_suspect");
	}
});

test("classifyGate429: a parked egress is the answer, not a mystery", () => {
	const result = classifyGate429({ sessionSource: "service", parkedSeconds: 64097 });

	assert.equal(result.cause, "egress_parked");
	assert.match(result.detail, /64097s/);
	// It outranks every weaker guess: the relay already parked the exit itself.
	assert.equal(
		classifyGate429({ sessionSource: "env", warp429Streak: 5, parkedSeconds: 10 }).cause,
		"egress_parked",
	);
});

test("classifyGate429: two warp 429s rule the egress out", () => {	const result = classifyGate429({ sessionSource: "service", warp429Streak: 2 });

	assert.equal(result.cause, "not_egress");
});

test("classifyGate429: a registry-backed id on the first 429 stays undetermined", () => {
	assert.equal(classifyGate429({ sessionSource: "service", warp429Streak: 1 }).cause, "undetermined");
	assert.equal(classifyGate429({ sessionSource: "opencode.db" }).cause, "undetermined");
});

// ---------------------------------------------------------------------------
// generateSessionId: OpenCode's own generator, reproduced (gate-decode S8)
// ---------------------------------------------------------------------------
//
// `packages/schema/src/identifier.ts` is the source. These tests pin the three
// properties that make the generated id indistinguishable from a real one: the
// shape, the encoded timestamp, and the per-millisecond counter.

const zeros = (bytes) => bytes.fill(0);

test("generateSessionId: the shape is 12 hex followed by 14 base62", () => {
	const id = generateSessionId(1794463622689, zeros);

	assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("generateSessionId: the prefix decodes back to its timestamp", () => {
	const timestamp = 1794463700001;
	const id = generateSessionId(timestamp, zeros);
	const low48 = BigInt(`0x${id.slice(4, 16)}`);
	const current = 0xffffffffffffn - low48; // value is ~current

	// The low 12 bits are the counter, the rest is the timestamp modulo 2^36.
	assert.equal(current % 0x1000n, 1n, "the first id of a millisecond carries counter 1");
	assert.equal((current - 1n) / 0x1000n, BigInt(timestamp) % 2n ** 36n);
});

test("generateSessionId: a burst in one millisecond never repeats", () => {
	const timestamp = 1794463800002;
	const ids = new Set(Array.from({ length: 50 }, () => generateSessionId(timestamp, zeros)));

	assert.equal(ids.size, 50, "the counter disambiguates ids minted in the same ms");
});

test("resolveRelaySession: an empty machine falls back to a generated id", async () => {
	const shareDir = mkdtempSync(join(tmpdir(), "pfb-empty-"));

	const result = await resolveRelaySession({ shareDir, mintSession: noService });

	assert.equal(result.source, "generated");
	assert.match(result.sessionId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
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

test("needsWarpRecycle: rotates on the FIRST warp 429, with no timer in between (S12)", () => {
	// The meter has exactly one correct value: rotate on the first 429. Any
	// larger threshold would deliver that many 429s before the exit rotates,
	// which is strictly worse once the relay resends after a rotation. S12
	// removed the cool-down: a second 429 is a second signal, never a reason to
	// sit on a burnt exit.
	assert.equal(needsWarpRecycle(0), false);
	assert.equal(needsWarpRecycle(1), true);
	assert.equal(needsWarpRecycle(4), true);
	assert.equal(needsWarpRecycle(9), true, "the count never expires into a blocker");
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
	decideWarpSwap,
	handle,
	isRotationConfirmed,
	LOG_LIMIT_BYTES,
	logLine,
	makeEventLogger,
	manualWarpRecycle,
	resetWarpStateForTests,
	servedDelta,
	setLogFileForTests,
	shouldRotateLog,
	swapWarpExit,
	updateTunnelExit,
	warpControlRoute,
	resendAfterRotation,
	rotateWarpExit,
	setDeliveringStreamsForTests,
	setWarpRotationTimingForTests,
	setWarpSwapEnabledForTests,
	warpExitSnapshot,
	warpHealthState,
	warpHealthUrl,
	warpResendEnabled,
	warpStateForTests,
	warpSwapEnabled,
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
		const call = { url: String(url), method: String(opts.method ?? "GET").toUpperCase(), body: opts.body };
		calls.push(call);
		return handler(call);
	};
	return { calls, restore: () => (globalThis.fetch = original) };
}

/** One case: fresh warp state, fake network, millisecond rotation window. */
async function driveWarp(handler, run) {
	resetWarpStateForTests();
	setWarpRotationTimingForTests(500, 1);
	const fake = installFakeFetch(handler);	try {
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

/* A rotation cycle the confirmation poll can read: quiet, recycling, quiet
 * again. The entry name never changes, so only the observed window confirms it.
 * It repeats, which is what lets one fixture serve two rotations in a row. */
function recyclingCycle() {
	const cycle = [
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: true, exits: ["warp-18e (in_use, streams=0)"] },
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
	];
	let index = 0;
	return () => cycle[index++ % cycle.length];
}

test("rotateWarpExit: a second 429 right after a rotation rotates again (S12)", async () => {
	// S12: the five minute cool-down only ever refused a recovery that would have
	// worked (18 enrollments in 55 minutes and not one rate-limit refusal), so a
	// second 429 is a second signal instead of a blocked request. What still
	// serializes rotations is single-flight, and by then that guard is free.
	const nextHealth = recyclingCycle();
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return healthJson(nextHealth());
			return new Response("", { status: 200 });
		},
		async (fake) => {
			assert.equal(await rotateWarpExit(WARP_CONFIG, undefined), true);
			assert.equal(await rotateWarpExit(WARP_CONFIG, undefined), true, "a second attempt is not refused");
			assert.equal(recyclePosts(fake.calls).length, 2, "each 429 rotates: no timer stands in for evidence");
		},
	);
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
	//
	// The rotation here is never confirmed on purpose: it holds the guard while it
	// polls, which is exactly the window the peer has to find taken. (A confirmed
	// rotation would release the guard before the peer gets there, and with S12's
	// cool-down gone that peer is entitled to rotate for its own 429.)
	const posts = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (u.endsWith("/health")) {
			return healthJson({ recycling: true, exits: ["warp-18e (in_use, streams=0)"] });
		}
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
		assert.equal(await first, false, "it was never confirmed, which is what kept the guard taken");
		clearTimeout(peerFinishes);

		assert.equal(second, false, "the loser delivers its original 429 instead of stacking a rotation");
		assert.equal(posts.length, 1, "exactly one POST /recycle across both callers");
	} finally {
		globalThis.fetch = originalFetch;
		setWarpRotationTimingForTests();
		resetWarpStateForTests();
	}
});

function fakeRelayRes({ socket } = {}) {
	const res = new EventEmitter();
	res.headersSent = false;
	res.writableEnded = false;
	res.status = 0;
	// A real response always carries the connection it was written to, and the
	// departed-client tests need to model what that connection reports.
	if (socket) res.socket = socket;
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
				// Refused on purpose: an ACCEPTED rotation is waited out until the pool
				// shows a new exit (relay `waitForPoolReplacement`), and this case is
				// about the counting, not about the pool. A refusal keeps the read
				// sequence — and this test's point — untouched.
				return new Response(JSON.stringify({ ok: false, error: "blocked_by_recycle" }), { status: 202 });
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
	assert.equal(
		Object.hasOwn(result.out, "cooldownMs"),
		false,
		"S12: the manual path reports no cool-down, because there is none",
	);
});

test("manualWarpRecycle: a second call rotates again, because there is nothing to sit out (S12)", async () => {
	const nextHealth = recyclingCycle();
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
	assert.equal(both.second.ok, true, "no cool-down refuses the second rotation");
	assert.equal(recyclePosts(both.calls).length, 2, "every call is honoured: the manual escape hatch never blocks");
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

// ---------------------------------------------------------------------------
// Slice 2 — per-exit attribution from the proxy's `served` counter (S6)
// ---------------------------------------------------------------------------
// The contract (odd/tasks/warp-per-exit-swap.md) publishes each exit as
// `<full id> (<state>, served=N, streams=N)`: always the three fields, in that
// order, no optional fields. The relay cannot see the CONNECT at all — Bun owns
// it and exposes neither its request nor its response headers — so this counter
// is the only way to learn which exit served a 429.

const EXIT_A = "warp-18e5257c545b2e64";
const EXIT_B = "warp-18e9a1c04f7d3b12";

function snapshotOf(entries) {
	return warpExitSnapshot({ ok: true, recycling: false, exits: entries });
}

test("warpExitSnapshot: reads id, state, served and streams from the contract format", () => {
	const snapshot = snapshotOf([`${EXIT_A} (healthy, served=42, streams=0)`, `${EXIT_B} (in_use, served=17, streams=1)`]);
	assert.deepEqual(snapshot.exits, [
		{ id: EXIT_A, state: "healthy", served: 42, streams: 0 },
		{ id: EXIT_B, state: "in_use", served: 17, streams: 1 },
	]);
});

test("warpExitSnapshot: keeps the whole id and tolerates an older entry without served", () => {
	const snapshot = snapshotOf(["warp-18e (in_use, streams=1)"]);
	assert.equal(snapshot.exits[0].id, "warp-18e", "the id is everything before the annotation");
	assert.equal(snapshot.exits[0].served, undefined, "an older proxy has no counter to read");
	assert.equal(snapshot.exits[0].streams, 1);
});

test("warpExitSnapshot: a body that is not a health report yields nothing", () => {
	assert.equal(warpExitSnapshot("<html>nope</html>"), undefined);
	assert.equal(warpExitSnapshot([1, 2]), undefined);
	assert.equal(warpExitSnapshot(null), undefined);
});

test("servedDelta: the single exit whose counter grew by one is the culprit", () => {
	const before = snapshotOf([`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=17, streams=0)`]);
	const after = snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=17, streams=0)`]);
	const delta = servedDelta(before, after);
	assert.equal(delta.learned, EXIT_A);
	assert.deepEqual(delta.changed.map((entry) => entry.id), [EXIT_A]);
	assert.equal(delta.ambiguous, false);
});

test("servedDelta: two exits moving at once is ambiguous, never an attribution", () => {
	const before = snapshotOf([`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (in_use, served=17, streams=1)`]);
	const after = snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (in_use, served=18, streams=1)`]);
	const delta = servedDelta(before, after);
	assert.equal(delta.learned, undefined);
	assert.equal(delta.ambiguous, true);
});

test("servedDelta: one exit moving by more than one is not learnable either", () => {
	const before = snapshotOf([`${EXIT_A} (healthy, served=40, streams=0)`, `${EXIT_B} (healthy, served=5, streams=0)`]);
	const after = snapshotOf([`${EXIT_A} (healthy, served=42, streams=0)`, `${EXIT_B} (healthy, served=5, streams=0)`]);
	const delta = servedDelta(before, after);
	assert.equal(delta.learned, undefined, "two tunnels opened in the window: which one is ours is unknown");
	assert.equal(delta.ambiguous, true);
});

test("servedDelta: nothing moving means the request reused an existing tunnel", () => {
	const before = snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`]);
	const after = snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`]);
	const delta = servedDelta(before, after);
	assert.equal(delta.unchanged, true);
	assert.equal(delta.learned, undefined);
	assert.equal(delta.ambiguous, false);
});

test("servedDelta: an unreadable or counter-less report teaches nothing", () => {
	const before = snapshotOf([`${EXIT_A} (healthy, served=1, streams=0)`]);
	assert.equal(servedDelta(before, undefined).learned, undefined);
	const legacy = servedDelta(snapshotOf(["warp-18e (in_use, streams=1)"]), snapshotOf(["warp-18e (healthy, streams=0)"]));
	assert.equal(legacy.learned, undefined, "without served there is no evidence at all");
});

test("updateTunnelExit: an empty map adopts the exit the delta named", () => {
	const delta = servedDelta(
		snapshotOf([`${EXIT_A} (healthy, served=1, streams=0)`]),
		snapshotOf([`${EXIT_A} (healthy, served=2, streams=0)`]),
	);
	const next = updateTunnelExit(undefined, delta, { mapValid: false });
	assert.deepEqual(next, { exitId: EXIT_A, decision: "learned" });
});

test("updateTunnelExit: a delta on another exit while our map holds is foreign traffic", () => {
	const delta = servedDelta(
		snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=8, streams=0)`]),
	);
	const next = updateTunnelExit(EXIT_A, delta, { mapValid: true });
	assert.deepEqual(next, { exitId: EXIT_A, decision: "ignored_foreign" }, "a browser opening a tunnel must not move our map");
});

test("updateTunnelExit: our own exit moving while the map holds is a contradiction", () => {
	const delta = servedDelta(
		snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`]),
		snapshotOf([`${EXIT_A} (in_use, served=43, streams=1)`]),
	);
	const next = updateTunnelExit(EXIT_A, delta, { mapValid: true });
	assert.deepEqual(next, { exitId: undefined, decision: "knockout" });
});

test("updateTunnelExit: after our exit was replaced, a single delta is learned again", () => {
	const delta = servedDelta(
		snapshotOf([`${EXIT_B} (healthy, served=8, streams=0)`]),
		snapshotOf([`${EXIT_B} (healthy, served=9, streams=1)`]),
	);
	const next = updateTunnelExit(EXIT_A, delta, { mapValid: false });
	assert.deepEqual(next, { exitId: EXIT_B, decision: "learned" }, "a swap killed our tunnel: the next one is the new truth");
});

test("updateTunnelExit: ambiguity knocks the map out instead of guessing", () => {
	const delta = servedDelta(
		snapshotOf([`${EXIT_A} (healthy, served=1, streams=0)`, `${EXIT_B} (healthy, served=1, streams=0)`]),
		snapshotOf([`${EXIT_A} (healthy, served=2, streams=0)`, `${EXIT_B} (healthy, served=2, streams=0)`]),
	);
	const next = updateTunnelExit(EXIT_A, delta, { mapValid: true });
	assert.deepEqual(next, { exitId: undefined, decision: "knockout" });
});

test("updateTunnelExit: an unchanged delta keeps whatever we know", () => {
	const delta = servedDelta(
		snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`]),
		snapshotOf([`${EXIT_A} (in_use, served=42, streams=1)`]),
	);
	assert.deepEqual(updateTunnelExit(EXIT_A, delta, { mapValid: true }), { exitId: EXIT_A, decision: "kept" });
	assert.deepEqual(updateTunnelExit(undefined, delta, { mapValid: false }), {
		exitId: undefined,
		decision: "kept",
	});
});

test("decideWarpSwap: rotating without an attributed exit is forbidden", () => {
	assert.deepEqual(decideWarpSwap({ exitId: undefined, retryAfterMs: 3_600_000 }), {
		swap: false,
		reason: "no_attribution",
	});
});

test("decideWarpSwap: a short retry-after means wait, because a swap burns an enrollment", () => {
	const short = decideWarpSwap({ exitId: EXIT_A, retryAfterMs: 30_000, shortWindowMs: 120_000 });
	assert.deepEqual(short, { swap: false, reason: "short_retry_after" });
	const unknown = decideWarpSwap({ exitId: EXIT_A, retryAfterMs: undefined, shortWindowMs: 120_000 });
	assert.equal(unknown.swap, true, "no recovery window is the case a swap exists for");
	const long = decideWarpSwap({ exitId: EXIT_A, retryAfterMs: 3_600_000, shortWindowMs: 120_000 });
	assert.equal(long.swap, true);
});

test("decideWarpSwap: disabled or already in flight refuse, and nothing else (S12)", () => {
	assert.equal(decideWarpSwap({ exitId: EXIT_A, enabled: false }).reason, "disabled");
	assert.equal(decideWarpSwap({ exitId: EXIT_A, inFlight: true }).reason, "in_flight");
	assert.equal(decideWarpSwap({ exitId: EXIT_A }).swap, true, "a timer is never a reason to skip a swap");
});

test("warpSwapEnabled: only an explicit zero turns the swap off", () => {
	assert.equal(warpSwapEnabled("0"), false);
	assert.equal(warpSwapEnabled(0), false);
	assert.equal(warpSwapEnabled(undefined), true);
	assert.equal(warpSwapEnabled(""), true);
	assert.equal(warpSwapEnabled("no"), true, "a typo must not silently disable the ladder");
});

// ---------------------------------------------------------------------------
// Slice 2 — the targeted swap (S7, S9)
// ---------------------------------------------------------------------------
// `POST /swap` replaces ONE exit: the proxy stops handing work to the target,
// re-enrolls it, and keeps serving through the other one. One enrollment
// instead of N, and the pool is never left empty. A 202 is acceptance, not
// completion, and 409/404 are answers we must not insist on.

async function withWarpFetch(stub, run) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		resetWarpStateForTests();
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

test("swapWarpExit: a 202 posts the exact exit id and reports the target", () => {
	const calls = [];
	return withWarpFetch(
		async (url, opts = {}) => {
			calls.push({ url: String(url), method: opts.method, body: opts.body });
			if (String(url).endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const result = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.deepEqual(result, { swapped: true, target: EXIT_A });
			assert.equal(calls.length, 1, "exactly one POST");
			assert.equal(calls[0].method, "POST");
			assert.deepEqual(JSON.parse(calls[0].body), { exit: EXIT_A }, "the id is explicit: the body-less default picks by live streams");
			assert.equal(warpStateForTests().warpSwaps, 1);
		},
	);
});

test("swapWarpExit: 409 no standby is an answer, and with no cool-down it is asked again (S12)", () => {
	const calls = [];
	return withWarpFetch(
		async (url) => {
			calls.push(String(url));
			if (String(url).endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: false, error: "no_standby", target: EXIT_A }), { status: 409 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const first = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.deepEqual(first, { swapped: false, reason: "no_standby", status: 409, target: EXIT_A });
			const second = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.equal(second.reason, "no_standby", "a second attempt is not refused: there is no timer to sit out");
			assert.equal(calls.length, 2, "the proxy is asked again instead of the relay inventing a wait");
		},
	);
});

test("swapWarpExit: an unknown exit is reported instead of hidden", () => {
	return withWarpFetch(
		async (url) => {
			if (String(url).endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: false, error: "unknown_exit" }), { status: 404 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const result = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.equal(result.reason, "unknown_exit");
			assert.equal(result.status, 404);
		},
	);
});

test("swapWarpExit: two handlers at once stack nothing", () => {
	const calls = [];
	return withWarpFetch(
		async (url) => {
			if (String(url).endsWith("/swap")) {
				calls.push("swap");
				await new Promise((resolve) => setTimeout(resolve, 30));
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const [first, second] = await Promise.all([
				swapWarpExit(WARP_CONFIG, EXIT_A),
				swapWarpExit(WARP_CONFIG, EXIT_A),
			]);
			assert.equal(calls.length, 1, "one swap at a time: the proxy serializes its own, we do not stack ours");
			assert.equal([first, second].filter((result) => result.swapped).length, 1);
			assert.equal([first, second].filter((result) => result.reason === "in_flight").length, 1);
		},
	);
});

test("swapWarpExit: a 202 that says ok:false was not accepted (S7)", () => {
	// The status code alone cannot tell an accepted swap from a refused one, and
	// the refused case is invisible by design: another swap or a recycle owns the
	// proxy state. Counting it as accepted would spend the short cooldown and arm
	// a resend against an exit nobody replaced.
	return withWarpFetch(
		async (url) => {
			if (String(url).endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: false, error: "swap_in_flight" }), { status: 202 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const result = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.equal(result.swapped, false, "a 202 with ok:false is a refusal that wears the success status");
			assert.equal(result.reason, "swap_in_flight", "the proxy's own reason is kept instead of invented");
			assert.equal(warpStateForTests().warpSwaps, 0, "a refusal spends nothing");
		},
	);
});

test("swapWarpExit: without a proxy there is nothing to ask", () => {
	return withWarpFetch(
		async () => {
			throw new Error("must not fetch");
		},
		async () => {
			const result = await swapWarpExit({ ...WARP_CONFIG, warpProxy: "" }, EXIT_A);
			assert.equal(result.reason, "no_proxy");
		},
	);
});

// ---------------------------------------------------------------------------
// Slice 2 — a refused recycle costs nothing (S9, S12)
// ---------------------------------------------------------------------------
// While a swap is replacing an exit the proxy refuses a rotation with a 202 and
// `ok:false`: a silent no-op. Counting it as accepted used to arm the five
// minute cooldown on nothing and then wait ten seconds for a confirmation that
// could not arrive.

const REFUSED_SWAP_BODY = {
	ok: false,
	exits: [`${EXIT_A} (draining, served=42, streams=1)`, `${EXIT_B} (in_use, served=7, streams=1)`],
};

test("rotateWarpExit: an ok:false recycle is refused and spends nothing (S12)", async () => {
	const file = join(logDir(), "relay-refused-swap.jsonl");
	setLogFileForTests(file);
	try {
		await driveWarp(
			(call) => {
				if (call.url.endsWith("/recycle")) {
					return new Response(JSON.stringify(REFUSED_SWAP_BODY), { status: 202 });
				}
				if (call.url.includes("/health")) {
					return healthJson({ recycling: false, exits: [`${EXIT_A} (draining, served=42, streams=1)`] });
				}
				return new Response("ok", { status: 200 });
			},
			async () => {
				const startedAt = Date.now();
				const confirmed = await rotateWarpExit(WARP_CONFIG, undefined);
				assert.equal(confirmed, false, "a no-op must not buy a resend");
				assert.equal(warpStateForTests().warpRecycles, 0, "nothing happened, so nothing is spent");
				assert.ok(
					Date.now() - startedAt < 1_000,
					"and it does not poll for a confirmation that cannot come",
				);
			},
		);
	} finally {
		setLogFileForTests("");
	}
	const events = readEvents(file).map((event) => event.ev);
	assert.ok(events.includes("recycle_refused"), `the refusal is on disk: ${events}`);
	assert.ok(
		JSON.stringify(readEvents(file)).includes("blocked_by_swap"),
		"the draining exit names the swap as the blocker, using the body it already sends",
	);
	assert.equal(
		JSON.stringify(readEvents(file)).includes("rotate_ok"),
		false,
		"a refused rotation is never recorded as confirmed",
	);
	assert.equal(
		JSON.stringify(readEvents(file)).includes("rotate_failed"),
		false,
		"and it is not a failure either: it never got to poll for a confirmation",
	);
});

test("rotateWarpExit: without a draining exit the blocker is the recycle (S9)", async () => {
	const file = join(logDir(), "relay-refused-recycle.jsonl");
	setLogFileForTests(file);
	try {
		await driveWarp(
			(call) => {
				if (call.url.endsWith("/recycle")) {
					return new Response(JSON.stringify({ ok: false }), { status: 202 });
				}
				if (call.url.includes("/health")) return healthJson({ recycling: true, exits: [`${EXIT_A} (in_use, streams=1)`] });
				return new Response("ok", { status: 200 });
			},
			async () => {
				assert.equal(await rotateWarpExit(WARP_CONFIG, undefined), false);
			},
		);
	} finally {
		setLogFileForTests("");
	}
	const raw = JSON.stringify(readEvents(file));
	assert.ok(raw.includes("blocked_by_recycle"), `no draining exit means the recycle refused: ${raw}`);
	assert.equal(raw.includes("blocked_by_swap"), false);
});
// ---------------------------------------------------------------------------
// Slice 2 — attribution is wired into the request path (S6)
// ---------------------------------------------------------------------------
// The pure helpers above are necessary and not sufficient: without the wiring
// the ladder would have no target exactly when it matters. What these prove is
// the wiring itself — a snapshot taken BEFORE our attempt, a delta read AFTER
// the 429, and a map that tolerates the traffic of others.

/** Health bodies in order; the tail repeats, because the rotation poll reads
 *  `/health` an unpredictable number of times and must not disturb the case. */
function sequencedHealth(entries) {
	let index = 0;
	return () =>
		healthJson({
			ok: true,
			recycling: false,
			exits: entries[Math.min(index++, entries.length - 1)],
		});
}

/** The recycle REFUSED. An accepted rotation is now waited out until the pool
 *  shows exits that were not there before (relay `waitForPoolReplacement`), and
 *  the attribution cases below are not about that wait: a refusal keeps their
 *  read sequence exactly what it was, so they still assert attribution alone. */
const refusedRecycle = () =>
	new Response(JSON.stringify({ ok: false, error: "blocked_by_recycle" }), { status: 202 });

test("forward: one tunnel opening during our own attempt attributes that exit (S6)", async () => {
	const nextHealth = sequencedHealth([
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
	]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/recycle")) return refusedRecycle();
			return new Response(GATE_429_BODY, { status: 429 });
		},
		async () => {
			await forward(fakeReq({ marker: "attribute" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(
				warpStateForTests().tunnelExit,
				EXIT_A,
				"the only exit whose counter moved is the one carrying our tunnel",
			);
		},
	);
});

test("forward: two exits moving at once are attributed to neither (S6)", async () => {
	// Both counters moving during one attempt is the case where a single delta
	// would be a coin flip. Guessing here costs a swap on the wrong exit, so a
	// known map is DROPPED rather than replaced, and the ladder stays out of the
	// way until the next clean window teaches it again. Learning first matters:
	// without it this case would pass with no wiring at all.
	const nextHealth = sequencedHealth([
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (in_use, served=7, streams=1)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (in_use, served=7, streams=1)`],
		// the standby guard's own read, then the rotation's before-snapshot
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (in_use, served=7, streams=1)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (in_use, served=7, streams=1)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (in_use, served=7, streams=1)`],
		[`${EXIT_A} (in_use, served=43, streams=1)`, `${EXIT_B} (in_use, served=8, streams=1)`],
	]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/recycle")) return refusedRecycle();
			return new Response(GATE_429_BODY, { status: 429 });
		},
		async () => {
			setWarpRotationTimingForTests(0, 1);
			await forward(fakeReq({ marker: "clean" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(warpStateForTests().tunnelExit, EXIT_A, "a clean window teaches the map");

			await forward(fakeReq({ marker: "ambiguous" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(warpStateForTests().tunnelExit, undefined, "ambiguity must not be resolved by picking one");
		},
	);
});

test("forward: another exit's traffic does not steal a valid map (S6)", async () => {
	// Our tunnel is reused, so its counter cannot move again on its own. Any
	// single delta while the map is valid therefore belongs to somebody else, and
	// overwriting our answer would aim the next swap at an innocent exit.
	const states = [
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=8, streams=0)`],
	];
	const nextHealth = sequencedHealth(states);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/recycle")) return refusedRecycle();
			return new Response(GATE_429_BODY, { status: 429 });
		},
		async () => {
			setWarpRotationTimingForTests(0, 1); // no poll: the sequence stays readable
			await forward(fakeReq({ marker: "one" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(warpStateForTests().tunnelExit, EXIT_A);

			await forward(fakeReq({ marker: "two" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(
				warpStateForTests().tunnelExit,
				EXIT_A,
				"a delta on another exit is foreign traffic, never a correction",
			);
		},
	);
});

// ---------------------------------------------------------------------------
// Slice 2 — the bounded ladder (S8)
// ---------------------------------------------------------------------------
// Ascending cost: a targeted swap replaces only the exit that served the 429 and
// keeps the pool serving, then one resend. Only if the fresh exit refuses too
// does the harder rotation run, because that is the one step that tears down our
// own tunnel and every stream riding it. At most two attempts per request.

const swapPosts = (calls) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/swap"));

/** The 429, then whatever the next attempt gets. */
function upstreamThen(statuses) {
	let index = 0;
	return () => {
		const status = statuses[Math.min(index++, statuses.length - 1)];
		return status === 429
			? new Response(GATE_429_BODY, { status: 429 })
			: new Response('{"ok":true}', { status, headers: { "content-type": "application/json" } });
	};
}

test("ladder: a targeted swap and one resend need no recycle (S8)", async () => {
	const nextHealth = sequencedHealth([
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		// the standby guard, read before the swap goes out
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		// accepted and drained: the resend waits for THIS — the drained id gone and a
		// NEW id in its place, which is the exit that then serves the retry
		[`${EXIT_B} (in_use, served=7, streams=1)`, `warp-new (in_use, served=1, streams=1)`],
	]);
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: "warp-new" }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "ladder" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 200, "the fresh exit delivered");
			assert.equal(swapPosts(fake.calls).length, 1);
			assert.deepEqual(
				JSON.parse(swapPosts(fake.calls)[0].body),
				{ exit: EXIT_A },
				"the swap names the exit that served the 429, not whichever has streams",
			);
			assert.equal(recyclePosts(fake.calls).length, 0, "the recycle is the last resort, never the first step");
			assert.equal(warpStateForTests().warpSwaps, 1);
		},
	);
});

test("ladder: without an attributed exit it never guesses a target (S7)", async () => {
	// A body-less swap picks by live streams, and by the time a 429 is being
	// diagnosed the burnt exit is the idle one. Guessing costs an enrollment on
	// the wrong exit, so the ladder skips to the rotation instead.
	// The chain reads twice (before the attempt, after the 429) without a served
	// counter, so the map stays empty — and the standby guard reads once more
	// before its decision, still finding no target. The rotation's own before-read
	// follows, and then the wait: the pool only counts as replaced once an id that
	// was not there before shows up.
	const bodies = [
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: true, exits: ["warp-18e (in_use, streams=0)"] },
		{ recycling: false, exits: ["warp-18e (in_use, streams=1)"] },
		{ recycling: false, exits: ["warp-fresh (healthy, served=0, streams=0)"] },
	];
	let index = 0;
	const nextHealth = () => healthJson(bodies[Math.min(index++, bodies.length - 1)]);
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) return new Response(JSON.stringify({ ok: true }), { status: 202 });
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "no-target" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 200, "the rotation still bought a working resend");
			assert.equal(swapPosts(fake.calls).length, 0, "no target means no swap");
			assert.equal(recyclePosts(fake.calls).length, 1);
		},
	);
});

test("ladder: a refused swap falls through to the rotation (S8)", async () => {
	const nextHealth = sequencedHealth([
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		// the rotation's own before-snapshot, then the pool it left behind: every old
		// id gone and a new one serving, which is what the resend waits for
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`warp-fresh (healthy, served=0, streams=0)`],
	]);
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: false, error: "no_standby" }), { status: 409 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "no-standby" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 200, "the harder step still recovered the request");
			assert.equal(swapPosts(fake.calls).length, 1);
			assert.equal(recyclePosts(fake.calls).length, 1, "a 409 is an answer: move to the next step, do not insist");
		},
	);
});

test("ladder: when the fresh exit refuses too, the recycle is still there (S8)", async () => {
	// The whole point of a ladder: each step is allowed to fail, and the last one
	// is only reached because the cheaper ones did.
	const nextHealth = sequencedHealth([
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		// the standby guard, read before the swap goes out
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		// accepted: the drained exit is out and the new id is in, so the first resend
		// leaves on it — and gets a 429, which sends the ladder to the rotation
		[`${EXIT_B} (in_use, served=7, streams=1)`, `warp-new (draining, served=0, streams=0)`],
		[`${EXIT_B} (in_use, served=7, streams=1)`, `warp-new (in_use, served=1, streams=1)`],
		// the attribute read after that refused resend, then the rotation's own
		// before-snapshot
		[`${EXIT_B} (in_use, served=7, streams=1)`, `warp-new (healthy, served=1, streams=0)`],
		[`${EXIT_B} (in_use, served=7, streams=1)`, `warp-new (healthy, served=1, streams=0)`],
		// the recycle replaced the whole pool: every old id gone, a new one serving
		[`warp-newer (healthy, served=0, streams=0)`],
	]);
	const nextUpstream = upstreamThen([429, 429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: "warp-new" }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "both" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 200, "three attempts, two recoveries, one delivered turn");
			assert.equal(swapPosts(fake.calls).length, 1, "one swap, no loop");
			assert.equal(recyclePosts(fake.calls).length, 1, "one recycle, no loop");
			assert.equal(upstreamCalls(fake.calls).length, 3, "original, after the swap, after the rotation");
		},
	);
});

test("ladder: a thin pool skips the swap and lets the rotation recover (S8)", async () => {
	// Draining the exit that served the 429 is only survivable while another
	// healthy exit can serve the retry. With `healthy:1` a swap would leave the
	// pool empty, so the ladder must not spend it: it goes straight to the
	// rotation, exactly as it does when there is no target at all.
	const pool = (healthy, recycling, exits) => ({ ok: true, pool_size: 2, healthy, recycling, exits });
	const thinPool = pool(1, false, [
		`${EXIT_A} (in_use, served=42, streams=1)`,
		`${EXIT_B} (cooldown, served=7, streams=0)`,
	]);
	const bodies = [
		// our own attempt's window: EXIT_A is the only counter that moved
		pool(2, false, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		pool(2, false, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		// the pool the guard reads: EXIT_B went to cooldown, so draining EXIT_A
		// would leave nothing to serve the retry.
		thinPool,
		// the rotation's own window: quiet, then recycling, and finally the pool it
		// replaced — every old id gone and a new one serving, which is what the
		// resend waits for
		thinPool,
		pool(1, true, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (cooldown, served=7, streams=0)`]),
		pool(1, false, [`warp-fresh (healthy, served=0, streams=0)`]),
	];
	let index = 0;
	const nextHealth = () => healthJson(bodies[Math.min(index++, bodies.length - 1)]);
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: "warp-fresh" }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "thin-pool" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(warpStateForTests().tunnelExit, EXIT_A, "the ladder had a real target to swap");
			assert.equal(swapPosts(fake.calls).length, 0, "a thin pool must not drain the exit that served the 429");
			assert.equal(recyclePosts(fake.calls).length, 1, "the recovery continued to the rotation");
			assert.equal(res.status, 200, "the rotation's resend delivered the turn");
		},
	);
});

test("ladder: a swap the pool replaced is judged settled, not stranded (S14)", async () => {
	// S14 measures stranding BY COUNT, never by identity: a re-enrolment publishes
	// a NEW id, so the drained id never comes back and its absence proves nothing.
	// Here the pool is back to the same usable count under a new id, which is a
	// settled swap — and the next run is free to spend another swap because the
	// consecutive counter was reset instead of being pushed towards the suspension.
	const pool = (healthy, exits) => ({ ok: true, pool_size: 2, active: healthy, cooling_down: 0, healthy, recycling: false, exits });
	const FRESH = "warp-fresh";
	const replaced = (served) =>
		pool(2, [`${EXIT_B} (in_use, served=${served}, streams=1)`, `${FRESH} (healthy, served=0, streams=0)`]);
	const bodies = [
		// run 1 — our own attempt's window: EXIT_A is the exit that served the 429
		pool(2, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		pool(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		// the standby guard: two usable exits, recorded before the swap
		pool(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		// accepted, drained and still out: the retry waits instead of leaving on the
		// standby the drained exit left behind
		pool(1, [`${EXIT_B} (in_use, served=7, streams=0)`]),
		// and here the pool is whole again with a BRAND-NEW id, which is what buys
		// the resend
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${FRESH} (healthy, served=0, streams=0)`]),
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${FRESH} (healthy, served=0, streams=0)`]),
		// run 2 — a clean attribution window again, under the NEW ids
		replaced(7),
		// the guard: two usable exits again, so the swap SETTLED and the streak resets
		replaced(8),
		replaced(8),
		// the next swap's own replacement
		pool(2, [`${FRESH} (in_use, served=0, streams=1)`, "warp-newer (healthy, served=0, streams=0)"]),
	];
	let index = 0;
	const nextHealth = () => healthJson(bodies[Math.min(index++, bodies.length - 1)]);
	const nextUpstream = upstreamThen([429, 200, 429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			return nextUpstream();
		},
		async (fake) => {
			const first = fakeRelayRes();
			await forward(fakeReq({ marker: "settles" }), first, RESEND_PATH, FORWARD_CONFIG);
			assert.equal(first.status, 200, "the resend waits for the new exit and is delivered by it");

			const second = fakeRelayRes();
			await forward(fakeReq({ marker: "settled" }), second, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(
				swapPosts(fake.calls).length,
				2,
				"a pool restored to the same usable count is a settled swap, not a stranding",
			);
			assert.equal(second.status, 200, "and the next run recovers with the cheap step");
			assert.equal(upstreamCalls(fake.calls).length, 4, "original, post-swap retry, original, post-swap retry");
		},
	);
});

test("ladder: a stranded drain is judged on the next run, never inline (S14)", async () => {
	// The proxy's drain took 120s on 2026-11-05 (20:37:18 asked -> 20:39:18
	// drained), so the old 10s settle wait labelled a healthy swap as stranded.
	// The verdict now waits for the next run and it is a COUNT: the pool had three
	// usable exits when the swap went out and has two now, so the swap stranded,
	// and this run spends no second swap even though two healthy exits remain —
	// the recovery it buys is the recycle.
	const EXIT_C = "warp-18e3d7f901ab45c6";
	const pool = (healthy, exits) => ({ ok: true, pool_size: 3, active: healthy, cooling_down: 0, healthy, recycling: false, exits });
	const two = [`${EXIT_B} (in_use, served=8, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`];
	const FRESH = "warp-fresh";
	const bodies = [
		// run 1 — our own attempt's window: EXIT_A is the exit that served the 429
		pool(3, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`]),
		pool(3, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`]),
		// the standby guard: three usable exits, recorded before the swap
		pool(3, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`]),
		// accepted and drained, with the drained id still out: the retry waits
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`]),
		// the replacees landed, so the retry is delivered on the fresh exit
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`, `${FRESH} (healthy, served=0, streams=0)`]),
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`, `${FRESH} (healthy, served=0, streams=0)`]),
		// run 2 — attribution window, then a new 429 with the pool one usable exit
		// short of what the swap started from: one stranding, and the swap is stood
		// down for this run
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`, `${FRESH} (healthy, served=0, streams=0)`]),
		pool(2, [`${EXIT_B} (in_use, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`, `${FRESH} (healthy, served=0, streams=0)`]),
		pool(2, two),
		// the recycle's own before-snapshot
		pool(2, two),
		// the pool it replaced: every old id gone and new ones serving
		pool(2, ["warp-r1 (in_use, served=0, streams=1)", "warp-r2 (healthy, served=0, streams=0)"]),
	];
	let index = 0;
	const nextHealth = () => healthJson(bodies[Math.min(index++, bodies.length - 1)]);
	const nextUpstream = upstreamThen([429, 200, 429, 200]);
	let recycleCalls = 0;
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) {
				recycleCalls += 1;
				return new Response("", { status: 200 });
			}
			return nextUpstream();
		},
		async (fake) => {
			const first = fakeRelayRes();
			await forward(fakeReq({ marker: "drains" }), first, RESEND_PATH, FORWARD_CONFIG);
			assert.equal(first.status, 200, "the resend waits for the new exit and is delivered by it");

			const second = fakeRelayRes();
			await forward(fakeReq({ marker: "stranded" }), second, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(
				swapPosts(fake.calls).length,
				1,
				"one exit fewer than the swap started from is a stranding, so this run spends no swap",
			);
			assert.equal(recycleCalls, 1, "the recovery it does buy is the recycle");
			assert.equal(second.status, 200, "and the recycle still recovers the turn");
			assert.equal(upstreamCalls(fake.calls).length, 4, "original, post-swap retry, original, post-recycle retry");
		},
	);
});

test("ladder: two stranded drains in a row turn the targeted swap off (S14)", async () => {
	// One stranded drain can be one exit having a bad day. Two in a row mean the
	// pool cannot replace what the ladder drains, so the ladder stops spending
	// enrollments instead of grinding a swap per 429: the third run spends none and
	// still answers the client with the original 429 byte-exact.
	//
	// The verdict is deferred (S14), so each stranding is counted by the run AFTER
	// the swap that drained the exit, which is why this needs three recoveries and
	// no sleeping: nothing waits for a drain inside a request.
	const FRESH = "warp-replaced-fresh";
	const file = join(logDir(), "relay-stranded-guard.jsonl");
	setLogFileForTests(file);
	resetWarpStateForTests();

	// Read in order, one entry per `/health` read:
	//   run 1: our own window, the attribution's after-shot, the standby guard
	//          (three usable exits, the count that gets recorded), the drained pool
	//          the retry now WAITS OUT, the pool that replaced it (new id), the
	//          resend's own attribution window, then the recycle's before-read;
	//   run 2: the pool that is one usable exit short, so the guard counts the
	//          first stranding and stands the swap down — with two healthy exits
	//          left, so nothing but the verdict can refuse it;
	//   run 3: the pool filled back to three under a new id, nothing pending, so
	//          the swap is allowed again and drains EXIT_A, and the retry waits for
	//          that replacement too;
	//   run 4: one exit short again, the guard counts the second stranding and
	//          suspends the swap.
	// The tail repeats, because a refused recycle reads `/health` once more.
	// Three exits, not two: a stranding that leaves no standby would be refused by
	// the standby guard anyway, and the verdict itself has to be what refuses.
	const pool = (healthy, exits) => ({
		ok: true,
		pool_size: 3,
		active: healthy,
		cooling_down: 0,
		healthy,
		recycling: false,
		exits,
	});
	const EXIT_C = "warp-5b2c9ad4f1e07c33";
	const three = [
		`${EXIT_A} (in_use, served=42, streams=1)`,
		`${EXIT_B} (healthy, served=7, streams=0)`,
		`${EXIT_C} (healthy, served=3, streams=0)`,
	];
	const short = [`${EXIT_B} (in_use, served=8, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`];
	const filled = [
		`${EXIT_B} (in_use, served=7, streams=0)`,
		`${EXIT_C} (healthy, served=3, streams=0)`,
		`${FRESH} (healthy, served=0, streams=0)`,
	];
	const drained = [`${EXIT_B} (in_use, served=7, streams=0)`, `${EXIT_C} (healthy, served=3, streams=0)`];
	const swapped = [
		`${EXIT_C} (healthy, served=3, streams=0)`,
		`${FRESH} (in_use, served=0, streams=1)`,
		"warp-newer (healthy, served=0, streams=0)",
	];
	const remaining = [`${EXIT_C} (healthy, served=3, streams=0)`, `${FRESH} (healthy, served=1, streams=0)`];
	const bodies = [
		// run 1
		pool(3, [`${EXIT_A} (in_use, served=41, streams=1)`, ...three.slice(1)]),
		pool(3, three),
		pool(3, three),
		// accepted, and the drained id is still out: the retry waits
		pool(2, drained),
		// the replacees landed: new id, so the retry leaves on it
		pool(3, filled),
		pool(3, filled),
		pool(3, filled),
		pool(3, filled),
		// run 2
		pool(3, filled),
		pool(3, filled),
		pool(2, short),
		pool(2, short),
		// run 3
		pool(3, filled),
		pool(3, filled),
		pool(3, filled),
		pool(2, drained),
		pool(2, swapped),
		pool(2, swapped),
		pool(2, swapped),
		pool(2, swapped),
		// run 4
		pool(2, swapped),
		pool(2, swapped),
		pool(2, remaining),
		pool(2, remaining),
	];
	let reads = 0;
	const nextHealth = () => healthJson(bodies[Math.min(reads++, bodies.length - 1)]);
	const nextUpstream = upstreamThen([429]);

	const stderr = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = (chunk) => (stderr.push(String(chunk)), true);
	// Every recycle is refused (`202` + `ok:false`): that keeps the pool published
	// above stable and the read order readable, and it is what the proxy does while
	// a swap owns its state.
	const fake = installFakeFetch((call) => {
		if (call.url.endsWith("/health")) return nextHealth();
		if (call.url.endsWith("/swap")) {
			return new Response(JSON.stringify({ ok: true, target: FRESH }), { status: 202 });
		}
		if (call.url.endsWith("/recycle")) {
			return new Response(JSON.stringify({ ok: false, error: "no_standby" }), { status: 202 });
		}
		return nextUpstream();
	});
	try {
		const recover = async (marker) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker }), res, RESEND_PATH, FORWARD_CONFIG);
			return res;
		};

		await recover("strand-one");
		await recover("strand-two");
		assert.equal(
			swapPosts(fake.calls).length,
			1,
			"the run that counts the first stranding spends no swap, although a standby was available",
		);

		const beforeThird = swapPosts(fake.calls).length;
		await recover("strand-three");
		assert.equal(
			swapPosts(fake.calls).length - beforeThird,
			1,
			"one stranding is not a verdict about the pool: the next run swaps again",
		);

		const beforeFourth = swapPosts(fake.calls).length;
		const fourth = await recover("strand-four");
		assert.equal(
			beforeFourth,
			2,
			"two swaps were spent before the suspension",
		);
		assert.equal(
			swapPosts(fake.calls).length - beforeFourth,
			0,
			"a suspended swap is never attempted again, however many 429s follow",
		);
		assert.equal(fourth.status, 429, "the client still gets an answer");
		assert.equal(fourth.body(), GATE_429_BODY, "and it is the original 429, byte-exact");
		assert.equal(
			warpStateForTests().warpSwapUnsupported,
			true,
			"two strandings suspend the swap through the state a missing /swap sets",
		);

		await recover("strand-five");
		assert.equal(swapPosts(fake.calls).length, 2, "and it stays out: the suspension is for the process");

		const events = readEvents(file).map((event) => event.ev);
		assert.equal(events.filter((ev) => ev === "swap_stranded").length, 2, "both strandings are on disk");
		assert.equal(
			events.filter((ev) => ev === "swap_suspended_stranded").length,
			1,
			"the suspension has its own event name",
		);
		assert.equal(
			events.includes("swap_unavailable"),
			false,
			"a stranded pool is never reported as a proxy without /swap",
		);
		assert.equal(
			stderr.filter((line) => /two targeted swaps in a row/.test(line)).length,
			1,
			"one warning names the suspension, not one per 429",
		);
	} finally {
		process.stderr.write = originalWrite;
		fake.restore();
		setLogFileForTests("");
	}
});

// ---------------------------------------------------------------------------
// The resend waits for the pool it paid for (feat/warp-429-contingency)
// ---------------------------------------------------------------------------
// A `202` from `/swap` is acceptance, not completion, and a recycled pool is
// accepted before it exists. The drained exit stays in `exits[]` while the
// standby serves, so a resend sent on the acceptance alone rides the STANDBY and
// the step buys nothing. Observed live on 2026-11-05 21:46-21:49: one swap
// drained one exit, the pool was whole again with a NEW id only ~3 minutes later,
// and the first request that id served was the NEXT one.

/** A two-exit pool in the exact `/health` shape the proxy publishes. */
const poolOf = (healthy, exits, recycling = false) => ({
	ok: true,
	pool_size: 2,
	active: healthy,
	cooling_down: 0,
	healthy,
	recycling,
	exits,
});

/** `/health` bodies in order, plus one recorded fact: whether the pool had
 *  ALREADY changed when the question is asked — an id from `fresh` is published
 *  and none of the `gone` ids is still listed. That flag is the only honest way
 *  to pin "the resend waited": asserting on elapsed time would also pass for an
 *  implementation that resends first and waits afterwards, and on a bare "a fresh
 *  id exists" a rotation that merely enrolled one exit would pass too. */
function watchedPool(bodies, { fresh, gone = [] }) {
	let reads = 0;
	let changed = false;
	return {
		next: () => {
			const body = bodies[Math.min(reads++, bodies.length - 1)];
			const ids = body.exits.map((exit) => exit.slice(0, exit.indexOf("(")).trim());
			if (ids.some((id) => id.startsWith(fresh)) && !gone.some((id) => ids.includes(id))) changed = true;
			return healthJson(body);
		},
		changed: () => changed,
	};
}

test("ladder: the resend waits for the pool to show the new exit after a swap", async () => {
	// The drained exit is still out on the first poll: the resend must not leave
	// yet. On the second poll the pool is whole again with an id that was not
	// there before, and THAT is what buys the resend.
	const FRESH = "warp-7d1c9f0ab3e24518";
	const pool = watchedPool(
		[
			// our own attempt's window, then the standby guard
			poolOf(2, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			// accepted, drained and still out: only the standby can serve
			poolOf(1, [`${EXIT_B} (in_use, served=7, streams=1)`]),
			// whole again, with the exit the swap enrolled
			poolOf(2, [`${EXIT_B} (in_use, served=7, streams=1)`, `${FRESH} (in_use, served=1, streams=1)`]),
		],
		{ fresh: FRESH, gone: [EXIT_A] },
	);
	const changedAtUpstream = [];
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return pool.next();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: FRESH }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			changedAtUpstream.push(pool.changed());
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "waits" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 200, "the request the fresh exit served is the response");
			assert.equal(res.body(), '{"ok":true}');
			assert.equal(swapPosts(fake.calls).length, 1, "one swap, no loop");
			assert.equal(recyclePosts(fake.calls).length, 0, "the swap was enough");
			assert.equal(upstreamCalls(fake.calls).length, 2, "original, then exactly one resend");
			assert.deepEqual(
				changedAtUpstream,
				[false, true],
				"the resend left only after the pool published the new exit",
			);
			assert.equal(warpStateForTests().warpResends, 1);
		},
	);
});

test("ladder: a client gone before the swap changed the pool gets the original 429", async () => {
	// Shown live too: the client gives up before the pool comes back. Nobody is
	// left to answer, so nothing is resent — the swap keeps running in the proxy
	// and the next request finds the fresh exit. A wait that ends here says nothing
	// about stranding: that verdict stays deferred to the next run.
	const FRESH = "warp-4e8b2ad17c95f360";
	let reads = 0;
	let res;
	const bodies = [
		poolOf(2, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
		// the drained exit never comes back within this request's life
		poolOf(1, [`${EXIT_B} (in_use, served=7, streams=1)`]),
	];
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) {
				const body = bodies[Math.min(reads++, bodies.length - 1)];
				// The client walks away while the wait is polling the drained pool.
				if (reads >= 4) res.emit("close");
				return healthJson(body);
			}
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: FRESH }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			res = fakeRelayRes();
			await forward(fakeReq({ marker: "gone" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 429, "no resend means the client gets the real answer");
			assert.equal(res.body(), GATE_429_BODY, "and it is the original 429, byte-exact");
			assert.equal(swapPosts(fake.calls).length, 1, "the accepted swap is left running in the background");
			assert.equal(upstreamCalls(fake.calls).length, 1, "no resend request leaves upstream");
			assert.equal(warpStateForTests().warpResends, 0);
		},
	);
});

test("ladder: the wait ends on the departed connection when no close is fired", async () => {
	// The probe's failing case. Bun never fires `close` on the response of a client
	// that left, so a tracker bound to it keeps the post-swap wait alive for nobody
	// (probe case 3: `swap_ok`, then `swap_wait_ok` 30 s later, and a resend the
	// provider never needed). What Bun does report, measured on Bun 1.3.12 in
	// `.tmp-probe/signals.mjs`, is the connection losing its remote endpoint. That
	// is the only signal this fake exposes: it never emits `close` before the
	// response is written, so a tracker that listens to the response alone cannot
	// pass, and the wait would run on to the pool's own replacement and spend the
	// resend on a client that is gone.
	const FRESH = "warp-5c0a3e8f7b1d2469";
	const peer = { remoteAddress: "127.0.0.1", remotePort: 51234 };
	const before = poolOf(2, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]);
	const standby = poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]);
	const drained = poolOf(1, [`${EXIT_B} (in_use, served=7, streams=1)`]);
	const whole = poolOf(2, [`${EXIT_B} (in_use, served=7, streams=1)`, `${FRESH} (in_use, served=1, streams=1)`]);
	// reads 1-3: our own attempt's window and the standby guard; 4-7: the drained
	// pool the wait polls; 8: the replacement the swap enrolled.
	const bodies = [before, standby, standby, drained, drained, drained, drained, whole];
	let reads = 0;
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) {
				const body = bodies[Math.min(reads++, bodies.length - 1)];
				// The client hangs up while the wait polls the drained pool. Bun reports
				// that by dropping the connection's remote endpoint, and by nothing else.
				if (reads >= 5) {
					peer.remoteAddress = undefined;
					peer.remotePort = undefined;
				}
				return healthJson(body);
			}
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: FRESH }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes({ socket: peer });
			let announcedByClose = false;
			res.on("close", () => {
				if (!res.writableEnded) announcedByClose = true;
			});
			await forward(fakeReq({ marker: "departed" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(announcedByClose, false, "the departure was never announced as a close on the response");
			assert.equal(res.status, 429, "nobody was left to answer, so the original status stands");
			assert.equal(res.body(), GATE_429_BODY, "and it is the original 429, byte-exact");
			assert.equal(upstreamCalls(fake.calls).length, 1, "exactly ONE request reached the provider (no resend)");
			assert.equal(swapPosts(fake.calls).length, 1, "the accepted swap is left running in the background");
			assert.equal(warpStateForTests().warpResends, 0);
			assert.ok(
				reads < bodies.length,
				`the wait ended before the pool published the replacement (health reads: ${reads})`,
			);
		},
	);
});

test("ladder: the resend waits for the pool to show the new exits after a recycle", async () => {
	// The same rule on the harder step, and the 10s confirmation budget is NOT its
	// bound: against the drain measured on 2026-11-05 that budget reported
	// `not_confirmed` on rotations that did succeed. Here the swap is refused (no
	// standby), the recycle is accepted, and the resend only leaves once the pool
	// publishes ids that were not there before.
	const R1 = "warp-2f6a8c4d90b1e537";
	const R2 = "warp-8a1d3e6f24c0b795";
	// Accepted: the recycle window opens, then closes, and the SAME two ids are
	// still the pool while the old exit drains. `recycling` flipping back off is the
	// resting state of a healthy pool, so it proves nothing; the drain measured on
	// 2026-11-05 ran for two minutes under it. The reused body keeps that pool up
	// long enough for either policy to reveal itself: a resend sent on the flip
	// leaves here, a resend sent on the replacement leaves after it.
	const draining = poolOf(1, [`${EXIT_A} (draining, served=42, streams=0)`, `${EXIT_B} (in_use, served=7, streams=1)`], true);
	const stillDraining = poolOf(2, [`${EXIT_A} (draining, served=42, streams=0)`, `${EXIT_B} (in_use, served=8, streams=1)`]);
	const pool = watchedPool(
		[
			// our own attempt's window, then the standby guard
			poolOf(2, [`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			// the rotation's own before-snapshot
			poolOf(2, [`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`]),
			draining,
			...Array(8).fill(stillDraining),
			// the old ids are gone and the fresh enrollments are serving: now
			poolOf(2, [`${R1} (in_use, served=1, streams=1)`, `${R2} (healthy, served=0, streams=0)`]),
		],
		{ fresh: R1, gone: [EXIT_A, EXIT_B] },
	);
	const changedAtUpstream = [];
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return pool.next();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: false, error: "no_standby" }), { status: 409 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			changedAtUpstream.push(pool.changed());
			return nextUpstream();
		},
		async (fake) => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "recycled" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(res.status, 200, "the request the fresh exits served is the response");
			assert.equal(swapPosts(fake.calls).length, 1, "the cheap step was tried first");
			assert.equal(recyclePosts(fake.calls).length, 1, "the harder step ran once");
			assert.equal(upstreamCalls(fake.calls).length, 2, "original, then exactly one resend");
			assert.deepEqual(
				changedAtUpstream,
				[false, true],
				"the resend left only after the pool published exits that were not there before",
			);
			assert.equal(warpStateForTests().warpResends, 1);
		},
	);
});

// ---------------------------------------------------------------------------
// Slice 2 — degradation and the kill switch (S10)
// ---------------------------------------------------------------------------
// An older proxy, or one running the WireGuard stack, has no /swap at all. That
// is not an exit problem, and retrying would burn a cooldown every minute for
// the life of the process: the ladder steps aside once and stays aside. Not
// every non-2xx is JSON either — 405 and 501 answer in plain text.

test("swapWarpExit: a plain-text 501 turns the swap off instead of retrying (S10)", () => {
	const calls = [];
	return withWarpFetch(
		async (url) => {
			calls.push(String(url));
			if (String(url).endsWith("/swap")) {
				return new Response("not supported: this stack has no per-exit swap", { status: 501 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const first = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.equal(first.swapped, false);
			assert.equal(first.reason, "unavailable", "a route that does not exist is not an exit problem");
			assert.equal(warpStateForTests().warpSwapUnsupported, true);

			const second = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.equal(second.reason, "unavailable");
			assert.equal(calls.length, 1, "once is a discovery, twice would be a routine");
		},
	);
});

test("swapWarpExit: a 404 that names unknown_exit is not a missing route (S10)", () => {
	// The proxy sends this shape when the id is gone. Treating it as "no /swap"
	// would switch the ladder off for the rest of the process over one stale id.
	return withWarpFetch(
		async (url) => {
			if (String(url).endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: false, error: "unknown_exit" }), { status: 404 });
			}
			return new Response("{}", { status: 200 });
		},
		async () => {
			const result = await swapWarpExit(WARP_CONFIG, EXIT_A);
			assert.equal(result.reason, "unknown_exit");
			assert.equal(warpStateForTests().warpSwapUnsupported, false, "the route is there; the id was not");
		},
	);
});

test("decideWarpSwap: an unavailable route outranks every other reason", () => {
	assert.deepEqual(decideWarpSwap({ exitId: "a", unavailable: true }), { swap: false, reason: "unavailable" });
	assert.deepEqual(decideWarpSwap({ exitId: "a", enabled: false, unavailable: true }), {
		swap: false,
		reason: "unavailable",
	});
});

test("ladder: RELAY_WARP_SWAP=0 leaves the hard rotation as the only step (S10)", async () => {
	const nextHealth = sequencedHealth([
		[`${EXIT_A} (in_use, served=41, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		// the standby guard, the rotation's own before-read, and then the pool it
		// replaced
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`${EXIT_A} (in_use, served=42, streams=1)`, `${EXIT_B} (healthy, served=7, streams=0)`],
		[`warp-fresh (healthy, served=0, streams=0)`],
	]);
	const nextUpstream = upstreamThen([429, 200]);
	setWarpSwapEnabledForTests(false);
	try {
		await driveWarp(
			(call) => {
				if (call.url.endsWith("/health")) return nextHealth();
				if (call.url.endsWith("/swap")) return new Response(JSON.stringify({ ok: true }), { status: 202 });
				if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
				return nextUpstream();
			},
			async (fake) => {
				// driveWarp resets the module state, so the switch is flipped after it.
				setWarpSwapEnabledForTests(false);
				const res = fakeRelayRes();
				await forward(fakeReq({ marker: "kill-switch" }), res, RESEND_PATH, FORWARD_CONFIG);
				assert.equal(swapPosts(fake.calls).length, 0, "the kill switch is not a suggestion");
			},
		);
	} finally {
		setWarpSwapEnabledForTests(true);
	}
});

// ---------------------------------------------------------------------------
// /health publishes the ladder (S10)
// ---------------------------------------------------------------------------
// A swap that finished leaves the exit pool looking healthy again, so the proxy
// snapshot says nothing about it. The relay's own /health is the one place an
// outside reader — a human, or the peer session on the far side of the tunnel —
// can see whether the ladder ran, was disabled, or degraded.

test("relay /health publishes the swap ladder and its kill switch (S10)", async () => {
	await driveWarp(
		() => {
			throw new Error("GET /health never touches the network");
		},
		async (fake) => {
			const readHealth = async () => {
				const res = fakeRelayRes();
				await handle({ method: "GET", url: "/health" }, res, { ...FORWARD_CONFIG });
				assert.equal(res.status, 200, "the diagnostic endpoint keeps answering 200");
				return JSON.parse(res.body());
			};

			const on = await readHealth();
			for (const field of [
				"warpSwaps",
				"warpSwapEnabled",
				"warpSwapUnsupported",
				"warpSwapInFlight",
				"tunnelExit",
			]) {
				assert.ok(Object.hasOwn(on, field), `/health must publish ${field}`);
			}
			assert.equal(on.warpSwaps, 0, "no swap yet, and the counter says so");
			assert.equal(on.warpSwapInFlight, false);
			assert.equal(on.warpSwapUnsupported, false);
			assert.equal(on.tunnelExit, null, "an unknown exit reads as null, never as a missing key");
			assert.equal(
				on.warpSwapEnabled,
				warpSwapEnabled(process.env.RELAY_WARP_SWAP),
				"with no override the ladder follows RELAY_WARP_SWAP",
			);
			assert.equal(fake.calls.length, 0, "reading /health reaches no proxy");

			setWarpSwapEnabledForTests(false);
			try {
				assert.equal((await readHealth()).warpSwapEnabled, false, "an explicit 0 is absolute");
			} finally {
				setWarpSwapEnabledForTests(true);
			}
			assert.equal(
				(await readHealth()).warpSwapEnabled,
				warpSwapEnabled(process.env.RELAY_WARP_SWAP),
				"restoring the switch restores the ladder",
			);
		},
	);
});

// ---------------------------------------------------------------------------
// Slice 2 — the manual sweep, and a parked pool (S11, S13)
// ---------------------------------------------------------------------------
// The manual command recovers by the CHEAPEST step first: it reads the pool and
// swaps one exit at a time while another usable exit remains, because draining
// the whole pool at once is what produced `acquire failed: no WARP exit
// available (all cooling down or starting)` on this machine. The sweep is
// bounded by the pool it started from — a two-exit pool spends exactly one swap
// per invocation, a three-exit pool at most two — and nothing waits for a drain
// to settle: the identifier of the exit that was drained is usable state, the
// verdict belongs to a later run (S14).
//
// S13 adds the exception: an exit in `cooldown` is parked by the proxy for 30
// minutes and only fresh enrolments clear the parks, so a parked pool goes to
// the recycle in BOTH paths — the swap would spend an enrollment and touch none
// of the parks.

/** The proxy's `/health` as warp-minimal publishes it: `exits[]` always carries
 *  the three fields `<id> (<state>, served=N, streams=N)`. */
function poolBody(healthy, exits, recycling = false) {
	return { ok: true, pool_size: 2, active: exits.length, cooling_down: 0, healthy, recycling, exits };
}

/** `/health` bodies in order; the tail repeats, so a poll that reads more times
 *  than the case anticipated cannot disturb it. */
function poolSequence(bodies) {
	let index = 0;
	return () => healthJson(bodies[Math.min(index++, bodies.length - 1)]);
}

test("manual sweep: a two-exit pool swaps once and stops (S11)", async () => {
	// The whole point of the sweep: one swap leaves one usable exit serving, so
	// the command stops there. Never a second swap, never a recycle in the same
	// run — draining every exit at once is what emptied the pool.
	const twoUsable = poolBody(2, [
		`${EXIT_A} (in_use, served=41, streams=1)`,
		`${EXIT_B} (healthy, served=7, streams=0)`,
	]);
	const oneUsable = poolBody(1, [
		`${EXIT_B} (in_use, served=8, streams=1)`,
		"warp-fresh (draining, served=0, streams=0)",
	]);
	const nextHealth = poolSequence([twoUsable, oneUsable]);
	const out = await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return new Response("", { status: 200 });
		},
		fake => manualWarpRecycle(WARP_CONFIG).then(body => ({ body, fake })),
	);

	assert.equal(swapPosts(out.fake.calls).length, 1, "a two-exit pool spends exactly one swap per invocation");
	assert.equal(recyclePosts(out.fake.calls).length, 0, "the sweep never reaches the harder step while it progresses");
	assert.equal(out.body.steps.length, 1, "the response reports one step, not an aggregate verdict");
	assert.deepEqual(out.body.steps[0], { action: "swap", exit: EXIT_A, outcome: "accepted", usable: 1 });
	assert.equal(out.body.ok, true);
});

test("manual sweep: a single usable exit recycles instead of swapping (S11)", async () => {
	// With one usable exit there is no standby: a swap would leave the pool empty
	// and the proxy would refuse it anyway, so the cheapest step that can work is
	// the recycle.
	const onlyUsable = poolBody(1, [`${EXIT_A} (in_use, served=42, streams=1)`]);
	const recycling = poolBody(1, [`${EXIT_A} (in_use, served=42, streams=0)`], true);
	const nextHealth = poolSequence([onlyUsable, recycling, onlyUsable]);
	const out = await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return new Response("", { status: 200 });
		},
		fake => manualWarpRecycle(WARP_CONFIG).then(body => ({ body, fake })),
	);

	assert.equal(recyclePosts(out.fake.calls).length, 1, "one recycle is the whole recovery");
	assert.equal(swapPosts(out.fake.calls).length, 0, "a pool of one has no standby to swap");
	assert.equal(out.body.steps.length, 1);
	assert.equal(out.body.steps[0].action, "recycle");
	assert.equal(out.body.steps[0].outcome, "accepted");
	assert.equal(out.body.ok, true);
});

test("manual sweep: a parked exit prefers the recycle over the swap (S13)", async () => {
	// `healthy:2` is deliberate: this pool reports a standby, so without the
	// parking rule the sweep WOULD spend a swap. A `cooldown` exit is parked by
	// the proxy for 30 minutes and a swap does not touch the parks — only fresh
	// enrolments do, which is what the recycle buys.
	const parked = poolBody(2, [
		`${EXIT_A} (in_use, served=42, streams=1)`,
		`${EXIT_B} (cooldown, served=7, streams=0)`,
	]);
	const recycling = poolBody(2, [
		`${EXIT_A} (in_use, served=42, streams=0)`,
		`${EXIT_B} (cooldown, served=7, streams=0)`,
	], true);
	const settled = poolBody(2, [
		"warp-fresh (in_use, served=0, streams=1)",
		`${EXIT_B} (healthy, served=7, streams=0)`,
	]);
	const nextHealth = poolSequence([parked, recycling, settled]);
	const out = await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return new Response("", { status: 200 });
		},
		fake => manualWarpRecycle(WARP_CONFIG).then(body => ({ body, fake })),
	);

	assert.equal(swapPosts(out.fake.calls).length, 0, "a parked pool is never swept with swaps");
	assert.equal(recyclePosts(out.fake.calls).length, 1, "the recycle is the step that clears the parks");
	assert.equal(out.body.steps.length, 1);
	assert.deepEqual(out.body.steps[0], { action: "recycle", outcome: "accepted", usable: 2 });
	assert.equal(out.body.ok, true);
});

test("ladder: a parked exit skips the swap and takes the rotation (S13)", async () => {
	// The automatic path obeys the same rule: spending a swap on a parked pool
	// buys an enrollment and clears nothing. `healthy:2` with a `cooldown` exit
	// again isolates the rule from the standby guard, which would otherwise skip
	// the swap for a different reason and hide a regression here.
	const live = poolBody(2, [
		`${EXIT_A} (in_use, served=41, streams=1)`,
		`${EXIT_B} (healthy, served=7, streams=0)`,
	]);
	const served = poolBody(2, [
		`${EXIT_A} (in_use, served=42, streams=1)`,
		`${EXIT_B} (healthy, served=7, streams=0)`,
	]);
	const parked = poolBody(2, [
		`${EXIT_A} (in_use, served=42, streams=1)`,
		`${EXIT_B} (cooldown, served=7, streams=0)`,
	]);
	const recycling = poolBody(2, [
		`${EXIT_A} (draining, served=42, streams=0)`,
		"warp-fresh (in_use, served=0, streams=1)",
	], true);
	// The recycle replaced the whole pool: the old ids are gone and the two ids
	// below were not there before, which is what the resend waits for.
	const settled = poolBody(2, [
		"warp-fresh (in_use, served=0, streams=1)",
		"warp-second (healthy, served=0, streams=0)",
	]);
	const nextHealth = poolSequence([live, served, parked, parked, recycling, settled]);
	const nextUpstream = upstreamThen([429, 200]);
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return nextHealth();
			if (call.url.endsWith("/swap")) {
				return new Response(JSON.stringify({ ok: true, target: EXIT_A }), { status: 202 });
			}
			if (call.url.endsWith("/recycle")) return new Response("{}", { status: 200 });
			return nextUpstream();
		},
		async fake => {
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "parked-pool" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.equal(warpStateForTests().tunnelExit, EXIT_A, "the ladder had a target it could have spent");
			assert.equal(swapPosts(fake.calls).length, 0, "a parked pool is a recycle, never a swap");
			assert.equal(recyclePosts(fake.calls).length, 1, "the rotation is the step that clears the parks");
			assert.equal(res.status, 200, "the rotation's resend delivered the turn");
		},
	);
});

test("egressHeaders: v1 is five headers, v2 adds the affinity set", async () => {
	const { egressHeaders } = await import("../relay.mjs");
	const config = {
		userAgent: "opencode/2.2.7/opencode",
		apiKey: "public",
		session: "ses_abc",
	};

	const dflt = egressHeaders(config);
	assert.equal(Object.keys(dflt).length, 5, "an absent wireMode is v1");
	assert.equal(dflt["x-session-affinity"], undefined);

	const v1 = egressHeaders({ ...config, wireMode: "v1" });
	assert.deepEqual(Object.keys(v1).sort(), [
		"authorization",
		"content-type",
		"user-agent",
		"x-opencode-session",
		"x-opencode-session-id",
	]);
	assert.equal(v1["content-type"], "application/json");
	assert.equal(v1["authorization"], "Bearer public");
	assert.equal(v1["x-opencode-session"], "ses_abc");
	assert.equal(v1["x-opencode-session-id"], "ses_abc");

	const v2 = egressHeaders({ ...config, wireMode: "v2" });
	assert.equal(v2["x-session-affinity"], "ses_abc", "root affinity is the session id");
	assert.equal(v2["X-Session-Id"], "ses_abc");
	assert.equal(v2["x-opencode-client"], "opencode");
	assert.equal(v2["authorization"], "Bearer public", "the v1 set survives under v2");
	assert.equal(Object.keys(v2).length, 8);
});

test("wire mode: env wins over the config file, v1 is the default", async () => {
	const { normalizeWireMode, resolveWireModeHot, readFileWireMode } = await import("../relay.mjs");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	assert.equal(normalizeWireMode(" V2 "), "v2", "case and padding are normalized");
	assert.equal(normalizeWireMode("v1"), "v1");
	assert.equal(normalizeWireMode("v3"), undefined);
	assert.equal(normalizeWireMode(undefined), undefined);

	assert.equal(resolveWireModeHot("v2", "v1"), "v2", "the env override wins");
	assert.equal(resolveWireModeHot(undefined, "v2"), "v2", "the config file answers next");
	assert.equal(resolveWireModeHot(undefined, undefined), "v1", "an absent field keeps the shipped wire");
	assert.equal(resolveWireModeHot("bogus", "v2"), "v2", "an unusable override falls through");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfb-wire-"));
	const ok = path.join(dir, "bridge.json");
	fs.writeFileSync(ok, "\uFEFF" + JSON.stringify({ wireMode: "v2", warpMode: "on" }));
	assert.equal(readFileWireMode(ok), "v2", "a BOM does not hide the value");

	const broken = path.join(dir, "broken.json");
	fs.writeFileSync(broken, "{not json");
	assert.equal(readFileWireMode(broken), undefined, "a malformed file is undefined, never a throw");
	assert.equal(readFileWireMode(path.join(dir, "absent.json")), undefined);
});

test("refreshWireMode: rereads the file per call, an env override pins it", async () => {
	const { refreshWireMode } = await import("../relay.mjs");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfb-hot-"));
	const file = path.join(dir, "bridge.json");
	const config = { wireMode: "v1", wireModeSource: "config", wireConfigPath: file };

	fs.writeFileSync(file, JSON.stringify({ wireMode: "v2" }));
	refreshWireMode(config);
	assert.equal(config.wireMode, "v2", "a config change applies without a restart");

	fs.writeFileSync(file, JSON.stringify({ wireMode: "v1" }));
	refreshWireMode(config);
	assert.equal(config.wireMode, "v1", "and it applies back");

	fs.writeFileSync(file, JSON.stringify({ warpEnabled: "on" }));
	refreshWireMode(config);
	assert.equal(config.wireMode, "v1", "an absent field keeps the last known mode");

	fs.writeFileSync(file, JSON.stringify({ wireMode: "v2" }));
	const pinned = { wireMode: "v1", wireModeSource: "env", wireConfigPath: file };
	refreshWireMode(pinned);
	assert.equal(pinned.wireMode, "v1", "the env override pins the mode");
});

// ---------------------------------------------------------------------------
// Relay release download path (spec odd/tasks/relay-download.md, S6-S7).
//
// These decide whether a downloaded binary is allowed to run, so they are
// covered under plain Node the same way the relay helpers are: `index.ts`
// exports them for exactly this reason.
// ---------------------------------------------------------------------------

const releaseMod = await import("../index.ts");
const { createHash } = await import("node:crypto");

// The real published SHA256SUMS for release v0.4.0 (run 43328430977), copied
// verbatim so the parser is measured against the file it will actually read.
const REAL_SHA256SUMS = [
	"88ec4e7f095a32bfccf0a1ec62b038eaa843b191075f0f7fc76b558ac8ed5665  relay-darwin-arm64",
	"04571e67cd8ff5389db429336b8965eeb1940d0de78328fb353b2eeeeeb06041  relay-darwin-x64",
	"714c133e8fb073e154d69eedd8f2bbbb99aedaf8fc25048b8ef82a273063af47  relay-linux-arm64",
	"c395a478000374e42467e51153deaad009aaeb62bac46e1f9f0a7243d3db1d1e  relay-linux-x64",
	"6c77cab7bc1ef69215b164cc42ed448eaeea20eeb48bbe221e45a112f2aaeedf  relay-windows-x64.exe",
].join("\n");

test("relayAssetName: maps every published platform/arch pair to its real asset name", () => {
	const cases = [
		["win32", "x64", "relay-windows-x64.exe"],
		["linux", "x64", "relay-linux-x64"],
		["linux", "arm64", "relay-linux-arm64"],
		["darwin", "x64", "relay-darwin-x64"],
		["darwin", "arm64", "relay-darwin-arm64"],
	];
	for (const [platform, arch, expected] of cases) {
		assert.equal(releaseMod.relayAssetName(platform, arch), expected, `${platform}/${arch}`);
	}
});

test("relayAssetName: an unpublished pair fails loudly instead of guessing", () => {
	assert.throws(
		() => releaseMod.relayAssetName("freebsd", "x64"),
		/no relay binary is published for freebsd\/x64/,
	);
	assert.throws(() => releaseMod.relayAssetName("linux", "ia32"), /linux\/ia32/);
	assert.throws(() => releaseMod.relayAssetName("win32", "arm64"), /win32\/arm64/);
});

test("parseChecksums: reads the real published file, CRLF and the binary marker", () => {
	const parsed = releaseMod.parseChecksums(REAL_SHA256SUMS);
	assert.equal(parsed.errors.length, 0, parsed.errors.join("; "));
	assert.equal(parsed.entries.size, 5);
	assert.equal(
		parsed.entries.get("relay-linux-x64"),
		"c395a478000374e42467e51153deaad009aaeb62bac46e1f9f0a7243d3db1d1e",
	);

	// A Windows checkout can hand the manifest back with CRLF endings, and
	// `sha256sum --binary` writes `hash *name` instead of `hash  name`.
	const crlf = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789 *relay-linux-x64\r\n\r\n";
	const windows = releaseMod.parseChecksums(crlf);
	assert.equal(windows.errors.length, 0, windows.errors.join("; "));
	assert.equal(
		windows.entries.get("relay-linux-x64"),
		"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	);

	// A truncated digest is not a checksum, and must not silently vanish.
	const broken = releaseMod.parseChecksums("deadbeef  relay-linux-x64");
	assert.equal(broken.entries.size, 0);
	assert.equal(broken.errors.length, 1);
	assert.match(broken.errors[0], /not a sha256 entry/);
});

test("verifyRelayChecksum: refuses a download whose digest does not match", () => {
	const verdict = releaseMod.verifyRelayChecksum({
		assetName: "relay-linux-x64",
		bytes: Buffer.from("not the published binary"),
		checksums: REAL_SHA256SUMS,
	});
	assert.equal(verdict.ok, false, "a mismatch must never be accepted");
	assert.equal(verdict.reason, "mismatch");
	assert.equal(verdict.expected, "c395a478000374e42467e51153deaad009aaeb62bac46e1f9f0a7243d3db1d1e");
	assert.match(verdict.actual, /^[0-9a-f]{64}$/);
	assert.notEqual(verdict.actual, verdict.expected);
	assert.match(verdict.message, /checksum mismatch/);
	assert.equal(verdict.expected === verdict.actual, false);
});

test("verifyRelayChecksum: accepts a matching download and refuses an unlisted asset", () => {
	const bytes = Buffer.from("a binary that arrived intact");
	const digest = createHash("sha256").update(bytes).digest("hex");
	const manifest = `${digest}  relay-linux-x64`;

	const accepted = releaseMod.verifyRelayChecksum({
		assetName: "relay-linux-x64",
		bytes,
		checksums: manifest,
	});
	assert.equal(accepted.ok, true);
	assert.equal(accepted.actual, digest);

	// An asset the manifest does not list cannot be verified, so it must not run.
	const unlisted = releaseMod.verifyRelayChecksum({
		assetName: "relay-darwin-arm64",
		bytes,
		checksums: manifest,
	});
	assert.equal(unlisted.ok, false);
	assert.equal(unlisted.reason, "not-listed");
	assert.match(unlisted.message, /not listed in the published SHA256SUMS/);
});

test("the installed binary keeps its plain name; the previous one is .prev (S1)", () => {
	// The version left the filename on purpose: TWO names, not one per release.
	// `current` is what runs, `current.prev` is what ran before, and a transient
	// `.tmp` exists only while a download is being placed.
	const current = releaseMod.relayBinaryPath("/opt/bin", "relay-linux-x64");
	assert.equal(current, "/opt/bin/relay-linux-x64", "no version in the name");
	assert.equal(releaseMod.relayBinaryPath("/opt/bin", "relay-windows-x64.exe"), "/opt/bin/relay-windows-x64.exe");
	assert.equal(String(current) + ".prev", "/opt/bin/relay-linux-x64.prev");
});

test("the extension registers exactly three commands, no aliases, no argument form", async () => {
	// The catalog fetch is skipped so this test never depends on the network.
	process.env.PI_FREE_BRIDGE_SKIP_CATALOG = "1";
	// S1: the whole point of the change is the autocomplete list, so the list
	// itself is what gets asserted — not a grep of the source.
	const registered = [];
	const pi = {
		registerCommand: (name, options) => registered.push({ name, options }),
		registerProvider: () => {},
		registerTool: () => {},
		on: () => {},
		config: {},
		ui: { notify() {} },
	};
	await releaseMod.default(pi);

	assert.deepEqual(
		registered.map((entry) => entry.name),
		["free-bridge", "free-bridge-warp-recycle", "free-bridge-doctor"],
	);

	const menu = registered.find((entry) => entry.name === "free-bridge");
	assert.equal(menu.options.args, undefined, "the menu takes no arguments");
	assert.equal(menu.options.argumentHint, undefined, "the menu advertises no argument hint");
	assert.equal(menu.options.aliases, undefined, "aliases would still appear in autocomplete");

	// The removed commands must be gone as registrations, not merely hidden.
	for (const gone of [
		"free-bridge-session",
		"free-bridge-refresh",
		"free-bridge-models",
		"free-bridge-warp",
		"free-bridge-wire",
	]) {
		assert.equal(
			registered.some((entry) => entry.name === gone),
			false,
			`${gone} must not be registered`,
		);
	}
});

// ---------------------------------------------------------------------------
// No OpenCode required (spec odd/tasks/no-opencode-required.md, S1 and S5).
//
// The defect a real container test found: on a machine with no OpenCode the
// extension loaded but registered nothing, because model discovery found no
// registry and the factory returned before the registrations. The menu was
// missing exactly where it was most needed.
//
// The registry-reading discovery path is gone (it is the relay's job now), so
// this case is kept as the regression that must not come back: an empty or
// missing catalog may cost the provider, never the commands.
// ---------------------------------------------------------------------------

test("commands register even when model discovery finds nothing at all", () => {
	// The existing registration test above only passes because this developer
	// machine HAS an OpenCode registry. Here HOME points at an empty directory,
	// so discovery is guaranteed to yield zero, and a child process is used
	// because the factory guards double registration on globalThis.
	const home = mkdtempSync(join(tmpdir(), "pfb-no-opencode-"));
	const indexPath = new URL("../index.ts", import.meta.url).href;
	const marker = "@@REGISTERED@@";
	const script = `
		const { default: factory } = await import(${JSON.stringify(indexPath)});
		const registered = [];
		await factory({
			registerCommand: (name) => registered.push(name),
			registerProvider: () => {},
			registerTool: () => {},
			on: () => {},
			config: {},
			ui: { notify() {} },
		});
		process.stdout.write(${JSON.stringify("\n" + marker)} + JSON.stringify(registered));
	`;
	// DRY_RUN keeps the child from spawning a relay; its output is skipped by
	// reading from the marker instead of parsing the whole stream.
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_FREE_BRIDGE_DRY_RUN: "1", PI_FREE_BRIDGE_SKIP_CATALOG: "1" },
		encoding: "utf-8",
	});
	const registered = JSON.parse(output.slice(output.indexOf(marker) + marker.length));

	assert.deepEqual(
		registered,
		["free-bridge", "free-bridge-warp-recycle", "free-bridge-doctor"],
		"zero models must not cost the user the menu",
	);
});

test("the menu shows only the install item when nothing is installed", () => {
	const { visibleMenuIndices, MENU_INSTALL, MENU_ITEMS } = releaseMod;
	assert.equal(MENU_ITEMS.length, 7);

	assert.deepEqual(
		visibleMenuIndices({ relayReady: false, warpReady: false }),
		[MENU_INSTALL],
		"relay not installed: installing is the only real action",
	);
	assert.deepEqual(
		visibleMenuIndices({ relayReady: true, warpReady: false }),
		[0, 1, 2, 4, 5, 6],
		"everything except recycle once the relay runs",
	);
	assert.deepEqual(visibleMenuIndices({ relayReady: true, warpReady: true }), [0, 1, 2, 3, 4, 5, 6]);
});

test("recycle is hidden without a WARP binary and shown with one", () => {
	const { visibleMenuIndices, MENU_RECYCLE } = releaseMod;
	assert.equal(
		visibleMenuIndices({ relayReady: true, warpReady: false }).includes(MENU_RECYCLE),
		false,
		"rotating an exit with no WARP binary can only fail",
	);
	assert.equal(visibleMenuIndices({ relayReady: true, warpReady: true }).includes(MENU_RECYCLE), true);
});

test("the provider is published from the relay catalog with refreshModels wired", () => {
	// S2 as amended: the extension asks the RELAY, never the vendor. A vendor
	// payload ({data:[...]}) must not be understood here any more — that is what
	// "one door" means. Exclusions still apply on this side.
	const home = mkdtempSync(join(tmpdir(), "pfb-catalog-"));
	const marker = "@@PUBLISHED@@";
	const script = `
		const relayBody = { ok: true, models: [
			{ id: "a-free", name: "A Free", limit: { context: 1000, output: 100 }, input: ["text"] },
			{ id: "jev-1.13-free", name: "Excluded on this side", limit: {}, input: ["text"] },
		] };
		const vendorBody = { data: [ { id: "a-free", cost: { text: { input: { price: 0 }, output: { price: 0 } } } } ] };
		const kind = process.env.PFB_PAYLOAD;
		globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (kind === "vendor" ? vendorBody : relayBody) });
		const { default: factory } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
		const providers = [];
		await factory({
			registerCommand: () => {},
			registerProvider: (name, config) => providers.push({ name, config }),
			registerTool: () => {},
			on: () => {},
			config: {},
			ui: { notify() {} },
		});
		const config = providers[0] && providers[0].config;
		// The live republish path: this is the same call the post-install
		// republish and the menu refresh use, so exercising it here covers S3
		// without stubbing a binary download.
		const refreshed = config && config.refreshModels ? await config.refreshModels({ signal: undefined }) : undefined;
		process.stdout.write(${JSON.stringify("\n" + marker)} + JSON.stringify({
			ids: config ? config.models.map((m) => m.id) : [],
			hasRefresh: typeof (config && config.refreshModels) === "function",
			refreshedIds: Array.isArray(refreshed) ? refreshed.map((m) => m.id) : null,
		}));
	`;
	const run = (payloadKind) => {
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, HOME: home, USERPROFILE: home, PI_FREE_BRIDGE_DRY_RUN: "1", PI_FREE_BRIDGE_SKIP_CATALOG: "", PFB_PAYLOAD: payloadKind },
			encoding: "utf-8",
		});
		return JSON.parse(output.slice(output.indexOf(marker) + marker.length));
	};

	const relay = run("relay");
	assert.deepEqual(relay.ids, ["a-free"], "the excluded id is filtered on this side");
	assert.equal(relay.hasRefresh, true, "Pi refreshes the catalog through refreshModels");
	assert.deepEqual(relay.refreshedIds, ["a-free"], "a live refresh republishes through the relay");

	const vendor = run("vendor");
	assert.deepEqual(vendor.ids, [], "a vendor payload is not read here: one door to the vendor");
});

test("parseRelayCatalog: a failed catalog is not an empty catalog", () => {
	// The distinction the menu depends on: "the vendor said 429" and "the vendor
	// offers nothing free" are different facts and must not render the same.
	const genuinelyEmpty = releaseMod.parseRelayCatalog(200, { ok: true, models: [], skipped: 74 });
	assert.deepEqual(genuinelyEmpty.models, []);
	assert.equal(genuinelyEmpty.unavailable, undefined);
	// The relay is the side that knows how many it refused; the dry run reports
	// that number instead of recomputing a list this side no longer builds.
	assert.equal(genuinelyEmpty.skippedCount, 74);

	const failed = releaseMod.parseRelayCatalog(502, { ok: false, reason: "https://x/models -> HTTP 429" });
	assert.equal(failed.models.length, 0);
	assert.match(failed.unavailable, /429/, "a vendor failure must say so, not look empty");

	const free = releaseMod.parseRelayCatalog(200, {
		ok: true,
		models: [{ id: "a-free", name: "A", limit: { context: 1000 }, input: ["text"] }],
	});
	assert.deepEqual(free.models.map((m) => m.id), ["a-free"]);
	assert.equal(free.models[0].meta.limit.context, 1000);
	assert.deepEqual(free.models[0].meta.cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 });
});

// ---------------------------------------------------------------------------
// Relay swap (spec odd/tasks/relay-swap.md, S1-S6): one current binary, one
// previous, one version everybody reads.
// ---------------------------------------------------------------------------

/** A throwaway bin/ directory with the fake binaries a swap will move around. */
function swapFixture(files) {
	const dir = mkdtempSync(join(tmpdir(), "pfb-swap-"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}

const readOr = (dir, name) => {
	try {
		return readFileSync(join(dir, name), "utf8");
	} catch {
		return undefined;
	}
};

test("relay /health reports a readable version (S2)", async () => {
	// Without this the extension cannot tell "an old relay I did not install"
	// from "a relay that has no /models route", and the user gets a bare 404.
	const res = fakeRelayRes();
	await handle({ method: "GET", url: "/health" }, res, { ...FORWARD_CONFIG });
	const health = JSON.parse(res.body());
	assert.equal(typeof health.version, "string", "/health must publish its version");
	assert.notEqual(health.version, "unknown", "a binary that cannot say its version cannot be checked");
	assert.equal(health.version, RELAY_VERSION, "the relay and package.json agree");
});

test("relay version is information, not a contract (S5)", () => {
	// The numbers are aligned today only so we do not lose track of which piece
	// is which; the relay and the extension must be free to move independently.
	// So there is NO gate to test — only readable parsing.
	assert.equal(releaseMod.parseRelayVersion({ version: "0.5.1" }), "0.5.1");
	assert.equal(releaseMod.parseRelayVersion({}), undefined);
	assert.equal(releaseMod.parseRelayVersion(null), undefined);
	assert.equal(releaseMod.parseRelayVersion({ version: 5 }), undefined, "a number is not a version");
});

test("swap: a healthy new binary becomes current and the old one becomes .prev (S3, S4)", async () => {
	const dir = swapFixture({ "relay-linux-x64": "OLD", "relay-linux-x64.tmp": "NEW" });
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => true,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(readOr(dir, "relay-linux-x64"), "NEW", "the new binary is what runs");
	assert.equal(readOr(dir, "relay-linux-x64.prev"), "OLD", "the known-good one is kept for rollback");
	assert.equal(readOr(dir, "relay-linux-x64.tmp"), undefined, "the transient file never survives a swap");
	assert.equal(readOr(dir, "failed.log"), undefined, "nothing failed, so nothing is logged");
});

test("swap: a binary that never answers is rolled back to .prev and deleted (S3.6-7)", async () => {
	const dir = swapFixture({ "relay-linux-x64": "OLD", "relay-linux-x64.tmp": "NEW" });
	let starts = 0;
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		// The new binary never answers; the rollback one does.
		startRelay: async () => ++starts > 1,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, true, "there was a .prev, so it rolled back");
	assert.equal(readOr(dir, "relay-linux-x64"), "OLD", "the known-good binary runs again");
	assert.equal(readOr(dir, "relay-linux-x64.prev"), undefined, "rollback consumes the spare");
	assert.notEqual(readOr(dir, "relay-linux-x64"), "NEW", "the failing binary is never kept");
	const log = readOr(dir, "failed.log");
	assert.ok(log, "the failure is recorded, not silently forgotten");
	assert.match(log, /0\.5\.1/, "the log names the version that failed");
	assert.equal(log.trim().split("\n").length, 1, "one line per failure");
});

test("swap: a first install that fails leaves nothing installed and says so (S4)", async () => {
	const dir = swapFixture({ "relay-linux-x64.tmp": "NEW" });
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => false,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, false, "with no .prev there is nothing to roll back to");
	assert.equal(readOr(dir, "relay-linux-x64"), undefined, "nothing is installed");
	assert.equal(readOr(dir, "relay-linux-x64.prev"), undefined);
	assert.match(String(result.reason), /sin versión anterior|no previous/i, "the reason says why");
	assert.match(readOr(dir, "failed.log") ?? "", /0\.5\.1/, "the failure is still evidence");
});

test("swap: a relay that cannot be stopped aborts before touching anything (S3.3)", async () => {
	const dir = swapFixture({ "relay-linux-x64": "OLD", "relay-linux-x64.tmp": "NEW" });
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => false,
		startRelay: async () => {
			throw new Error("must not start a relay that was never stopped");
		},
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, false);
	assert.match(String(result.reason), /no se pudo detener|could not be stopped/i);
	assert.equal(readOr(dir, "relay-linux-x64"), "OLD", "the running binary is untouched");
	assert.equal(readOr(dir, "relay-linux-x64.prev"), undefined, "no rename happened");
	assert.equal(readOr(dir, "relay-linux-x64.tmp"), "NEW", "the download is not lost either");
});

test("swap: nobody answers the question, so it rolls back on its own (S3.6)", async () => {
	const dir = swapFixture({ "relay-linux-x64": "OLD", "relay-linux-x64.tmp": "NEW" });
	let starts = 0;
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => ++starts > 1,
		askContinue: async () => "none", // nobody answered
	});

	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, true, "an unanswered question must not wait forever");
	assert.equal(readOr(dir, "relay-linux-x64"), "OLD");
});

test("fetchRelayCatalog: a relay without /models still yields a catalog (S5)", async () => {
	// Capability detection: 404 means this relay predates the route, and the
	// extension falls back to the direct service call it made before the route
	// existed. Fallback, not an error state.
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url) => {
			if (String(url).includes("127.0.0.1")) {
				return { ok: false, status: 404, json: async () => ({ error: { message: "no route for GET /models" } }) };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					data: [
						{ id: "beam-free", name: "Beam", cost: { text: { input: { price: 0 }, output: { price: 0 } } }, limit: { context: 1000 } },
						{ id: "paid", cost: { text: { input: { price: 3 }, output: { price: 1 } } } },
					],
				}),
			};
		};
		const result = await releaseMod.fetchRelayCatalog();
		assert.deepEqual(result.models.map((m) => m.id), ["beam-free"], "the direct call still gives a catalog");
		assert.equal(result.unavailable, undefined, "falling back is not an error state");
		assert.match(result.source, /directo|fallback/i, "and the source says where it came from");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the fallback reader agrees with the relay reader (drift guard)", async () => {
	// The fallback duplicates the relay pricing logic on purpose: importing
	// relay.mjs would drag its HTTP server into the Pi extension bundle. Same
	// fixture through both readers, or the copies have silently drifted.
	const fixture = {
		data: [
			{ id: "beam-free", name: "Beam", cost: { text: { input: { price: 0 }, output: { price: 0 } } }, limit: { context: 1048576, output: 131072 }, modalities: { input: ["text"] }, capabilities: { reasoning: { supported: true } } },
			{ id: "flat-free", cost: { input: 0, output: 0 } },
			{ id: "paid", cost: { text: { input: { price: 3 }, output: { price: 15 } } } },
			{ id: "unpriced", cost: {} },
		],
	};
	const fromRelay = freeCatalog(fixture).models.map((m) => m.id);
	assert.deepEqual(fromRelay, ["beam-free", "flat-free"]);
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url) => {
			if (String(url).includes("127.0.0.1")) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => fixture };
		};
		const viaFallback = await releaseMod.fetchRelayCatalog();
		assert.deepEqual(viaFallback.models.map((m) => m.id), fromRelay, "both readers keep the same models");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("swap: older versioned leftovers are purged, the running one is adopted (S1)", async () => {
	// The old scheme left one file per release. Keeping them is a 109 MB
	// cemetery; keeping none of them removes the only real rollback target. So:
	// adopt the one that was running, delete the rest.
	const dir = swapFixture({
		"relay-linux-x64.tmp": "NEW",
		"relay-linux-x64.v0.3.0": "ANCIENT",
		"relay-linux-x64.v0.4.0": "RAN-JUST-NOW",
	});
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		previous: join(dir, "relay-linux-x64.v0.4.0"),
		stopRelay: async () => true,
		startRelay: async () => true,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(readOr(dir, "relay-linux-x64"), "NEW");
	assert.equal(readOr(dir, "relay-linux-x64.prev"), "RAN-JUST-NOW", "the binary that answered /health is kept");
	assert.equal(readOr(dir, "relay-linux-x64.v0.3.0"), undefined, "older leftovers are gone");
	assert.equal(readOr(dir, "relay-linux-x64.v0.4.0"), undefined, "adopted, not left behind");
	const left = readdirSync(dir).sort();
	assert.deepEqual(left, ["relay-linux-x64", "relay-linux-x64.prev"], "two names, nothing else");
});

test("swap: failed.log keeps the last 20 lines and drops the rest (S3.7)", async () => {
	const dir = swapFixture({ "relay-linux-x64": "OLD", "relay-linux-x64.tmp": "NEW" });
	// 25 older failures, so the cap has something to cut.
	const past = Array.from({ length: 25 }, (_, i) => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z\t0.0.${i}\tviejo`).join("\n");
	writeFileSync(join(dir, "failed.log"), past + "\n");

	await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => false,
		askContinue: async () => "rollback",
	});

	const lines = readOr(dir, "failed.log").trim().split("\n");
	assert.equal(lines.length, 20, "a log that grows forever is a log nobody reads");
	assert.match(lines[19], /0\.5\.1/, "the newest failure is the one kept at the end");
	assert.doesNotMatch(lines.join("\n"), /0\.0\.0/, "the oldest lines are the ones dropped");
});

test("the install confirm says it STOPS the running relay, whoever started it (S3.2)", () => {
	// Someone who started the relay by hand deserves to know it will be
	// terminated, not "restarted" as if the extension owned it.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /DETIENE el relay que está corriendo/);
	assert.doesNotMatch(source, /Esto REINICIA el relay/);
});

test("swap: with nothing saying what ran, the newest leftover is adopted (S1)", async () => {
	// No `current` and no config previous: the only evidence of order is the
	// version in the filename, so the highest number becomes the spare.
	const dir = swapFixture({
		"relay-linux-x64.tmp": "NEW",
		"relay-linux-x64.v0.3.0": "OLDEST",
		"relay-linux-x64.v0.4.0": "NEWEST",
		"relay-linux-x64.v0.4.1": "NEWER-STILL",
	});
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => true,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(readOr(dir, "relay-linux-x64"), "NEW");
	assert.equal(readOr(dir, "relay-linux-x64.prev"), "NEWER-STILL", "the highest version survives");
	assert.deepEqual(readdirSync(dir).sort(), ["relay-linux-x64", "relay-linux-x64.prev"]);
});

test("swap: the known-good incumbent beats a higher number on disk (S1)", async () => {
	// A newer file that sits next to a lower one the config says was running is a
	// build somebody rolled back FROM. Keeping it as the spare would hand the next
	// rollback a binary already known to fail.
	const dir = swapFixture({
		"relay-linux-x64.tmp": "NEW",
		"relay-linux-x64.v0.3.0": "KNOWN-GOOD",
		"relay-linux-x64.v0.4.0": "ROLLED-BACK-FROM",
	});
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		previous: join(dir, "relay-linux-x64.v0.3.0"),
		stopRelay: async () => true,
		startRelay: async () => true,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(readOr(dir, "relay-linux-x64.prev"), "KNOWN-GOOD", "the build that answered /health is the spare");
	assert.equal(readOr(dir, "relay-linux-x64.v0.4.0"), undefined, "the rolled-back build is deleted, not kept");
	assert.deepEqual(readdirSync(dir).sort(), ["relay-linux-x64", "relay-linux-x64.prev"]);
});

test("swap: a file the tool did not create survives the purge (S1)", async () => {
	// The purge matches by shape, so a human's notes in the same directory are not
	// collateral damage. A cleanup that deletes by wildcard eats what it did not make.
	const dir = swapFixture({ "relay-linux-x64": "OLD", "relay-linux-x64.tmp": "NEW" });
	writeFileSync(join(dir, "notes.txt"), "mine");
	writeFileSync(join(dir, "relay-linux-x64.keep-me"), "mine too");

	await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => true,
		askContinue: async () => "rollback",
	});

	assert.equal(readOr(dir, "notes.txt"), "mine");
	assert.equal(readOr(dir, "relay-linux-x64.keep-me"), "mine too", "not a version, so not ours to delete");
});

test("the extension never names an installed relay after a version (S1)", () => {
	// The container run that reported bin/relay-linux-x64.v0.5.0 was running the
	// published 0.5.1, whose namer was relayBinaryFilename(asset, tag). This guard
	// exists so that behaviour cannot come back: one namer, no version in a name.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /relayBinaryFilename/, "the version-in-filename namer must not exist");
	assert.doesNotMatch(
		source,
		/\.v\$\{/,
		"no path may interpolate a version into a file name",
	);

	// Every write of a binary goes through the two-name layout: the staged file is
	// hand-built here and nowhere else.
	const staged = source.match(/const staged = [^\n]+/g) ?? [];
	assert.equal(staged.length, 1, "exactly one place stages a downloaded binary");
	assert.match(staged[0], /relayBinaryPath\(RELAY_INSTALL_DIR/, staged[0]);

	// And the namer itself is version-free for every asset name.
	for (const asset of ["relay-linux-x64", "relay-darwin-arm64", "relay-windows-x64.exe"]) {
		assert.equal(releaseMod.relayBinaryPath("/bin", asset), "/bin/" + asset);
	}
});

test("a failed update leaves the previous good binary in place, byte for byte (S3.6)", async () => {
	// The invariant, stated as an end state instead of as "the rollback ran":
	// after a failed update WITH a good previous binary, the directory holds the
	// working binary and nothing else, its bytes are the PREVIOUS ones, and the
	// restart happened while those bytes were already at the canonical name.
	const dir = swapFixture({ "relay-linux-x64": "GOOD-1", "relay-linux-x64.tmp": "BROKEN-2" });
	const seenByRestart = [];
	let starts = 0;
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.0",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => {
			starts += 1;
			seenByRestart.push(readOr(dir, "relay-linux-x64"));
			return starts > 1; // the new binary fails, the restored one works
		},
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, true, JSON.stringify(result));
	assert.equal(readOr(dir, "relay-linux-x64"), "GOOD-1", "the good bytes are back at the canonical name");
	assert.deepEqual(
		readdirSync(dir).sort(),
		["failed.log", "relay-linux-x64"],
		"one binary and the evidence, no corpses",
	);
	assert.equal(seenByRestart[1], "GOOD-1", "the restart saw the restored binary, not the failed one");
	assert.match(readOr(dir, "failed.log"), /\t0\.5\.0\t/, "the failure is recorded");
});

test("a failed update with no previous binary removes nothing good (S3.6)", async () => {
	// The other half of the same invariant: when there is no spare there is no
	// good copy to protect, so the failed binary goes and failed.log stays. What
	// must never happen is deleting a working binary in the name of rollback.
	const dir = swapFixture({ "relay-linux-x64.tmp": "BROKEN-1" });
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.0",
		timeoutMs: 50,
		stopRelay: async () => true,
		startRelay: async () => false,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, false, "nothing to roll back to");
	assert.match(result.reason, /no previous/);
	assert.equal(readOr(dir, "relay-linux-x64"), undefined, "a failing binary does not stay at the canonical name");
	assert.deepEqual(readdirSync(dir).sort(), ["failed.log"]);
});

test("a stale versioned relayBin is migrated to the canonical name (S3.0)", () => {
	// Every install from before the two-name layout left
	// relayBin = ".../bin/relay-linux-x64.v0.4.0". Nothing produces that name any
	// more, so every start after the layout change pointed at a dead path: the
	// relay never answered and the swap rolled back on a machine that had been
	// healthy a minute earlier. The stale path is the bug, so it is rewritten.
	const writes = [];
	const resolved = releaseMod.migrateRelayBinConfig("/bin", "relay-linux-x64", {
		read: () => ({ relayBin: "/bin/relay-linux-x64.v0.4.0" }),
		write: (patch) => writes.push(patch),
		exists: () => true,
	});
	assert.equal(resolved, "/bin/relay-linux-x64");
	assert.deepEqual(writes, [{ relayBin: "/bin/relay-linux-x64" }], "written once, not on every start");
});

test("a relayBin pointing at a file that is gone is migrated too (S3.0)", () => {
	const writes = [];
	const resolved = releaseMod.migrateRelayBinConfig("/bin", "relay-linux-x64", {
		read: () => ({ relayBin: "/elsewhere/gone-binary" }),
		write: (patch) => writes.push(patch),
		exists: () => false,
	});
	assert.equal(resolved, "/bin/relay-linux-x64");
	assert.equal(writes.length, 1);
});

test("a healthy canonical relayBin is left alone (S3.0)", () => {
	const writes = [];
	const resolved = releaseMod.resolveRelayBin("/bin", "relay-linux-x64", {
		read: () => ({ relayBin: "/bin/relay-linux-x64" }),
		write: (patch) => writes.push(patch),
		exists: () => true,
	});
	assert.equal(resolved, "/bin/relay-linux-x64");
	assert.deepEqual(writes, [], "no write when nothing is wrong");
});

test("migration plus update: the versioned file becomes the spare (S1, S3.0)", async () => {
	// The end state the migration promises: the leftover is adopted as .prev, the
	// two names are the only ones left, and the config stops naming the dead path.
	const dir = swapFixture({ "relay-linux-x64.v0.4.0": "GOOD-LEGACY", "relay-linux-x64.tmp": "BROKEN-NEW" });
	const writes = [];
	const previous = releaseMod.migrateRelayBinConfig(dir, "relay-linux-x64", {
		read: () => ({ relayBin: join(dir, "relay-linux-x64.v0.4.0") }),
		write: (patch) => writes.push(patch),
		exists: (path) => existsSync(path),
	});
	const result = await releaseMod.swapRelayBinary({
		dir,
		name: "relay-linux-x64",
		downloaded: join(dir, "relay-linux-x64.tmp"),
		version: "0.5.1",
		timeoutMs: 50,
		previous,
		stopRelay: async () => true,
		startRelay: async () => false,
		askContinue: async () => "rollback",
	});

	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, true, JSON.stringify(result));
	assert.deepEqual(writes, [{ relayBin: join(dir, "relay-linux-x64") }]);
	assert.equal(readOr(dir, "relay-linux-x64"), "GOOD-LEGACY", "the legacy build is what runs again");
	assert.deepEqual(readdirSync(dir).sort(), ["failed.log", "relay-linux-x64"], "no versioned leftovers");
});

test("a second install is refused while one is running (S3.8)", () => {
	// A second Enter during the download started a second swap against the same
	// two names. One at a time, in process.
	assert.equal(releaseMod.isRelayInstallInFlight(), false);
	assert.equal(releaseMod.beginRelayInstall(), true);
	assert.equal(releaseMod.beginRelayInstall(), false, "the second one is refused");
	assert.equal(releaseMod.isRelayInstallInFlight(), true);
	releaseMod.endRelayInstall();
	assert.equal(releaseMod.isRelayInstallInFlight(), false, "and the next one is allowed again");
	assert.equal(releaseMod.beginRelayInstall(), true);
	releaseMod.endRelayInstall();
});

test("resolving never writes: declining an install changes nothing (S3.0)", () => {
	// The migration is a mutation, and the confirm comes first. Resolving is what
	// the prompt needs to name the previous binary; if it wrote, saying "no" would
	// leave a config pointing at a path that does not exist yet.
	const writes = [];
	const resolved = releaseMod.resolveRelayBin("/bin", "relay-linux-x64", {
		read: () => ({ relayBin: "/bin/relay-linux-x64.v0.4.0" }),
		write: (patch) => writes.push(patch),
		exists: () => true,
	});
	assert.equal(resolved, "/bin/relay-linux-x64", "the prompt names the path that will exist");
	assert.deepEqual(writes, [], "and nothing on disk changed");
});

test("a versioned leftover is never treated as the relay to start (S3.0)", () => {
	// After the layout change a `.v0.5.0` may still sit on disk. Starting it would
	// run the build the human just replaced, so the name itself disqualifies it.
	assert.equal(releaseMod.isVersionedRelayBinName("/bin/relay-linux-x64.v0.4.0"), true);
	assert.equal(releaseMod.isVersionedRelayBinName("C:\\bin\\relay-windows-x64.exe.v0.4.0"), true);
	assert.equal(releaseMod.isVersionedRelayBinName("/bin/relay-linux-x64"), false);
	assert.equal(releaseMod.isVersionedRelayBinName("/bin/relay-linux-x64.prev"), false);
	assert.equal(
		releaseMod.isVersionedRelayBinName("/usr/local/bin/relay-2"),
		false,
		"a foreign binary with a number in it is not ours to ignore",
	);
});
