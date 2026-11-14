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
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
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
		const call = {
			url: String(url),
			method: String(opts.method ?? "GET").toUpperCase(),
			body: opts.body,
			// S3: the preference travels in the proxy URL, so the fake has to keep it.
			proxy: opts.proxy,
		};
		calls.push(call);
		return handler(call);
	};
	return { calls, restore: () => (globalThis.fetch = original) };
}

/** One case: fresh warp state, fake network, millisecond rotation window. */
async function driveWarp(handler, run) {
	resetWarpStateForTests();
	setWarpRotationTimingForTests(500, 1);
	// These cases pin the ladder against the proxy surface of the slice they were
	// written for: `/health`, `/swap`, `/recycle`. `GET /exits` answers 404 here on
	// purpose — that is an older binary, the relay then sends no credential, and the
	// ladder under test is the only thing in the picture. Routing has its own cases
	// at the end of this file, against a proxy that publishes the list.
	const fake = installFakeFetch((call) =>
		call.url.endsWith("/exits") ? new Response("", { status: 404 }) : handler(call),
	);
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

test("resendAfterRotation: the resend's own 429 is what the client gets, retry-after included (S28)", async () => {
	// S28: the client can only act on the FRESHEST window, and after a paid resend
	// that window is the resend's own `retry-after` — the original's window was
	// measured before an enrollment was spent and is already out of date.
	const nextHealth = recyclingThenQuiet();
	const resendRefusal = '{"type":"FreeUsageLimitError","from":"fresh-exit"}';
	const original = { ...ORIGINAL_429, retryAfter: "3600" };
	await driveWarp(
		(call) => {
			if (call.url.endsWith("/health")) return healthJson(nextHealth());
			if (call.url.endsWith("/recycle")) return new Response("", { status: 200 });
			return new Response(resendRefusal, {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "120" },
			});
		},
		async (fake) => {
			const delivered = await resendAfterRotation(
				WARP_CONFIG,
				RESEND_PATH,
				{ model: "m", messages: [] },
				original,
				undefined,
			);

			assert.equal(upstreamCalls(fake.calls).length, 1, "the resend happened");
			assert.equal(delivered.response.status, 429);
			assert.equal(delivered.egress, "warp", "the refusal came from the fresh exit, so warp delivered it");
			assert.equal(delivered.response.headers.get("content-type"), "application/json");
			assert.equal(
				await delivered.response.text(),
				resendRefusal,
				"the last real refusal, never the one round 1 measured",
			);
			assert.equal(
				delivered.response.headers.get("retry-after"),
				"120",
				"the freshest reset window is the one the client acts on",
			);
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
			// An older proxy: this case is about the delivery counter, never routing.
			if (u.endsWith("/exits")) return new Response("", { status: 404 });
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
			assert.deepEqual(
				fake.calls.map((call) => call.url),
				["http://127.0.0.1:8789/health"],
				"reading /health reads the proxy's health once and never probes /exits (D9)",
			);

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

test("the extension registers exactly four commands, no aliases, no argument form", async () => {
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
		["free-bridge", "free-bridge-warp-recycle", "free-bridge-warp-update", "free-bridge-doctor"],
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
		["free-bridge", "free-bridge-warp-recycle", "free-bridge-warp-update", "free-bridge-doctor"],
		"zero models must not cost the user the menu",
	);
});

test("free-bridge-warp-update says what it does and refuses to run blind", (t) => {
	// The command is the one entry point that replaces the proxy binary, so its
	// autocomplete line has to name the release it fetches and the stop it costs.
	// Asserted through the registration a fake `pi` captures, never a source grep:
	// this is exactly what Pi shows when the user types `/free-bridge`. A child
	// process is used because the factory guards double registration on
	// globalThis, so the in-process test above already consumed it.
	const home = mkdtempSync(join(tmpdir(), "pfb-warp-update-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const marker = "@@WARP-UPDATE@@";
	const script = `
		const { default: factory } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
		const commands = {};
		await factory({
			registerCommand: (name, options) => { commands[name] = options; },
			registerProvider: () => {},
			registerTool: () => {},
			on: () => {},
			config: {},
			ui: { notify() {} },
		});
		const seen = [];
		const ctx = { hasUI: false, ui: { notify: (text, kind) => seen.push({ text, kind }) } };
		await commands["free-bridge-warp-update"].handler("", ctx);
		process.stdout.write(${JSON.stringify("\n" + marker)} + JSON.stringify({
			names: Object.keys(commands),
			description: commands["free-bridge-warp-update"].description,
			hasHandler: typeof commands["free-bridge-warp-update"].handler === "function",
			seen,
		}));
	`;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_FREE_BRIDGE_DRY_RUN: "1", PI_FREE_BRIDGE_SKIP_CATALOG: "1" },
		encoding: "utf-8",
	});
	const captured = JSON.parse(output.slice(output.indexOf(marker) + marker.length));

	assert.equal(captured.names.includes("free-bridge-warp-update"), true, "the update command is registered");
	assert.equal(
		captured.description,
		"Update warp-minimal to the latest release — the only command that stops the proxy to replace its binary",
	);
	assert.equal(captured.hasHandler, true, "the command is actually runnable");

	// Without a UI nobody can read the cost or answer the confirmation, so the
	// handler must refuse and say why instead of stopping the proxy blind.
	assert.equal(captured.seen.length, 1, "the refusal answers exactly once");
	assert.equal(captured.seen[0].kind, "warning");
	assert.match(captured.seen[0].text, /STOPS the proxy/, "it says the stop it would cost");
	assert.match(captured.seen[0].text, /no UI to ask in/, "it names the reason it cannot ask");
	assert.match(captured.seen[0].text, /free-bridge-warp-update from an interactive Pi/, "and where to run it instead");
});

test("the install item exists only for machines without Bun", () => {
	const { visibleMenuIndices, MENU_INSTALL, MENU_ITEMS } = releaseMod;
	assert.equal(MENU_ITEMS.length, 7);

	// Nothing at all: installing is the only real action.
	assert.deepEqual(
		visibleMenuIndices({ bunReady: false, binaryPresent: false, warpReady: false }),
		[MENU_INSTALL],
		"no Bun and no binary: installing is the only real action",
	);
	// A binary without Bun: the row is how it gets installed and updated.
	assert.deepEqual(
		visibleMenuIndices({ bunReady: false, binaryPresent: true, warpReady: false }),
		[0, 1, 2, 4, 5, 6],
		"a binary still needs the row to update itself, and Bun is absent",
	);
	// Bun, with or without a binary: the row means nothing. npm carries the
	// relay source, and a binary next to Bun is dead weight rather than a path.
	assert.deepEqual(
		visibleMenuIndices({ bunReady: true, binaryPresent: false, warpReady: false }),
		[1, 2, 4, 5, 6],
		"Bun runs the relay: nothing to install, and npm carries the update",
	);
	assert.deepEqual(
		visibleMenuIndices({ bunReady: true, binaryPresent: true, warpReady: false }),
		[1, 2, 4, 5, 6],
		"Bun present hides the row even when an old binary is still on disk",
	);
});

test("recycle joins the menu only with a WARP binary, and only when the relay can run", () => {
	const { visibleMenuIndices, MENU_RECYCLE } = releaseMod;
	assert.equal(
		visibleMenuIndices({ bunReady: true, binaryPresent: false, warpReady: true }).includes(MENU_RECYCLE),
		true,
		"Bun runs the relay and a WARP binary exists: rotating is a real action",
	);
	assert.equal(
		visibleMenuIndices({ bunReady: false, binaryPresent: true, warpReady: true }).includes(MENU_RECYCLE),
		true,
		"a binary runs the relay and a WARP binary exists",
	);
	assert.equal(
		visibleMenuIndices({ bunReady: false, binaryPresent: false, warpReady: true }).includes(MENU_RECYCLE),
		false,
		"nothing runs the relay, so there is no exit to rotate",
	);
});

test("the doctor reports instead of throwing, and never names a dead field", () => {
	// Nothing exercised this handler, so a refactor that deleted the live-ids
	// snapshot shipped a doctor that crashed on its first line: `live.source`
	// referenced a binding that no longer existed, and `discovered.skipped` a
	// field the catalog never had. The command is a public surface — it is what
	// the README tells a stuck user to run — so it is asserted by its output.
	const home = mkdtempSync(join(tmpdir(), "pfb-doctor-"));
	const marker = "@@DOCTOR@@";
	const script = `
		const { default: factory } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
		const commands = {};
		await factory({
			registerCommand: (name, cfg) => { commands[name] = cfg; },
			registerProvider: () => {},
			registerTool: () => {},
			on: () => {},
			config: {},
			ui: { notify() {} },
		});
		const seen = [];
		const ctx = { hasUI: false, ui: { notify: (text, kind) => seen.push({ text, kind }) } };
		await commands["free-bridge-doctor"].handler("", ctx);
		process.stdout.write(${JSON.stringify("\n" + marker)} + JSON.stringify(seen));
	`;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_FREE_BRIDGE_DRY_RUN: "1" },
		encoding: "utf-8",
	});
	const seen = JSON.parse(output.slice(output.indexOf(marker) + marker.length));

	assert.equal(seen.length, 1, "the doctor answers once, however the machine is configured");
	const text = seen[0].text;
	assert.match(text, /^pi-free-bridge doctor/, "the report identifies itself");
	assert.match(text, /registered: \d+ free models from /, "it says how many models, and where they came from");
	assert.match(
		text,
		/skipped:\s+(unknown \(the catalog did not report a count\)|\d+ \(not free, per the relay\))/,
		"the skipped line reads the field the catalog actually publishes",
	);
	assert.doesNotMatch(text, /live ids/, "the live-ids line died with the snapshot it read");
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

test("Bun wins over a binary, and the binary stays on disk as the fallback", () => {
	// The compiled binary is relay.mjs with the Bun runtime inside: the same
	// relay, so nothing about behaviour separates them. What separates them is
	// how they update — `pi install` refreshes the script that ships in this
	// package, and nothing refreshes a binary. So the script wins whenever Bun is
	// there, and the binary that stays on disk is what answers the day Bun is gone.
	const { resolveRelayCommand } = releaseMod;
	const dir = "/relay-dir";
	const canonical = `${dir}/relay-linux-x64`;
	const everywhere = () => true;
	const nothing = () => false;

	assert.deepEqual(
		resolveRelayCommand({
			dir,
			exists: everywhere,
			bunPath: () => "/usr/bin/bun",
			read: () => ({ relayBin: "/custom/relay-linux-x64" }),
		}),
		{ kind: "bun", path: "/usr/bin/bun" },
		"Bun present: neither a configured nor a canonical binary gets to win",
	);
	assert.deepEqual(
		resolveRelayCommand({
			dir,
			exists: (path) => path === "/custom/relay-linux-x64",
			bunPath: () => undefined,
			read: () => ({ relayBin: "/custom/relay-linux-x64" }),
		}),
		{ kind: "binary", path: "/custom/relay-linux-x64" },
		"no Bun: a configured binary answers before the canonical name",
	);
	assert.deepEqual(
		resolveRelayCommand({
			dir,
			exists: (path) => path === canonical,
			bunPath: () => undefined,
			read: () => ({}),
		}),
		{ kind: "binary", path: canonical },
		"no Bun and no config: the canonical name answers",
	);
	assert.equal(
		resolveRelayCommand({
			dir,
			exists: (path) => path === "/custom/relay-linux-x64.v0.4.0",
			bunPath: () => undefined,
			read: () => ({ relayBin: "/custom/relay-linux-x64.v0.4.0" }),
		}),
		undefined,
		"a versioned leftover is not a command, so the caller reports the S27 error",
	);
	assert.equal(
		resolveRelayCommand({ dir, exists: nothing, bunPath: () => undefined, read: () => ({}) }),
		undefined,
		"nothing at all: no command to run",
	);
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

// ---------------------------------------------------------------------------
// Quota ledger, keyed by egress IP (S5, S10, S12)
// ---------------------------------------------------------------------------
// The ledger is the file that remembers which egress IP the gate refused and
// until when. Its pure core ships now and is pinned here; the live "prefer this
// exit" path waits for the proxy's structured `GET /exits`, because a preference
// nothing honours is worse than none (S11).

import {
	chooseWarpExit,
	isEgressParked,
	LOCAL_EGRESS_KEY,
	loadQuotaLedgerAtStartup,
	nearestQuotaReset,
	parkQuotaEgress,
	parseQuotaLedger,
	pruneQuotaLedger,
	proxyUrlWithExit,
	quotaEgressKey,
	warpBuildFact,
	quotaLedgerHealth,
	quotaLedgerPath,
	quotaPrefix64,
	readQuotaLedger,
	serializeQuotaLedger,
	warpExitsCapability,
	writeQuotaLedger,
} from "../relay.mjs";

const V4_A = "203.0.113.7";
const V4_B = "198.51.100.9";
const V6_A = "2001:db8:1:2::1";
const LEDGER_NOW = 1_700_000_000_000;

/** A throwaway ledger file, removed when the case ends. No case here writes to
 *  the real home directory. */
async function withQuotaDir(run) {
	const dir = mkdtempSync(join(tmpdir(), "pfb-quota-"));
	try {
		return await run(join(dir, "quota.json"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("quotaEgressKey: one address, one key", () => {
	assert.equal(quotaEgressKey(" 203.0.113.7 "), V4_A, "a padded literal keys the address");
	assert.equal(quotaEgressKey("2001:DB8::1"), "2001:db8::1", "case is not part of an address");
	assert.equal(quotaEgressKey(`[${V6_A}]`), "2001:db8:1:2::1", "brackets are spelled around an address, not in it");
	assert.equal(
		quotaEgressKey("2001:0db8:0001:0002:0000:0000:0000:0001"),
		V6_A,
		"a zero-padded spelling is the same egress",
	);
});

test("quotaEgressKey: anything that is not an address has no key", () => {
	const rejected = [
		undefined,
		null,
		"",
		"   ",
		"local",
		"not-an-ip",
		"999.1.1.1",
		"1.2.3",
		":::",
		"1:2:3:4:5:6:7:8:9",
		"warp-18e4af",
	];
	for (const value of rejected) {
		assert.equal(quotaEgressKey(value), undefined, `key for ${JSON.stringify(value)}`);
	}
});

test("quotaPrefix64: the /64 is derived from the address, never asked of the proxy (S5)", () => {
	assert.equal(quotaPrefix64(V6_A), "2001:0db8:0001:0002::/64");
	assert.equal(quotaPrefix64("2001:DB8::1"), "2001:0db8:0000:0000::/64", "the padded form is the normalised one");
	assert.equal(quotaPrefix64(` ${V4_A} `), V4_A, "IPv4 is its own prefix, unchanged");
	assert.equal(quotaPrefix64("not-an-ip"), undefined);
	assert.equal(quotaPrefix64(LOCAL_EGRESS_KEY), undefined, "the local egress has no address to derive from");
});

test("parseQuotaLedger: a readable file gives back its entries", () => {
	const text = JSON.stringify({
		version: 1,
		egresses: { [V4_A]: { prefix64: V4_A, exit_id: "warp-2", parked_until: LEDGER_NOW, hits: 3 } },
	});
	const ledger = parseQuotaLedger(text);
	assert.equal(ledger.version, 1);
	assert.equal(ledger.egresses[V4_A].exit_id, "warp-2");
	assert.equal(ledger.egresses[V4_A].hits, 3);
});

test("parseQuotaLedger: every way a file can be wrong reads as empty (S5)", () => {
	const wrong = [
		"",
		"{not json",
		"[]",
		"null",
		'"text"',
		JSON.stringify({ version: 2, egresses: {} }),
		JSON.stringify({ egresses: {} }),
		JSON.stringify({ version: 1, egresses: [] }),
		JSON.stringify({ version: 1 }),
	];
	for (const text of wrong) {
		assert.deepEqual(parseQuotaLedger(text), { version: 1, egresses: {} }, `ledger from ${text}`);
	}
	assert.deepEqual(parseQuotaLedger(undefined), { version: 1, egresses: {} }, "no text is not a throw");
});

test("parseQuotaLedger: an entry without a numeric reset is dropped, not guessed", () => {
	const text = JSON.stringify({
		version: 1,
		egresses: { [V4_A]: { prefix64: V4_A }, [V4_B]: { prefix64: V4_B, parked_until: "soon" } },
	});
	assert.deepEqual(parseQuotaLedger(text).egresses, {}, "a park nobody can compare to a clock is not a park");
});

test("serializeQuotaLedger: the same ledger writes the same bytes", () => {
	const ledger = parseQuotaLedger(
		JSON.stringify({
			version: 1,
			egresses: {
				[V4_B]: { prefix64: V4_B, parked_until: LEDGER_NOW + 2_000 },
				[V4_A]: { prefix64: V4_A, parked_until: LEDGER_NOW + 1_000 },
			},
		}),
	);
	const text = serializeQuotaLedger(ledger);
	assert.equal(text, serializeQuotaLedger(parseQuotaLedger(text)), "a round trip is byte-identical");
	assert.ok(text.indexOf(V4_B) < text.indexOf(V4_A), "keys are sorted, so a rewrite is reviewable");
});

test("parkQuotaEgress: one entry per IP, keyed by the address the gate refused (S5)", () => {
	const ledger = parkQuotaEgress(parseQuotaLedger(""), {
		ip: V4_A,
		exitId: "warp-2",
		parkedUntil: LEDGER_NOW + 60_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	assert.deepEqual(ledger.egresses[V4_A], {
		prefix64: V4_A,
		exit_id: "warp-2",
		parked_until: LEDGER_NOW + 60_000,
		observed_at: LEDGER_NOW,
		reason: "gate_429",
		hits: 1,
	});
	assert.equal(ledger.egresses[V4_A].prefix64, V4_A, "the IPv4 entry carries its own literal as its prefix");
});

test("parkQuotaEgress: two spellings of one IPv6 address are one entry, not two (S5)", () => {
	// The tunnel is IPv6-only, so the same egress arrives spelled however the
	// trace felt like spelling it. One burnt address must stay one park, or the
	// next request finds the burnt one under a name it does not recognise.
	const first = parkQuotaEgress(parseQuotaLedger(""), {
		ip: "2a09:bac5:1:2::1",
		exitId: "warp-2",
		parkedUntil: LEDGER_NOW + 60_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	const second = parkQuotaEgress(first, {
		ip: "2A09:BAC5:1:2:0:0:0:1",
		exitId: "warp-3",
		parkedUntil: LEDGER_NOW + 120_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	assert.deepEqual(Object.keys(second.egresses), ["2a09:bac5:1:2::1"], "one burnt address, one entry");
	assert.equal(second.egresses["2a09:bac5:1:2::1"].hits, 2, "the second sighting is the same park seen again");
	assert.equal(second.egresses["2a09:bac5:1:2::1"].parked_until, LEDGER_NOW + 120_000, "the later reset wins");
	assert.equal(second.egresses["2a09:bac5:1:2::1"].exit_id, "warp-3", "the entry follows the exit it last saw");
	assert.equal(second.egresses["2a09:bac5:1:2::1"].prefix64, "2a09:bac5:0001:0002::/64", "the shared /64 rides along");
});

test("parkQuotaEgress: re-parking the same IP increments hits and moves the reset", () => {
	const first = parkQuotaEgress(parseQuotaLedger(""), {
		ip: V6_A,
		exitId: "warp-2",
		parkedUntil: LEDGER_NOW + 1_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	const second = parkQuotaEgress(first, {
		ip: V6_A,
		exitId: "warp-7",
		parkedUntil: LEDGER_NOW + 90_000,
		reason: "gate_429",
		now: LEDGER_NOW + 500,
	});
	const entry = second.egresses["2001:db8:1:2::1"];
	assert.equal(entry.hits, 2, "the second park is history on the same entry");
	assert.equal(entry.parked_until, LEDGER_NOW + 90_000);
	assert.equal(entry.exit_id, "warp-7", "the exit that burnt it last is the one reported");
	assert.equal(entry.prefix64, "2001:0db8:0001:0002::/64");
	assert.equal(first.egresses["2001:db8:1:2::1"].hits, 1, "the previous ledger is untouched");
});

test("parkQuotaEgress: two IPs are two entries", () => {
	const ledger = parkQuotaEgress(
		parkQuotaEgress(parseQuotaLedger(""), { ip: V4_A, parkedUntil: LEDGER_NOW + 1_000, reason: "gate_429", now: LEDGER_NOW }),
		{ ip: V4_B, parkedUntil: LEDGER_NOW + 2_000, reason: "gate_429", now: LEDGER_NOW },
	);
	assert.deepEqual(Object.keys(ledger.egresses).sort(), [V4_B, V4_A].sort());
});

test("parkQuotaEgress: the local egress is remembered under its own key (S10)", () => {
	const ledger = parkQuotaEgress(parseQuotaLedger(""), {
		ip: LOCAL_EGRESS_KEY,
		parkedUntil: LEDGER_NOW + 3_600_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	assert.deepEqual(Object.keys(ledger.egresses), [LOCAL_EGRESS_KEY]);
	const entry = ledger.egresses[LOCAL_EGRESS_KEY];
	assert.equal(entry.reason, "gate_429");
	assert.equal(entry.prefix64, undefined, "the local egress has no /64 to report");
	assert.equal(entry.exit_id, undefined, "and no warp exit to name");
});

test("parkQuotaEgress: nothing is remembered for an egress it cannot key", () => {
	const before = parseQuotaLedger("");
	const after = parkQuotaEgress(before, {
		ip: "not-an-ip",
		parkedUntil: LEDGER_NOW + 1_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	assert.deepEqual(after.egresses, {}, "a key nothing can match later is worse than no entry");
	assert.equal(
		parkQuotaEgress(before, { ip: V4_A, parkedUntil: undefined, reason: "gate_429" }).egresses[V4_A],
		undefined,
		"no reset, no park",
	);
});

test("pruneQuotaLedger: an expired park is dropped, a live one stays", () => {
	const ledger = parseQuotaLedger(
		JSON.stringify({
			version: 1,
			egresses: {
				[V4_A]: { prefix64: V4_A, parked_until: LEDGER_NOW + 1_000, hits: 1 },
				[V4_B]: { prefix64: V4_B, parked_until: LEDGER_NOW - 1_000, hits: 2 },
			},
		}),
	);
	const pruned = pruneQuotaLedger(ledger, LEDGER_NOW);
	assert.deepEqual(Object.keys(pruned.egresses), [V4_A]);
	assert.equal(pruned.egresses[V4_A].hits, 1, "pruning never rewrites what it keeps");
	assert.deepEqual(Object.keys(ledger.egresses).sort(), [V4_B, V4_A].sort(), "the input keeps every entry");
});

test("isEgressParked: the window, not the entry, is what parks an egress", () => {
	const ledger = parkQuotaEgress(parseQuotaLedger(""), {
		ip: V4_A,
		parkedUntil: LEDGER_NOW + 60_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	assert.equal(isEgressParked(ledger, V4_A, LEDGER_NOW + 59_999), true);
	assert.equal(isEgressParked(ledger, V4_A, LEDGER_NOW + 60_000), false, "the reset second frees the egress");
	assert.equal(isEgressParked(ledger, V4_B, LEDGER_NOW), false);
	assert.equal(isEgressParked(ledger, "not-an-ip", LEDGER_NOW), false, "an egress without a key is never parked");
	assert.equal(isEgressParked(parseQuotaLedger(""), V4_A, LEDGER_NOW), false);
});

test("nearestQuotaReset: the earliest live reset, or 0 when nothing is parked", () => {
	const ledger = parseQuotaLedger(
		JSON.stringify({
			version: 1,
			egresses: {
				[V4_A]: { parked_until: LEDGER_NOW + 90_000 },
				[V4_B]: { parked_until: LEDGER_NOW + 30_000 },
				[LOCAL_EGRESS_KEY]: { parked_until: LEDGER_NOW - 1 },
			},
		}),
	);
	assert.equal(nearestQuotaReset(ledger, LEDGER_NOW), LEDGER_NOW + 30_000, "past entries are not a reset");
	assert.equal(nearestQuotaReset(parseQuotaLedger(""), LEDGER_NOW), 0);
});

test("quotaLedgerHealth: the two numbers /health publishes (S12)", () => {
	const ledger = parseQuotaLedger(
		JSON.stringify({
			version: 1,
			egresses: {
				[V4_A]: { parked_until: LEDGER_NOW + 90_000 },
				[V4_B]: { parked_until: LEDGER_NOW + 30_000 },
				[LOCAL_EGRESS_KEY]: { parked_until: LEDGER_NOW - 1 },
			},
		}),
	);
	// D14: the same two numbers must survive the pool argument being absent.
	assert.deepEqual(quotaLedgerHealth(ledger, undefined, LEDGER_NOW), {
		parked: 2,
		parkedLive: null,
		nearestResetInMs: 30_000,
	});
	assert.deepEqual(quotaLedgerHealth(parseQuotaLedger(""), undefined, LEDGER_NOW), {
		parked: 0,
		parkedLive: null,
		nearestResetInMs: 0,
	});
});

// D14: a park is a guard, not a tombstone — a burnt address still protects a
// live exit if the address came back. So nothing is pruned; the health line only
// says how many of the guards can fire against the pool as it stands right now.
const D14_LEDGER = parseQuotaLedger(
	JSON.stringify({
		version: 1,
		egresses: {
			[V4_A]: { parked_until: LEDGER_NOW + 90_000, exit_id: "warp-a" },
			[V4_B]: { parked_until: LEDGER_NOW + 30_000, exit_id: "warp-gone" },
			[LOCAL_EGRESS_KEY]: { parked_until: LEDGER_NOW + 60_000 },
		},
	}),
);

test("quotaLedgerHealth: parkedLive counts the guards whose exit is still in the pool (D14)", () => {
	const health = quotaLedgerHealth(D14_LEDGER, [{ id: "warp-a" }, { id: "warp-b" }], LEDGER_NOW);
	assert.equal(health.parked, 3);
	assert.equal(health.parkedLive, 1, "two of the three guards name an exit that is not in the pool");
});

test("quotaLedgerHealth: a pool that did not answer says null, never zero (D14)", () => {
	assert.equal(quotaLedgerHealth(D14_LEDGER, undefined, LEDGER_NOW).parkedLive, null);
});

test("quotaLedgerHealth: a pool that answered with no exits says zero, which is not null (D14)", () => {
	const parkedBefore = JSON.stringify(D14_LEDGER);
	assert.equal(quotaLedgerHealth(D14_LEDGER, [], LEDGER_NOW).parkedLive, 0);
	assert.equal(JSON.stringify(D14_LEDGER), parkedBefore, "reading health must not mutate the ledger");
});

test("proxyUrlWithExit: the exit id rides as the credential, empty password (S3, L5)", () => {
	assert.equal(
		proxyUrlWithExit("http://127.0.0.1:8789", "warp-2"),
		"http://warp-2:@127.0.0.1:8789",
		"the username is the exit id and the password is empty",
	);
});

test("proxyUrlWithExit: protocol, host, port and path all survive", () => {
	assert.equal(
		proxyUrlWithExit("https://proxy.example.test:8899/tunnel", "warp_5"),
		"https://warp_5:@proxy.example.test:8899/tunnel",
	);
	assert.equal(
		proxyUrlWithExit("http://old-exit:s3cret@127.0.0.1:8789", "warp-2"),
		"http://warp-2:@127.0.0.1:8789",
		"the exit id replaces whatever userinfo the URL carried",
	);
});

test("proxyUrlWithExit: an id the proxy cannot parse never reaches it", () => {
	for (const id of [undefined, null, "", "   ", "warp 2", "warp/2", "warp-2:s3cret", "warp@2", "warp-2\n"]) {
		assert.equal(
			proxyUrlWithExit("http://127.0.0.1:8789", id),
			"http://127.0.0.1:8789",
			`exit id ${JSON.stringify(id)}`,
		);
	}
});

test("proxyUrlWithExit: a URL it cannot read comes back unchanged instead of throwing", () => {
	assert.equal(proxyUrlWithExit("", "warp-2"), "");
	assert.equal(proxyUrlWithExit("127.0.0.1:8789", "warp-2"), "127.0.0.1:8789");
	assert.equal(proxyUrlWithExit(undefined, "warp-2"), undefined);
});

test("chooseWarpExit: the first clean exit wins, because rotating is the last resort (S9)", () => {
	const ledger = parkQuotaEgress(parseQuotaLedger(""), {
		ip: V4_A,
		parkedUntil: LEDGER_NOW + 60_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	const entries = [
		{ id: "warp-2", ip: V4_A },
		{ id: "warp-7", ip: V4_B },
	];
	assert.equal(chooseWarpExit(entries, ledger, LEDGER_NOW), "warp-7", "a parked exit is skipped, not rotated");
	assert.equal(
		chooseWarpExit(entries, ledger, LEDGER_NOW + 60_000),
		"warp-2",
		"once the park expires the first exit is usable again",
	);
});

test("chooseWarpExit: no clean exit is an answer of its own", () => {
	const ledger = parkQuotaEgress(parseQuotaLedger(""), {
		ip: V4_A,
		parkedUntil: LEDGER_NOW + 60_000,
		reason: "gate_429",
		now: LEDGER_NOW,
	});
	assert.equal(chooseWarpExit([{ id: "warp-2", ip: V4_A }], ledger, LEDGER_NOW), undefined);
	assert.equal(chooseWarpExit([], ledger, LEDGER_NOW), undefined);
	assert.equal(chooseWarpExit(undefined, ledger, LEDGER_NOW), undefined);
	assert.equal(
		chooseWarpExit([{ id: "warp-2" }, { id: "warp-7" }], ledger, LEDGER_NOW),
		undefined,
		"an exit with no address cannot be proven clean",
	);
	assert.equal(
		chooseWarpExit([{ id: "warp-2", ip: "not-an-ip" }], ledger, LEDGER_NOW),
		undefined,
		"and neither can one whose address the ledger cannot key",
	);
});

test("quotaLedgerPath: RELAY_QUOTA_PATH wins, otherwise the agent directory (S10)", () => {
	const fallback = join(homedir(), ".pi", "agent", "pi-free-bridge-quota.json");
	assert.equal(quotaLedgerPath({ RELAY_QUOTA_PATH: "/tmp/x/quota.json" }), "/tmp/x/quota.json");
	assert.equal(quotaLedgerPath({}), fallback);
	assert.equal(quotaLedgerPath({ RELAY_QUOTA_PATH: "   " }), fallback, "an empty override is not a path");
});

test("loadQuotaLedgerAtStartup: a restart keeps the local park (S10)", async () => {
	await withQuotaDir(async (file) => {
		const parkedUntil = Date.now() + 3_600_000;
		writeFileSync(
			file,
			serializeQuotaLedger(
				parkQuotaEgress(parseQuotaLedger(""), {
					ip: LOCAL_EGRESS_KEY,
					parkedUntil,
					reason: "gate_429",
					now: Date.now(),
				}),
			),
		);
		try {
			resetWarpStateForTests();
			const ledger = loadQuotaLedgerAtStartup(file);
			assert.equal(ledger.egresses[LOCAL_EGRESS_KEY].reason, "gate_429");
			assert.equal(
				warpStateForTests().localParkedUntil,
				parkedUntil,
				"without this the first request after a restart spends itself on a known 429",
			);
		} finally {
			resetWarpStateForTests();
		}
	});
});

test("loadQuotaLedgerAtStartup: an expired park does not survive the restart", async () => {
	await withQuotaDir(async (file) => {
		writeFileSync(
			file,
			serializeQuotaLedger(
				parkQuotaEgress(parseQuotaLedger(""), {
					ip: LOCAL_EGRESS_KEY,
					parkedUntil: Date.now() - 1_000,
					reason: "gate_429",
					now: Date.now() - 2_000,
				}),
			),
		);
		try {
			resetWarpStateForTests();
			loadQuotaLedgerAtStartup(file);
			assert.equal(warpStateForTests().localParkedUntil, 0, "the window is over, so the egress is free");
		} finally {
			resetWarpStateForTests();
		}
	});
});

test("loadQuotaLedgerAtStartup: a malformed or missing file degrades to empty (S10)", async () => {
	await withQuotaDir(async (file) => {
		const cases = ["{not json", "[]", "null", JSON.stringify({ version: 99, egresses: {} })];
		for (const text of cases) {
			writeFileSync(file, text);
			try {
				resetWarpStateForTests();
				assert.deepEqual(loadQuotaLedgerAtStartup(file), { version: 1, egresses: {} }, `ledger from ${text}`);
				assert.equal(warpStateForTests().localParkedUntil, 0);
			} finally {
				resetWarpStateForTests();
			}
		}
		try {
			resetWarpStateForTests();
			assert.deepEqual(
				loadQuotaLedgerAtStartup(join(file, "..", "pfb-quota-absent", "quota.json")),
				{ version: 1, egresses: {} },
				"a missing file is the normal first run",
			);
		} finally {
			resetWarpStateForTests();
		}
	});
});

test("forward: a local 429 writes the ledger, and a restart re-parks it (S10)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(GATE_429_BODY, { status: 429, headers: { "retry-after": "3600" } });
		try {
			resetWarpStateForTests(); // also clears the resolved ledger path
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "local-429" }), res, RESEND_PATH, {
				...FORWARD_CONFIG,
				warpMode: "off",
			});

			assert.equal(res.status, 429, "the gate 429 is still delivered byte-exact");
			const ledger = parseQuotaLedger(readFileSync(file, "utf8"));
			const entry = ledger.egresses[LOCAL_EGRESS_KEY];
			assert.equal(entry.reason, "gate_429");
			assert.equal(entry.hits, 1);
			assert.ok(entry.parked_until > Date.now(), "the reset is in the future");
			assert.equal(existsSync(`${file}.tmp`), false, "the temp file never survives the rename");

			resetWarpStateForTests();
			loadQuotaLedgerAtStartup(file);
			assert.ok(
				warpStateForTests().localParkedUntil > Date.now(),
				"the park that reached the disk is the one a restart adopts",
			);
		} finally {
			globalThis.fetch = originalFetch;
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("writeQuotaLedger: a write that cannot land logs one line and never throws (S10)", async () => {
	await withQuotaDir(async (file) => {
		// The parent of the ledger path is a FILE, so nothing can be created under
		// it: a read-only home or a full disk looks exactly like this.
		writeFileSync(file, "not a directory");
		const ledger = parkQuotaEgress(parseQuotaLedger(""), {
			ip: V4_A,
			parkedUntil: Date.now() + 60_000,
			reason: "gate_429",
		});
		const lines = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
		try {
			const written = writeQuotaLedger(ledger, join(file, "quota.json"));
			assert.equal(written.egresses[V4_A].reason, "gate_429", "the park survives in memory");
		} finally {
			process.stderr.write = originalWrite;
		}
		assert.equal(
			lines.filter((line) => line.includes("quota ledger")).length,
			1,
			`exactly one line, got ${JSON.stringify(lines)}`,
		);
	});
});

test("readQuotaLedger: a file that is gone reads as empty instead of throwing", async () => {
	await withQuotaDir(async (file) => {
		assert.deepEqual(readQuotaLedger(join(file, "absent.json")), { version: 1, egresses: {} });
	});
});

// ---------------------------------------------------------------------------
// Proxy capability detection (S11)
// ---------------------------------------------------------------------------
// The relay hides its choice in the proxy credential, which only means something
// to a proxy that can read it. An older binary has no `GET /exits` and no exit to
// prefer, so the relay must not claim it routes (S11) — and must not send a
// credential it cannot honour.

const CAPABILITY_CONFIG = { warpProxy: "http://127.0.0.1:8789" };

// S11: the capability is DECLARED by the proxy in `/health`, never probed. On a
// binary without the `/exits` route a probe reaches the catch-all, and the
// catch-all defect (D7) charges that request to an exit: 30 minutes out of
// rotation for one diagnostic read. These tests pin the URL, not just the verdict.
test("warpExitsCapability: a /health that declares the route is the structured contract (S11)", async () => {
	const seen = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts = {}) => {
		seen.push({ url: String(url), opts });
		return healthJson({ ok: true, capabilities: { exits: true }, exits: [] });
	};
	try {
		resetWarpStateForTests();
		assert.equal(await warpExitsCapability(CAPABILITY_CONFIG, 0), "structured");
		assert.equal(seen[0].url, "http://127.0.0.1:8789/health", "the declared capability travels on /health");
		assert.equal(seen[0].opts.headers, undefined, "capability detection sends no credential");
		assert.ok(seen[0].opts.method === undefined || seen[0].opts.method === "GET", "a plain GET");
	} finally {
		globalThis.fetch = originalFetch;
		resetWarpStateForTests();
	}
});

test("warpExitsCapability: a /health without the declaration is legacy and /exits is never asked (S11, D9)", async () => {
	const seen = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		seen.push(String(url));
		// A pre-capability binary: a real /health report, no declared route.
		return healthJson({ ok: true, service: "warp-minimal", stack: "masque", exits: [] });
	};
	try {
		resetWarpStateForTests();
		assert.equal(await warpExitsCapability(CAPABILITY_CONFIG, 0), "legacy");
		assert.equal(seen.length, 1, "one question, and only to /health");
		assert.deepEqual(
			seen.filter((url) => url.endsWith("/exits")),
			[],
			"probing /exits on an old binary takes an exit out of rotation for 30 minutes",
		);
	} finally {
		globalThis.fetch = originalFetch;
		resetWarpStateForTests();
	}
});

test("warpExitsCapability: an unreachable or non-200 /health is unknown, never legacy (S11)", async () => {
	const answers = [
		() => {
			throw new Error("ECONNREFUSED");
		},
		() => new Response("", { status: 500 }),
		() => new Response("", { status: 404 }),
	];
	const originalFetch = globalThis.fetch;
	try {
		for (const answer of answers) {
			globalThis.fetch = async () => answer();
			resetWarpStateForTests();
			assert.equal(await warpExitsCapability(CAPABILITY_CONFIG, 0), "unknown");
		}
	} finally {
		globalThis.fetch = originalFetch;
		resetWarpStateForTests();
	}
});

test("warpExitsCapability: the answer is cached for a minute (S11)", async () => {
	let calls = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		calls += 1;
		return healthJson({ ok: true, exits: [] });
	};
	try {
		resetWarpStateForTests();
		assert.equal(await warpExitsCapability(CAPABILITY_CONFIG, 0), "legacy");
		assert.equal(await warpExitsCapability(CAPABILITY_CONFIG, 59_999), "legacy");
		assert.equal(calls, 1, "one probe inside the window");
		assert.equal(await warpExitsCapability(CAPABILITY_CONFIG, 60_000), "legacy");
		assert.equal(calls, 2, "the window is a minute, then the probe runs again");
		assert.equal(
			await warpExitsCapability({ warpProxy: "http://127.0.0.1:9999" }, 60_001),
			"legacy",
			"a different proxy is a different answer",
		);
		assert.equal(calls, 3);
	} finally {
		globalThis.fetch = originalFetch;
		resetWarpStateForTests();
	}
});

// ---------------------------------------------------------------------------
// /health reports the ledger, and no routing it cannot honour (S12)
// ---------------------------------------------------------------------------

test("/health reports the ledger and keeps preferredRouting false (S12)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const now = Date.now();
		writeFileSync(
			file,
			serializeQuotaLedger(
				parkQuotaEgress(
					parkQuotaEgress(parseQuotaLedger(""), {
						ip: V4_A,
						parkedUntil: now + 60_000,
						reason: "gate_429",
						now,
					}),
					{ ip: V4_B, parkedUntil: now + 120_000, reason: "gate_429", now },
				),
			),
		);
		const originalFetch = globalThis.fetch;
		// S11: a real /health report is an object that DECLARES the structured
		// route. A bare array is a body no binary sends, and reads as legacy.
		globalThis.fetch = async () => healthJson({ ok: true, capabilities: { exits: true }, exits: [] });
		try {
			resetWarpStateForTests();
			loadQuotaLedgerAtStartup(file);
			const res = fakeRelayRes();
			await handle({ method: "GET", url: "/health", headers: {}, on() {} }, res, {
				...FORWARD_CONFIG,
				warpMode: "off",
			});
			const body = JSON.parse(res.body());

			assert.deepEqual(Object.keys(body.quotaLedger).sort(), [
				"nearestResetInMs",
				"parked",
				"parkedLive",
				"path",
			]);
			assert.equal(body.quotaLedger.parked, 2);
			// D14: with warp off there is no pool to ask, so the guard count is
			// null — an unanswered pool is not an empty one.
			assert.equal(body.quotaLedger.parkedLive, null);
			assert.ok(
				body.quotaLedger.nearestResetInMs > 0 && body.quotaLedger.nearestResetInMs <= 60_000,
				`nearest reset ${body.quotaLedger.nearestResetInMs}ms`,
			);
			assert.equal(body.quotaLedger.path, file);
			assert.equal(body.warpExits, "structured");
			assert.equal(body.preferredRouting, false, "nothing is preferred until the prefer path is wired");
			assert.equal(body.service, "pi-free-bridge-relay", "nothing existing is renamed or removed");
			assert.equal(body.ok, true);
		} finally {
			globalThis.fetch = originalFetch;
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});
// ---------------------------------------------------------------------------
// Per-request routing: one exit per attempt, named by the proxy credential
// (S2, S3, S4, S7, S9)
// ---------------------------------------------------------------------------
// The relay hides its choice in the proxy credential (L5: a custom header never
// reaches the proxy, URL userinfo does), so the whole feature is observable in
// one place — the `proxy` the upstream request was built with. Every case below
// drives the real `forward()` with a fake network; nothing touches a port.
//
// `state` is eligibility and `observed_at` is liveness: the proxy derives the
// state from `stateLocked()` and runs no health check, so a silently dead tunnel
// still says `healthy` and only stops renewing its trace.

import {
	countWarpExitAddresses,
	isWarpExitChoosable,
	parseWarpExits,
	preferredWarpExit,
	readWarpExitsDetail,
	WARP_EXIT_STALE_MS,
	warpExitObservedAtMs,
} from "../relay.mjs";

const POOL_PROXY = WARP_CONFIG.warpProxy;
// Two real egresses on purpose: they sit in DIFFERENT /64s, so nothing here can
// lean on a shared prefix.
const EGRESS_A = "2a09:bac5:3057:aa::11:1eb";
const EGRESS_B = "2a09:bac1:2040:10::4";
/** The measured `/exits` shape: flat objects, epoch SECONDS, no `prefix64`. */
const POOL_A = { id: "warp-a", state: "healthy", served: 0, streams: 0, ip: EGRESS_A, family: "v6" };
const POOL_B = { id: "warp-b", state: "healthy", served: 0, streams: 0, ip: EGRESS_B, family: "v6" };
const EMPTY_LEDGER = parseQuotaLedger("");

/** `observed_at` is epoch seconds, so a fresh entry is derived from our clock. */
const freshExit = (exit, ageSeconds = 0) => ({
	...exit,
	observed_at: Math.floor(Date.now() / 1000) - ageSeconds,
});
/** The `/health` string form the relay has always parsed (S14). */
const healthOf = (...pairs) => ({
	exits: pairs.map(([id, state]) => `${id} (${state}, served=0, streams=0)`),
});

/** A fake proxy publishing `/exits`, `/health`, `/recycle` and the upstream. */
function fakePoolProxy({ detail, health, upstream } = {}) {
	// S11: a real binary either has the structured route and says so in `/health`,
	// or has neither. The fake mirrors that: `detail` present means a proxy that
	// declares the capability, `detail: undefined` means an older build that never
	// mentions it — and must never be asked for `/exits`.
	const healthBody = () => ({
		...(health ?? {}),
		...(detail === undefined ? {} : { capabilities: { exits: true } }),
	});
	return installFakeFetch((call) => {
		if (call.url === `${POOL_PROXY}/exits`) {
			return detail === undefined ? new Response("", { status: 404 }) : healthJson(detail);
		}
		if (call.url === `${POOL_PROXY}/health`) return healthJson(healthBody());
		if (call.url === `${POOL_PROXY}/recycle`) {
			return new Response(JSON.stringify({ ok: false }), { status: 202 });
		}
		if (upstream) return upstream(call);
		return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
	});
}

const upstreamCall = (fake) =>
	fake.calls.filter((call) => call.url.startsWith(WARP_CONFIG.upstream)).at(-1);

test("parseWarpExits: the flat array is the contract, everything else is undefined (S11, S13)", () => {
	assert.deepEqual(parseWarpExits([POOL_A]), [
		{ id: "warp-a", state: "healthy", ip: EGRESS_A, observed_at: undefined },
	]);
	assert.equal(parseWarpExits(undefined), undefined, "no body is no evidence");
	assert.equal(parseWarpExits({ ok: true }), undefined, "a JSON object is not the array");
	assert.equal(parseWarpExits("[]"), undefined, "unparseable text never becomes an empty pool");
	assert.deepEqual(
		parseWarpExits([{ state: "healthy" }, null, "x", { id: "   " }]),
		[],
		"an entry without an id is not an exit",
	);
	// The proxy omits `ip`/`family`/`observed_at` when the trace never worked.
	assert.deepEqual(parseWarpExits([{ id: "warp-a", state: "healthy" }]), [
		{ id: "warp-a", state: "healthy", ip: undefined, observed_at: undefined },
	]);
});

test("readWarpExitsDetail: one GET per five seconds, every bad answer is no evidence (S11)", async () => {
	const fake = fakePoolProxy({ detail: [freshExit(POOL_A), freshExit(POOL_B)] });
	try {
		resetWarpStateForTests();
		assert.equal((await readWarpExitsDetail(WARP_CONFIG, 0)).length, 2);
		assert.equal(fake.calls[0].url, `${POOL_PROXY}/exits`);
		assert.equal(fake.calls[0].method, "GET");
		await readWarpExitsDetail(WARP_CONFIG, 4_999);
		assert.equal(fake.calls.length, 1, "a request never pays the hop twice inside the window");
		await readWarpExitsDetail(WARP_CONFIG, 5_000);
		assert.equal(fake.calls.length, 2, "and the window is five seconds");
	} finally {
		fake.restore();
		resetWarpStateForTests();
	}

	const bad = [
		["a 404", () => new Response("", { status: 404 })],
		["a 500", () => new Response("", { status: 500 })],
		["a non-JSON 200", () => new Response("<html>nope</html>", { status: 200 })],
		["a JSON object", () => healthJson({ ok: true })],
		["a refused connection", () => {
			throw new Error("ECONNREFUSED");
		}],
	];
	for (const [name, answer] of bad) {
		const broken = installFakeFetch(answer);
		try {
			resetWarpStateForTests();
			assert.equal(await readWarpExitsDetail(WARP_CONFIG, 0), undefined, name);
		} finally {
			broken.restore();
			resetWarpStateForTests();
		}
	}
});

test("warpExitObservedAtMs: seconds become milliseconds, and 0 is absent (S9)", () => {
	assert.equal(warpExitObservedAtMs(1_794_636_453), 1_794_636_453_000, "the proxy's unit is seconds");
	assert.equal(warpExitObservedAtMs(0), undefined, "0 means 'never observed', not 1970");
	assert.equal(warpExitObservedAtMs(undefined), undefined);
	assert.equal(warpExitObservedAtMs("1794636453"), undefined, "a string is not a timestamp");
});

test("isWarpExitChoosable: a fresh second-granularity stamp is fresh, not ancient (S9)", () => {
	// The failure this pins: comparing epoch SECONDS against a Date.now()
	// MILLISECOND clock makes every real exit look ~50 years old, so the relay
	// would never prefer anything again. Drop the `* 1000` and this goes red.
	const now = Math.floor(Date.now() / 1000) * 1000;
	assert.equal(isWarpExitChoosable(freshExit(POOL_A), now), true);
	assert.equal(isWarpExitChoosable({ ...POOL_A, observed_at: 0 }, now), false, "0 is absent, never 'expired by miles'");
	assert.equal(isWarpExitChoosable({ ...POOL_A, observed_at: undefined }, now), false, "no stamp, no vouch");
});

test("isWarpExitChoosable: state is eligibility, observed_at is liveness (S9)", () => {
	// Aligned to the second: `observed_at` has second granularity, so a boundary
	// case is only exact on a whole second.
	const now = Math.floor(Date.now() / 1000) * 1000;
	assert.equal(isWarpExitChoosable(freshExit(POOL_A), now), true);
	assert.equal(isWarpExitChoosable(freshExit({ ...POOL_A, state: "in_use" }), now), true);
	for (const state of ["draining", "cooldown", "starting", undefined]) {
		assert.equal(isWarpExitChoosable(freshExit({ ...POOL_A, state }), now), false, `state ${String(state)}`);
	}
	assert.equal(isWarpExitChoosable(freshExit({ ...POOL_A, ip: undefined }), now), false, "no egress address, no key");
	assert.equal(isWarpExitChoosable(freshExit({ ...POOL_A, ip: "not-an-ip" }), now), false);

	assert.equal(WARP_EXIT_STALE_MS, 120_000, "two minutes: the proxy caches the trace 45s, not two hours");
	assert.equal(
		isWarpExitChoosable(freshExit(POOL_A, WARP_EXIT_STALE_MS / 1000), now),
		true,
		"the two-minute boundary is still vouchable",
	);
	assert.equal(
		isWarpExitChoosable(freshExit(POOL_A, WARP_EXIT_STALE_MS / 1000 + 1), now),
		false,
		"past it the address is not vouched for, however healthy the state is",
	);
	assert.equal(isWarpExitChoosable(undefined, now), false);
});

test("countWarpExitAddresses: a stale address still counts as an existing exit (S9, S12)", () => {
	assert.equal(countWarpExitAddresses([freshExit(POOL_A), freshExit(POOL_B, 600)]), 2);
	assert.equal(countWarpExitAddresses([freshExit(POOL_A), { id: "warp-x", state: "healthy" }]), 1);
	assert.equal(countWarpExitAddresses([{ id: "warp-x", state: "healthy", ip: "nope" }]), 0);
	assert.equal(countWarpExitAddresses(undefined), 0);
});

test("preferredWarpExit: the freshest address wins, because healthy is not alive (S9)", () => {
	const now = Date.now();
	// (a) Both eligible; the fresher stamp wins even when it is listed last.
	const fresh = freshExit(POOL_B, 5);
	const older = freshExit(POOL_A, 100);
	assert.equal(preferredWarpExit([older, fresh], EMPTY_LEDGER, now).id, "warp-b");
	assert.equal(preferredWarpExit([fresh, older], EMPTY_LEDGER, now).id, "warp-b");

	// (a) A dead tunnel keeps `healthy` and stops renewing its trace, so an
	// address past the window is not preferred at all.
	assert.equal(preferredWarpExit([freshExit(POOL_A, 300), fresh], EMPTY_LEDGER, now).id, "warp-b");

	// (b) A park is the stronger evidence: the parked fresh exit hands the
	// attempt to the older one instead of overriding the park.
	const parkedLedger = parkQuotaEgress(EMPTY_LEDGER, {
		ip: EGRESS_B,
		parkedUntil: now + 60_000,
		reason: "gate_429",
		now,
	});
	assert.equal(preferredWarpExit([older, fresh], parkedLedger, now).id, "warp-a");

	// (b) And nothing else clean means nothing is preferred, never a burnt exit.
	assert.equal(preferredWarpExit([fresh], parkedLedger, now), undefined);

	// (c) Every address aged out: no preference, which is today's behaviour.
	assert.equal(preferredWarpExit([freshExit(POOL_A, 300), freshExit(POOL_B, 300)], EMPTY_LEDGER, now), undefined);
	assert.equal(preferredWarpExit([], EMPTY_LEDGER, now), undefined);
	assert.equal(preferredWarpExit(undefined, EMPTY_LEDGER, now), undefined);
});

test("preferredWarpExit: a frozen observed_at is the death signal, not a missing ip (S17)", () => {
	// The proxy's cache does not expire on failure: after a trace worked once and
	// then failed, it keeps serving the LAST `ip` with its ORIGINAL `observed_at`,
	// forever. So the normal dead exit is `ip` present with a frozen stamp — the
	// one the relay already paid an enrollment for — and a missing `ip` only means
	// "never observed": newborn exit, trace never worked. Reading absence as death
	// would miss every tunnel that died after working, which is all of them.
	const now = Math.floor(Date.now() / 1000) * 1000;
	const frozen = freshExit(POOL_A, 300);
	assert.ok(frozen.ip, "the dead exit still publishes the last egress address it had");
	assert.equal(isWarpExitChoosable(frozen, now), false, "a healthy state does not survive a frozen trace");
	assert.equal(preferredWarpExit([frozen, freshExit(POOL_B, 10)], EMPTY_LEDGER, now).id, "warp-b");

	assert.equal(preferredWarpExit([freshExit(POOL_B, 10)], EMPTY_LEDGER, now).id, "warp-b");
	assert.equal(
		preferredWarpExit([frozen], EMPTY_LEDGER, now),
		undefined,
		"a frozen address alone prefers nothing",
	);

	// The rare case: no `ip` at all, which is "never observed", also unusable.
	const neverObserved = { id: "warp-c", state: "healthy", ip: undefined, observed_at: undefined };
	assert.equal(isWarpExitChoosable(neverObserved, now), false);
	assert.equal(preferredWarpExit([neverObserved], EMPTY_LEDGER, now), undefined);
});

test("forward: the chosen exit rides in the proxy URL as the credential (S2, S3, S9)", async () => {
	const fake = fakePoolProxy({
		detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
		health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
	});
	try {
		resetWarpStateForTests();
		const res = fakeRelayRes();
		await forward(fakeReq({ marker: "prefer" }), res, RESEND_PATH, FORWARD_CONFIG);

		assert.equal(res.status, 200);
		assert.equal(
			upstreamCall(fake).proxy,
			"http://warp-a:@127.0.0.1:8789",
			"the exit id is the username and the password is empty (L5)",
		);
		assert.equal(warpStateForTests().preferredExitId, "warp-a");
	} finally {
		fake.restore();
		resetWarpStateForTests();
	}
});

test("forward: with a legacy proxy the request is exactly the one sent before (S11)", async () => {
	const fake = fakePoolProxy({ detail: undefined, health: { exits: [] } });
	try {
		resetWarpStateForTests();
		const res = fakeRelayRes();
		await forward(fakeReq({ marker: "legacy" }), res, RESEND_PATH, FORWARD_CONFIG);

		assert.equal(res.status, 200);
		assert.equal(upstreamCall(fake).proxy, POOL_PROXY, "no credential, not even an empty one");
		assert.equal(String(upstreamCall(fake).proxy).includes("@"), false);
		assert.equal(warpStateForTests().preferredExitId, undefined, "nothing claims to be preferred");
		assert.equal(
			fake.calls.filter((call) => call.url === `${POOL_PROXY}/exits`).length,
			0,
			"an older proxy is never asked for /exits: that request costs it 30 minutes (D7, D9)",
		);
	} finally {
		fake.restore();
		resetWarpStateForTests();
	}
});

test("forward: a warp 429 on a named exit parks its egress IP (S4, S6)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		let upstreamStatus = 429;
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
			health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			upstream: () =>
				upstreamStatus === 429
					? new Response(GATE_429_BODY, { status: 429, headers: { "retry-after": "3600" } })
					: new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
		});
		try {
			resetWarpStateForTests();
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "park" }), res, RESEND_PATH, FORWARD_CONFIG);
			assert.equal(res.status, 429, "the gate 429 is still delivered byte-exact");

			const entry = readQuotaLedger(file).egresses[quotaEgressKey(EGRESS_A)];
			assert.ok(entry, `the serving address is parked: ${JSON.stringify(readQuotaLedger(file).egresses)}`);
			assert.equal(entry.reason, "gate_429");
			assert.equal(entry.exit_id, "warp-a");
			assert.equal(entry.prefix64, quotaPrefix64(EGRESS_A), "the /64 is derived from the egress address (S5)");
			assert.ok(entry.parked_until > Date.now() + 3_500_000, "retry-after 3600s plus the margin");

			// The park outweighs freshness: with one address parked and the other one
			// clean, the next attempt takes the other exit.
			const now = Date.now();
			const onlyA = parkQuotaEgress(parseQuotaLedger(""), {
				ip: EGRESS_A,
				parkedUntil: now + 3_600_000,
				reason: "gate_429",
				now,
			});
			writeFileSync(file, serializeQuotaLedger(onlyA));
			loadQuotaLedgerAtStartup(file);
			upstreamStatus = 200;
			await forward(fakeReq({ marker: "after-park" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(upstreamCall(fake).proxy, "http://warp-b:@127.0.0.1:8789");
			// Both addresses parked: a credential buys no attribution there (the address
			// is already in the ledger), so nothing is named and the request still goes
			// out unnamed instead of spending a parked request before round 1 (S27).
			writeFileSync(
				file,
				serializeQuotaLedger(
					parkQuotaEgress(onlyA, { ip: EGRESS_B, parkedUntil: now + 3_600_000, reason: "gate_429", now }),
				),
			);
			loadQuotaLedgerAtStartup(file);
			await forward(fakeReq({ marker: "burnt-pool" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			assert.equal(upstreamCall(fake).proxy, POOL_PROXY, "a fully parked pool is attempted unnamed, not preferred");
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("forward: a 429 the relay cannot blame on the exit parks nothing (S7)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A)],
			health: healthOf(["warp-a", "healthy"]),
			upstream: () => new Response(GATE_429_BODY, { status: 429, headers: { "retry-after": "3600" } }),
		});
		try {
			resetWarpStateForTests();
			await forward(fakeReq({ marker: "suspect" }), fakeRelayRes(), RESEND_PATH, {
				...FORWARD_CONFIG,
				sessionSource: "env",
			});
			assert.deepEqual(
				readQuotaLedger(file).egresses,
				{},
				"an id the relay cannot vouch for fails exactly like a spent quota",
			);
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("forward: only an attributable 429 with a parsed retry-after parks an IP (S4, S6)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const cases = [
			{ name: "no chosen exit (legacy proxy)", detail: undefined, headers: { "retry-after": "3600" } },
			{ name: "chosen exit but no retry-after", detail: [freshExit(POOL_A)], headers: {} },
			{
				name: "chosen exit but a retry-after that is not an integer",
				detail: [freshExit(POOL_A)],
				headers: { "retry-after": "1h" },
			},
		];
		for (const item of cases) {
			const fake = fakePoolProxy({
				detail: item.detail,
				health: healthOf(["warp-a", "healthy"]),
				upstream: () => new Response(GATE_429_BODY, { status: 429, headers: item.headers }),
			});
			try {
				resetWarpStateForTests();
				await forward(fakeReq({ marker: item.name }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
				assert.deepEqual(readQuotaLedger(file).egresses, {}, item.name);
			} finally {
				fake.restore();
				resetWarpStateForTests();
			}
		}
		delete process.env.RELAY_QUOTA_PATH;
	});
});

test("/health: preferredRouting is live only when an exit is choosable (S12)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const readHealth = async (detail, health) => {
			const fake = fakePoolProxy({ detail, health });
			try {
				const res = fakeRelayRes();
				await handle({ method: "GET", url: "/health", headers: {}, on() {} }, res, {
					...FORWARD_CONFIG,
					warpMode: "off",
				});
				return JSON.parse(res.body());
			} finally {
				fake.restore();
			}
		};
		try {
			// Capable and preferable, but nothing has been preferred yet.
			resetWarpStateForTests();
			let body = await readHealth(
				[freshExit(POOL_A), freshExit(POOL_B)],
				healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			);
			assert.equal(body.warpExits, "structured");
			assert.equal(body.preferredRouting, true);
			assert.equal(body.preferredExit, null);
			assert.deepEqual(body.warpExitsDetail, { usable: 2 });

			// Every address aged out: the exits still exist, nothing is routable.
			resetWarpStateForTests();
			body = await readHealth(
				[freshExit(POOL_A, 300), freshExit(POOL_B, 300)],
				healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			);
			assert.equal(body.preferredRouting, false, "a dead tunnel's stale address is not preferred");
			assert.deepEqual(body.warpExitsDetail, { usable: 2 }, "the exits still exist");

			// Every eligible exit parked: inert as well.
			resetWarpStateForTests();
			const now = Date.now();
			writeFileSync(
				file,
				serializeQuotaLedger(
					parkQuotaEgress(
						parkQuotaEgress(parseQuotaLedger(""), { ip: EGRESS_A, parkedUntil: now + 60_000, reason: "gate_429", now }),
						{ ip: EGRESS_B, parkedUntil: now + 120_000, reason: "gate_429", now },
					),
				),
			);
			loadQuotaLedgerAtStartup(file);
			body = await readHealth(
				[freshExit(POOL_A), freshExit(POOL_B)],
				healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			);
			assert.equal(body.preferredRouting, false, "a burnt pool routes nothing");
			assert.equal(body.quotaLedger.parked, 2);

			// An older binary is inert, and its `/exits` is never read for details.
			resetWarpStateForTests();
			body = await readHealth(undefined, { exits: [] });
			assert.equal(body.warpExits, "legacy");
			assert.equal(body.preferredRouting, false);
			assert.equal(body.preferredExit, null);
			assert.deepEqual(body.warpExitsDetail, { usable: 0 });
			assert.equal(body.service, "pi-free-bridge-relay", "nothing existing is renamed or removed");

			// After a request that preferred an exit, /health names it.
			resetWarpStateForTests();
			const fake = fakePoolProxy({
				detail: [freshExit(POOL_A), freshExit(POOL_B)],
				health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			});
			try {
				await forward(fakeReq({ marker: "preferred" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			} finally {
				fake.restore();
			}
			body = await readHealth(
				[freshExit(POOL_A), freshExit(POOL_B)],
				healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			);
			assert.equal(body.preferredRouting, true);
			assert.equal(body.preferredExit, "warp-a", "the id the relay last preferred");
		} finally {
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

// ---------------------------------------------------------------------------
// T7 round 1: the free round (S20, S27) and the terminal rule (S22, S28)
// ---------------------------------------------------------------------------
// The ladder's cheapest rung is the one that spends no enrollment: attempt the
// exits the pool ALREADY has, one request each, and let an attributable 429 park
// that egress before the next candidate is tried. A parked egress is skipped
// instead of attempted (S27) — that is what the ledger is for — and when nothing
// clean is left exactly one terminal attempt goes through the last candidate, so
// a refusal is never synthesized from the ledger (S28).

const upstreamProxies = (fake) =>
	fake.calls
		.filter((call) => call.url.startsWith(WARP_CONFIG.upstream))
		.map((call) => call.proxy);

const credit = (id) => `http://${id}:@127.0.0.1:8789`;

/** Both egresses burnt: the ledger is written BEFORE the request, because the
 *  point of the case is the ladder's behaviour with nothing clean left. */
async function withBurntPool(file, run) {
	const now = Date.now();
	const ledger = parkQuotaEgress(
		parkQuotaEgress(parseQuotaLedger(""), { ip: EGRESS_A, parkedUntil: now + 3_600_000, reason: "gate_429", now }),
		{ ip: EGRESS_B, parkedUntil: now + 3_600_000, reason: "gate_429", now },
	);
	writeFileSync(file, serializeQuotaLedger(ledger));
	return run(loadQuotaLedgerAtStartup(file));
}

test("free round: each eligible exit is attempted once, in rank order, before any enrollment (S20)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		// The first exit refuses with a reset far in the future, the second one answers.
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
			health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			upstream: (call) =>
				call.proxy === credit("warp-a")
					? new Response(GATE_429_BODY, { status: 429, headers: { "retry-after": "3600" } })
					: new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
		});
		try {
			resetWarpStateForTests();
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "free-round" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.deepEqual(
				upstreamProxies(fake),
				[credit("warp-a"), credit("warp-b")],
				"the freshest exit first, then the next eligible one — each at most once",
			);
			assert.equal(res.status, 200, "the second exit answered, so the client is not rate-limited at all");
			assert.ok(
				readQuotaLedger(file).egresses[quotaEgressKey(EGRESS_A)],
				`the burnt address is parked before the next attempt: ${JSON.stringify(readQuotaLedger(file).egresses)}`,
			);
			assert.equal(
				fake.calls.filter((call) => call.method === "POST" && /\/(swap|recycle)$/.test(call.url)).length,
				0,
				"round 1 spends no enrollment",
			);
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("terminal: the client sees the LAST refusal, never the first 429 of the episode (S22, S28)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const bodies = {
			"warp-a": '{"type":"Refusal","exit":"warp-a"}',
			"warp-b": '{"type":"Refusal","exit":"warp-b"}',
		};
		// Both existing exits refuse, each with its own window: the freshest
		// `retry-after` is the only number the client can act on.
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
			health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			upstream: (call) => {
				if (!call.url.startsWith(WARP_CONFIG.upstream)) return new Response("{}", { status: 501 });
				const id = String(call.proxy ?? "").split("//")[1]?.split(":")[0];
				return new Response(bodies[id] ?? "{}", { status: 429, headers: { "retry-after": "3600" } });
			},
		});
		try {
			resetWarpStateForTests();
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "terminal" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.deepEqual(upstreamProxies(fake), [credit("warp-a"), credit("warp-b")], "one attempt each");
			assert.equal(res.status, 429, "one 429 reaches the client, and it is the terminal one");
			assert.equal(
				res.body(),
				bodies["warp-b"],
				"the delivered 429 is the LAST attempt's bytes, not the first one's",
			);
			const egresses = readQuotaLedger(file).egresses;
			assert.ok(egresses[quotaEgressKey(EGRESS_A)] && egresses[quotaEgressKey(EGRESS_B)], "both are parked");
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("terminal: a fully parked pool spends one unnamed attempt, then the ladder's last candidate (S27, S28)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const bodies = {
			"warp-a": '{"type":"Refusal","exit":"warp-a"}',
			"warp-b": '{"type":"Refusal","exit":"warp-b"}',
		};
		const upstream = (call) => {
			if (!call.url.startsWith(WARP_CONFIG.upstream)) return new Response("{}", { status: 501 });
			const id = String(call.proxy ?? "").split("//")[1]?.split(":")[0];
			return new Response(bodies[id] ?? "{}", { status: 429, headers: { "retry-after": "3600" } });
		};
		// A thin pool on purpose: with no standby the ladder cannot spend a swap, so
		// the request terminates where these assertions can see it.
		const thinPool = { ...healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]), healthy: 1 };
		try {
			// (a) EVERY egress parked: nothing is named, because the credential only buys
			// attribution and these addresses are already in the ledger (S27). The free
			// round then spends the single terminal attempt on the LAST candidate.
			const fake = fakePoolProxy({
				detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
				health: thinPool,
				upstream,
			});
			try {
				await withBurntPool(file, async () => {
					resetWarpStateForTests();
					loadQuotaLedgerAtStartup(file);
					const res = fakeRelayRes();
					await forward(fakeReq({ marker: "burnt" }), res, RESEND_PATH, FORWARD_CONFIG);

					const proxies = upstreamProxies(fake);
					assert.equal(proxies.length, 2, "the attempt already in hand, plus the terminal one — no loop");
					assert.equal(proxies[0], POOL_PROXY, "a fully parked pool is not named: the 429 could not park it again");
					assert.deepEqual(proxies.slice(1), [credit("warp-b")], "the terminal attempt is the LAST candidate");
					assert.equal(res.status, 429);
					assert.equal(
						res.body(),
						bodies["warp-b"],
						"the bytes are the last attempt's own, delivered exactly as they arrived",
					);
				});
			} finally {
				fake.restore();
			}

			// (b) Nothing clean for ANOTHER reason — every address is stale, nothing is
			// parked — keeps today's answer: a stale address cannot be named either, so
			// the attempt leaves unnamed and its 429 stays unattributable (S7).
			writeFileSync(file, serializeQuotaLedger(parseQuotaLedger("")));
			const staleFake = fakePoolProxy({
				detail: [freshExit(POOL_A, 300), freshExit(POOL_B, 300)],
				health: thinPool,
				upstream,
			});
			try {
				resetWarpStateForTests();
				loadQuotaLedgerAtStartup(file);
				const res = fakeRelayRes();
				await forward(fakeReq({ marker: "stale" }), res, RESEND_PATH, FORWARD_CONFIG);

				assert.deepEqual(upstreamProxies(staleFake), [POOL_PROXY], "a stale pool names nothing, as before");
				assert.deepEqual(readQuotaLedger(file).egresses, {}, "nothing was attributable, so nothing is parked");
				assert.equal(res.status, 429, "the 429 in hand is what the client gets");
			} finally {
				staleFake.restore();
			}
		} finally {
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("round 1: a 5xx from the next exit never replaces the 429 already in hand (S22)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const refusal = '{"type":"Refusal","exit":"warp-a"}';
		const broken = '{"error":"tunnel unavailable"}';
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
			// One healthy exit: with no standby the paid round cannot spend a swap, so
			// the rotation is the only step left and this proxy refuses it.
			health: { ...healthOf(["warp-a", "healthy"]), healthy: 1 },
			upstream: (call) => {
				if (!call.url.startsWith(WARP_CONFIG.upstream)) return new Response("{}", { status: 501 });
				if (call.proxy === credit("warp-b")) {
					return new Response(broken, { status: 503, headers: { "content-type": "application/json" } });
				}
				return new Response(refusal, { status: 429, headers: { "retry-after": "3600" } });
			},
		});
		try {
			resetWarpStateForTests();
			const res = fakeRelayRes();
			await forward(fakeReq({ marker: "broken-exit" }), res, RESEND_PATH, FORWARD_CONFIG);

			assert.deepEqual(upstreamProxies(fake), [credit("warp-a"), credit("warp-b")], "round 1 tried both");
			assert.equal(res.status, 429, "the client sees the 429, never a burnt exit's 5xx");
			assert.equal(res.body(), refusal, "the refusal already in hand is what is delivered");
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("terminal: an attempt that produces no response leaves the 429 already in hand (S28)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		// The first attempt answers 429, the terminal one dies with no response at
		// all: the fallback is the 429 the relay already holds, and the path must
		// terminate on its own — no wait, no retry, no clock.
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
			health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			upstream: (call) => {
				if (!call.url.startsWith(WARP_CONFIG.upstream)) return new Response("{}", { status: 501 });
				if (call.proxy === credit("warp-a")) throw new Error("socket hang up");
				return new Response('{"type":"Refusal","exit":"warp-b"}', {
					status: 429,
					headers: { "retry-after": "3600" },
				});
			},
		});
		try {
			await withBurntPool(file, async () => {
				resetWarpStateForTests();
				loadQuotaLedgerAtStartup(file);
				const res = fakeRelayRes();
				await forward(fakeReq({ marker: "no-response" }), res, RESEND_PATH, FORWARD_CONFIG);

				assert.equal(res.status, 429, "the original 429 is the fallback when the last attempt answers nothing");
				assert.equal(res.body(), '{"type":"Refusal","exit":"warp-b"}', "and it is delivered byte-exact");
			});
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

test("/health publishes the free round and its terminal 429 (S23)", async () => {
	await withQuotaDir(async (file) => {
		process.env.RELAY_QUOTA_PATH = file;
		const fake = fakePoolProxy({
			detail: [freshExit(POOL_A), freshExit(POOL_B, 60)],
			health: healthOf(["warp-a", "healthy"], ["warp-b", "healthy"]),
			upstream: () => new Response(GATE_429_BODY, { status: 429, headers: { "retry-after": "3600" } }),
		});
		try {
			resetWarpStateForTests();
			await forward(fakeReq({ marker: "counted" }), fakeRelayRes(), RESEND_PATH, FORWARD_CONFIG);
			const res = fakeRelayRes();
			await handle({ method: "GET", url: "/health", headers: {}, on() {} }, res, { ...FORWARD_CONFIG, warpMode: "off" });
			const body = JSON.parse(res.body());

			assert.equal(
				body.warpCrossExitAttempts,
				1,
				"the one exit round 1 attempted besides the one that refused first",
			);
			assert.equal(body.warpTerminal429s, 1, "one request ended in a terminal 429");
			assert.equal(typeof body.warpRecycles, "number", "round 2's rotation counter is here as well");
			assert.equal(typeof body.warpSwaps, "number", "and its targeted swap");
		} finally {
			fake.restore();
			delete process.env.RELAY_QUOTA_PATH;
			resetWarpStateForTests();
		}
	});
});

// ---------------------------------------------------------------------------
// Download progress (odd/tasks/download-progress.md).
//
// Every file the extension downloads must say how far along it is, but a
// percentage is a claim about the whole file: it is shown only when the server
// sent a content-length, never guessed from a release-API size, and never
// faked as 0% or 100% when the length is missing or unusable. Bodies are read
// through local streams here — nothing touches the network.
// ---------------------------------------------------------------------------

/** A response body that hands back `chunks` and then ends. */
function bodyOf(chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
			controller.close();
		},
	});
}

/** A response body that delivers `first` and then fails, like a dropped
 *  connection halfway through a download. */
function brokenBodyOf(first, error) {
	let pulls = 0;
	return new ReadableStream({
		pull(controller) {
			if (pulls++ === 0) {
				controller.enqueue(new Uint8Array(first));
				return;
			}
			controller.error(error);
		},
	});
}

test("formatDownloadProgress: a known content-length states the percentage and both sizes", () => {
	// 2_000_000 of 4_194_304 bytes is 47%: the readout is the line the user
	// reads while the warp archive lands, not a log entry.
	const line = releaseMod.formatDownloadProgress({
		label: "Downloading warp-minimal v0.5.0…",
		received: 2000000,
		total: 4 * 1048576,
	});
	assert.equal(line, "Downloading warp-minimal v0.5.0… 47% (1.9 MB / 4.0 MB)");
});

test("formatDownloadProgress: an unknown length reports bytes only and claims no percentage", () => {
	// A chunked response carries no content-length. Printing 0% or 100% would be
	// inventing a fact the server never sent.
	const line = releaseMod.formatDownloadProgress({
		label: "Downloading relay.js v0.6.0…",
		received: 2000000,
		total: undefined,
	});
	assert.equal(line, "Downloading relay.js v0.6.0… 1.9 MB (size unknown)");
	assert.doesNotMatch(line, /%/, "no percentage may appear without a known total");
});

test("formatDownloadProgress: a zero-length body claims neither 0% nor 100%", () => {
	const line = releaseMod.formatDownloadProgress({
		label: "Downloading relay.js v0.6.0…",
		received: 0,
		total: 0,
	});
	assert.equal(line, "Downloading relay.js v0.6.0… 0.0 MB (size unknown)");
	assert.doesNotMatch(line, /%/, "a 0-byte total is unusable, so it is not a percentage");
});

test("downloadPercent: arithmetic, clamping, and no percentage for an unusable total", () => {
	assert.equal(releaseMod.downloadPercent(0, 4194304), 0);
	assert.equal(releaseMod.downloadPercent(2097152, 4194304), 50);
	assert.equal(releaseMod.downloadPercent(4194304, 4194304), 100);
	assert.equal(releaseMod.downloadPercent(999, 1000), 99, "a partial byte never rounds up to complete");
	assert.equal(releaseMod.downloadPercent(5000, 1000), 100, "a server that overruns its own total is capped");

	for (const total of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(
			releaseMod.downloadPercent(100, total),
			undefined,
			`total ${String(total)} is not a known size, so it has no percentage`,
		);
	}
});

test("contentLengthFrom: reads a usable content-length and refuses everything else", () => {
	const headers = (value) => ({ get: (name) => (name.toLowerCase() === "content-length" ? value : null) });
	assert.equal(releaseMod.contentLengthFrom(headers("4194304")), 4194304);
	assert.equal(releaseMod.contentLengthFrom(headers(" 4194304 ")), 4194304);
	assert.equal(releaseMod.contentLengthFrom(headers(null)), undefined, "absent: chunked transfer");
	assert.equal(releaseMod.contentLengthFrom(headers("0")), undefined, "a zero total cannot carry a percentage");
	assert.equal(releaseMod.contentLengthFrom(headers("-")), undefined);
	assert.equal(releaseMod.contentLengthFrom(headers("12abc")), undefined);
	assert.equal(releaseMod.contentLengthFrom(undefined), undefined);
});

test("createDownloadReporter: one line per percentage point or per 100 ms, never per chunk", () => {
	const lines = [];
	const clock = { at: 0 };
	const report = (line) => lines.push(line);

	// With no content-length only the clock can gate the update.
	const unknown = releaseMod.createDownloadReporter({
		label: "Downloading relay.js v0.6.0…",
		total: undefined,
		report,
		now: () => clock.at,
	});
	unknown(1048576);
	assert.deepEqual(lines, ["Downloading relay.js v0.6.0… 1.0 MB (size unknown)"]);
	clock.at = 40;
	unknown(2097152);
	clock.at = 99;
	unknown(3145728);
	assert.equal(lines.length, 1, "chunks arriving inside the window are not reported one by one");
	clock.at = 100;
	unknown(4194304);
	assert.equal(lines.length, 2, "100 ms elapsed, so the next chunk is reported");

	// With a known total a whole percentage point moves the readout immediately.
	lines.length = 0;
	const known = releaseMod.createDownloadReporter({
		label: "Downloading warp-minimal v0.5.0…",
		total: 1000,
		report,
		now: () => clock.at,
	});
	known(0);
	assert.equal(lines[0], "Downloading warp-minimal v0.5.0… 0% (0.0 MB / 0.0 MB)");
	known(5);
	assert.equal(lines.length, 1, "the same percentage inside the window is suppressed");
	clock.at = 101;
	known(10);
	assert.equal(lines.length, 2, "a new percentage point is reported without waiting");
	assert.match(lines[1], / 1% \(/);

	// The caller forces the last line so the readout ends on the real byte count.
	clock.at = 102;
	known(1000, true);
	assert.match(lines[2], / 100% \(/);
});

test("readDownloadBody: streams every byte and ends on the finished size", async () => {
	const lines = [];
	const bytes = await releaseMod.readDownloadBody({
		body: bodyOf([[1, 2, 3], [4, 5], [6]]),
		label: "Downloading warp-minimal v0.5.0…",
		total: 6,
		report: (line) => lines.push(line),
		now: () => 0,
	});
	assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6], "the body arrives intact");
	assert.match(lines.at(-1), / 100% \(/, "the last line states the download finished");
});

test("readDownloadBody: a stream that fails midway rejects and never looks complete", async () => {
	const lines = [];
	await assert.rejects(
		releaseMod.readDownloadBody({
			body: brokenBodyOf([1, 2, 3], new Error("connection reset")),
			label: "Downloading relay.js v0.6.0…",
			total: 10,
			report: (line) => lines.push(line),
			now: () => 0,
		}),
		/connection reset/,
		"a half-read body is a failed download, not a short one",
	);
	assert.ok(
		lines.every((line) => !/ 100% /.test(line)),
		"nothing claims the partial body was the whole file",
	);
});

test("readDownloadBody: a response with no body is a failed download", async () => {
	await assert.rejects(
		releaseMod.readDownloadBody({ body: null, label: "Downloading relay.js v0.6.0…", total: undefined }),
		/no body/,
	);
});

test("every file download in index.ts streams through readDownloadBody", () => {
	// Two install sites (warp-minimal, relay) download a binary off the network.
	// Buffering one of them with `arrayBuffer()` would silently lose its progress.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /arrayBuffer\(\)/, "no download may buffer a body without progress");
	assert.equal(
		(source.match(/await readDownloadBody\(/g) ?? []).length,
		2,
		"both install sites report progress",
	);
});

// T9a / S29: the proxy's build identity is a fact the relay republishes, so
// "which binary is running" stops being a guess. Three states, never two:
// identifiable, answered without identity (the Go default is "unknown"), and
// no answer at all.
test("warpBuildFact: a build that names its commit is reported as an identity (S29)", () => {
	assert.deepEqual(
		warpBuildFact({ build: { commit: "b04459a", built_at: "2026-11-14T14:35:36Z" } }),
		{ commit: "b04459a", builtAt: "2026-11-14T14:35:36Z" },
	);
});

test("warpBuildFact: the Go default \"unknown\" is absence of identity, not a commit (S29)", () => {
	assert.deepEqual(warpBuildFact({ build: { commit: "unknown", built_at: "unknown" } }), {
		commit: null,
		builtAt: "unknown",
	});
	assert.deepEqual(warpBuildFact({ build: {} }), { commit: null, builtAt: null });
});

test("warpBuildFact: a body without a build key yields nothing, which /health publishes as null (S29)", () => {
	assert.equal(warpBuildFact({ ok: true, exits: [] }), undefined);
	assert.equal(warpBuildFact(undefined), undefined);
	assert.equal(warpBuildFact({ build: "b04459a" }), undefined);
});

test("/health republishes the proxy's build identity, and null when it has none (S29)", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => healthJson({ ok: true, capabilities: { exits: true }, build: { commit: "b04459a", built_at: "2026-11-14T14:35:36Z" } });
	try {
		resetWarpStateForTests();
		const res = fakeRelayRes();
		await handle({ method: "GET", url: "/health", headers: {}, on() {} }, res, { ...FORWARD_CONFIG, warpMode: "off" });
		const body = JSON.parse(res.body());
		assert.deepEqual(body.warpBuild, { commit: "b04459a", builtAt: "2026-11-14T14:35:36Z" });
	} finally {
		globalThis.fetch = originalFetch;
	}

	// A proxy that answers without a build object publishes null: the relay has
	// no identity to report, and inventing one would defeat the whole point.
	globalThis.fetch = async () => healthJson({ ok: true, capabilities: { exits: true } });
	try {
		resetWarpStateForTests();
		const res = fakeRelayRes();
		await handle({ method: "GET", url: "/health", headers: {}, on() {} }, res, { ...FORWARD_CONFIG, warpMode: "off" });
		const body = JSON.parse(res.body());
		assert.ok(Object.prototype.hasOwnProperty.call(body, "warpBuild"), "warpBuild must be present, not absent");
		assert.equal(body.warpBuild, null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// T9b / S29, S30c, S30d: the running proxy must be able to say which build it is,
// and when it cannot, the notice has to name the action. Every case below is one
// line of policy: silence when there is nothing to do, one actionable sentence
// otherwise, and never a diagnostic without a command.
test("parseWarpBuildVersion: the commit in parentheses is the identity (T9b)", () => {
	assert.equal(releaseMod.parseWarpBuildVersion("warp-minimal v0.2.3 (b04459a)"), "b04459a");
	assert.equal(releaseMod.parseWarpBuildVersion("  warp-minimal v0.2.3 (b04459a)\n"), "b04459a");
});

test("parseWarpBuildVersion: (unknown) is absence of identity, not a commit (T9b)", () => {
	assert.equal(releaseMod.parseWarpBuildVersion("warp-minimal v0.2.3 (unknown)"), null);
	assert.equal(releaseMod.parseWarpBuildVersion("warp-minimal v0.2.3"), null);
	assert.equal(releaseMod.parseWarpBuildVersion(""), null);
});

test("warpBuildNotice: equal builds say nothing at all (T9b)", () => {
	assert.equal(releaseMod.warpBuildNotice({ running: "b04459a", installed: "b04459a" }), null);
});

test("warpBuildNotice: an unidentifiable proxy names the update, which is what installs identity (T9b)", () => {
	assert.equal(
		releaseMod.warpBuildNotice({ running: null, installed: null }),
		"warp does not publish its identity (a build older than warp-build-identity), so what runs cannot be verified — update with /warp update",
	);
	assert.equal(
		releaseMod.warpBuildNotice({ running: null, installed: "b04459a" }),
		"warp does not publish its identity (a build older than warp-build-identity), so what runs cannot be verified — update with /warp update",
	);
});

test("warpBuildNotice: a different build on disk names both commits (T9b)", () => {
	assert.equal(
		releaseMod.warpBuildNotice({ running: "b04459a", installed: "9a1c2f0" }),
		"the proxy runs b04459a, the installed build is 9a1c2f0 — /warp update",
	);
});

test("warpBuildNotice: an installed build older than the running one is not an update (T9b)", () => {
	// The running proxy can name itself and the file on disk cannot: the file is
	// the older artifact, so "update" would be advice to downgrade.
	assert.equal(releaseMod.warpBuildNotice({ running: "b04459a", installed: null }), null);
});

test("warpBuildDrift: a dependency that fails is no answer, never a broken entry point (T9b)", async () => {
	const notice = await releaseMod.warpBuildDrift({
		fetchProxyBuild: async () => {
			throw new Error("connect ECONNREFUSED");
		},
		readInstalledBuild: () => {
			throw new Error("spawn failed");
		},
	});
	assert.match(notice ?? "", /does not publish its identity/);
});

test("warpBuildDrift: matching builds produce no notice at all (T9b)", async () => {
	const notice = await releaseMod.warpBuildDrift({
		fetchProxyBuild: async () => "b04459a",
		readInstalledBuild: () => "b04459a",
	});
	assert.equal(notice, null);
});

// T9c: a release publishes its tag, never the commit inside it, and the binary
// prints the source's version constant rather than the tag — so "up to date" is
// read from the install record, not guessed from the download.
test("warpUpdateDecision: the same tag decides nothing is to be installed (T9c)", () => {
	assert.equal(releaseMod.warpUpdateDecision({ latestTag: "v0.4.0", installedTag: "v0.4.0" }), "up-to-date");
	assert.equal(releaseMod.warpUpdateDecision({ latestTag: "v0.4.0", installedTag: "0.4.0" }), "up-to-date");
});

test("warpUpdateDecision: a different or missing record means install (T9c)", () => {
	assert.equal(releaseMod.warpUpdateDecision({ latestTag: "v0.4.0", installedTag: "v0.3.1" }), "update");
	assert.equal(releaseMod.warpUpdateDecision({ latestTag: "v0.4.0", installedTag: null }), "update");
});

test("warpUpdateDecision: no latest tag is unknown, which is not 'update' (T9c)", () => {
	assert.equal(releaseMod.warpUpdateDecision({ latestTag: null, installedTag: "v0.4.0" }), "unknown");
	assert.equal(releaseMod.warpUpdateDecision({ latestTag: "  ", installedTag: "v0.4.0" }), "unknown");
});

// T9c: the record is the fact `warpUpdateDecision` needs. Every test below passes
// an explicit path, so the real install directory is never read or written.
test("warpInstallRecord: a written record round trips tag, commit and timestamp (T9c)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-install-record-"));
	try {
		const path = join(dir, "warp-install.json");
		const before = Date.now();
		releaseMod.writeWarpInstallRecord({ tag: "v0.4.0", commit: "b04459a" }, path);
		const read = releaseMod.readWarpInstallRecord(path);
		assert.deepEqual({ tag: read.tag, commit: read.commit }, { tag: "v0.4.0", commit: "b04459a" });
		assert.ok(typeof read.installed_at === "number", "installed_at is a number");
		assert.ok(read.installed_at >= before && read.installed_at <= Date.now(), "installed_at is the write time");
		// Atomic write: the record is the only file left, no temp file beside it.
		assert.deepEqual(readdirSync(dir), ["warp-install.json"]);
		assert.equal(
			releaseMod.warpUpdateDecision({ latestTag: "v0.4.0", installedTag: releaseMod.readWarpInstallRecord(path).tag }),
			"up-to-date",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("warpInstallRecord: a missing file is no record at all (T9c)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-install-record-"));
	try {
		assert.equal(releaseMod.readWarpInstallRecord(join(dir, "warp-install.json")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("warpInstallRecord: an unparseable or wrong-shape file is no record either (T9c)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pfb-install-record-"));
	try {
		const path = join(dir, "warp-install.json");
		writeFileSync(path, "not json at all", "utf-8");
		assert.equal(releaseMod.readWarpInstallRecord(path), undefined, "unparseable");
		for (const bad of [
			"null",
			"[]",
			JSON.stringify({ commit: "b04459a", installed_at: 1 }),
			JSON.stringify({ tag: "", commit: "b04459a", installed_at: 1 }),
			JSON.stringify({ tag: "   ", commit: "b04459a", installed_at: 1 }),
			JSON.stringify({ tag: 42, commit: "b04459a", installed_at: 1 }),
		]) {
			writeFileSync(path, bad, "utf-8");
			assert.equal(releaseMod.readWarpInstallRecord(path), undefined, `wrong shape: ${bad}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


// D10: the port the relay listens on and the variable its clash message names
// must be the same one, otherwise following the advice cannot change anything.
test("D10: the listen port reads the variable the error message names", async () => {
	const { resolveListenPort } = await import("../relay.mjs");
	assert.equal(resolveListenPort({ PI_FREE_BRIDGE_RELAY_PORT: "9123", PORT: "8788" }), 9123);
	assert.equal(resolveListenPort({ PORT: "8788" }), 8788, "PORT stays supported for the spawn path");
	assert.ok(Number.isNaN(resolveListenPort({})), "no port named is not a port");
});

// D11: stopping the proxy is the only moment it may die, so every refusal has to
// be louder than a wrong kill. The four answers below are the whole policy.
const stopDeps = (over = {}) => ({
	probe: async () => ({ ok: true }),
	recorded: () => ({ pid: 4242, bin: "/x/warp-minimal" }),
	exeOf: () => "/x/warp-minimal",
	kill: () => undefined,
	sleep: async () => undefined,
	attempts: 2,
	...over,
});

test("stopWarpProxy: nothing answering means nothing to stop, and nothing is killed (D11)", async () => {
	let killed = 0;
	const result = await releaseMod.stopWarpProxy(
		stopDeps({
			probe: async () => undefined,
			kill: () => {
				killed += 1;
			},
		}),
	);
	assert.equal(result, "nothing-to-stop");
	assert.equal(killed, 0);
});

test("stopWarpProxy: no record means no pid it can claim, so it refuses (D11)", async () => {
	let killed = 0;
	const result = await releaseMod.stopWarpProxy(
		stopDeps({
			recorded: () => undefined,
			kill: () => {
				killed += 1;
			},
		}),
	);
	assert.equal(result, "unknown-pid");
	assert.equal(killed, 0);
});

test("stopWarpProxy: an executable that is not the recorded binary is a reused pid (D11)", async () => {
	let killed = 0;
	const result = await releaseMod.stopWarpProxy(
		stopDeps({
			exeOf: () => "/usr/bin/something-else",
			kill: () => {
				killed += 1;
			},
		}),
	);
	assert.equal(result, "refused");
	assert.equal(killed, 0);
});

test("stopWarpProxy: an unreadable executable is not a mismatch, so it does stop (D11)", async () => {
	const signals = [];
	let alive = true;
	const result = await releaseMod.stopWarpProxy(
		stopDeps({
			exeOf: () => undefined,
			probe: async () => (alive ? { ok: true } : undefined),
			kill: (_pid, signal) => {
				signals.push(signal);
				alive = false;
			},
		}),
	);
	assert.equal(result, "stopped");
	assert.deepEqual(signals, ["SIGTERM"]);
});

test("stopWarpProxy: a process that survives every signal is reported, never assumed dead (D11)", async () => {
	const result = await releaseMod.stopWarpProxy(stopDeps());
	assert.equal(result, "unverified");
});

test("warpReadyFact: a new binary proves itself with identity, capability and an exit (D11)", () => {
	const good = {
		build: { commit: "b04459a" },
		capabilities: { exits: true },
		exits: [{ id: "warp-1", ip: "2a09::1" }],
	};
	assert.equal(releaseMod.warpReadyFact(good), true);
	assert.equal(releaseMod.warpReadyFact({ ...good, build: { commit: "unknown" } }), false, "a versionless build is not proof");
	assert.equal(releaseMod.warpReadyFact({ ...good, build: undefined }), false, "the old build serving is exactly what this must catch");
	assert.equal(releaseMod.warpReadyFact({ ...good, capabilities: { exits: false } }), false);
	assert.equal(releaseMod.warpReadyFact({ ...good, exits: [] }), false);
	assert.equal(releaseMod.warpReadyFact({ ...good, exits: [{ id: "warp-1" }] }), false, "an exit without an address is not eligible");
});

// D11: a swap replaces a binary underneath a running proxy, so it may go ahead
// only when the old process is provably gone. Only two of the five answers prove
// that; the three refusals mean the proxy may still be serving, so replacing it
// would be the wrong kill the stop policy exists to prevent.
test("warpStopForSwap: only a stop it can prove lets the binary be replaced (D11)", async () => {
	const expected = {
		stopped: true,
		"nothing-to-stop": true,
		"unknown-pid": false,
		refused: false,
		unverified: false,
	};
	for (const [result, allowed] of Object.entries(expected)) {
		let called = 0;
		let seenUrl;
		const swapped = await releaseMod.warpStopForSwap("http://127.0.0.1:8789/health", async (url) => {
			called += 1;
			seenUrl = url;
			return result;
		});
		assert.equal(swapped, allowed, `${result} allows the swap: ${allowed}`);
		assert.equal(called, 1, "the stop is asked exactly once");
		assert.equal(seenUrl, "http://127.0.0.1:8789/health", "the health URL is handed to the stop");
	}
});

// D11: the restarted proxy must prove it is the new binary. One not-ready probe
// is a restart still coming up, not a failure, so the poll must continue.
test("warpStartAndVerify: the restarted proxy is ready on the second probe (D11)", async () => {
	const ready = { build: { commit: "b04459a" }, capabilities: { exits: true }, exits: [{ id: "warp-1", ip: "2a09::1" }] };
	let starts = 0;
	let probes = 0;
	let sleeps = 0;
	const ok = await releaseMod.warpStartAndVerify({
		start: async () => {
			starts += 1;
		},
		probe: async () => {
			probes += 1;
			return probes >= 2 ? ready : { build: { commit: "unknown" }, capabilities: { exits: true }, exits: [] };
		},
		sleep: async () => {
			sleeps += 1;
		},
		attempts: 4,
	});
	assert.equal(ok, true, "a proxy that turns ready is a successful start");
	assert.equal(starts, 1, "the proxy is launched once");
	assert.equal(probes, 2, "the poll stops as soon as the fact is proven");
	assert.equal(sleeps, 1, "one wait between the two probes");
});

// D11: a proxy that never proves itself must fail the swap quickly and honestly,
// bounded by a fixed number of probes, and it must not throw — the update has to
// report the failure, not die inside it.
test("warpStartAndVerify: a proxy that never proves itself fails within a bounded number of probes (D11)", async () => {
	let probes = 0;
	const ok = await releaseMod.warpStartAndVerify({
		start: async () => undefined,
		probe: async () => {
			probes += 1;
			return { build: { commit: "unknown" }, capabilities: { exits: false }, exits: [] };
		},
		sleep: async () => undefined,
		attempts: 3,
	});
	assert.equal(ok, false, "the old build serving is not a successful start");
	assert.equal(probes, 3, "the deadline is a fixed number of probes, never an open loop");

	let afterThrow = 0;
	const survived = await releaseMod.warpStartAndVerify({
		start: async () => {
			throw new Error("spawn failed");
		},
		probe: async () => {
			afterThrow += 1;
			return undefined;
		},
		sleep: async () => undefined,
		attempts: 3,
	});
	assert.equal(survived, false, "a launch that throws is a false result, not an exception");
	assert.equal(afterThrow, 0, "nothing is probed when nothing was launched");
});

// ---------------------------------------------------------------------------
// The update orchestration, with every effect injected (T9c).
//
// Nothing here downloads, swaps or talks to the proxy: each effect is a fake
// counted by the helper below, so "nothing was downloaded" is an observed fact
// rather than a claim. The order is the contract: decision, consent, download,
// swap, then read the running commit and write the record.
// ---------------------------------------------------------------------------

const DOWNLOADED_RELAY = "/tmp/pi-free-bridge-relay";

function updateFakes({
	latestTag = async () => "v0.5.0",
	installedTag = "v0.4.0",
	confirmAnswer = true,
	downloadFails = false,
	swapResult = { ok: true, rolledBack: false },
	runningCommit = "9f1c2ab",
} = {}) {
	const calls = { latestTag: 0, confirm: 0, download: 0, swap: 0, readRunningCommit: 0, writeRecord: 0 };
	const written = [];
	const swaps = [];
	const deps = {
		latestTag: async () => {
			calls.latestTag += 1;
			return latestTag();
		},
		installedRecord: () => (installedTag === null ? undefined : { tag: installedTag, commit: "b04459a" }),
		confirm: async () => {
			calls.confirm += 1;
			return confirmAnswer;
		},
		download: async () => {
			calls.download += 1;
			return downloadFails ? undefined : DOWNLOADED_RELAY;
		},
		swap: async (path, tag) => {
			calls.swap += 1;
			swaps.push({ path, tag });
			return swapResult;
		},
		readRunningCommit: async () => {
			calls.readRunningCommit += 1;
			return runningCommit;
		},
		writeRecord: (record) => {
			calls.writeRecord += 1;
			written.push(record);
		},
	};
	return { deps, calls, written, swaps };
}

// The text shown before the confirm is the whole consent: it has to name the
// real cost, because "a 5 MB download" would hide it.
test("warpUpdateCostLines: the cost shown before confirming names every price of the swap (T9c)", () => {
	const text = releaseMod.warpUpdateCostLines();
	const lines = Array.isArray(text) ? text : [text];
	const joined = lines.join("\n");
	assert.match(joined, /two enrollments/, "the two enrollments are named");
	assert.match(joined, /3-5 s/, "the 3-5 s without service are named");
	assert.match(joined, /new egress addresses/, "the new egress addresses are named");
	assert.match(joined, /every parked entry stops matching a live exit/, "the parked entries are named");
	assert.match(joined, /(nothing is deleted|never deleted)/i, "and that they are never deleted");
	assert.match(joined, /shared/, "the proxy is named as shared");
	assert.match(joined, /(another Pi).*(loses service)/i, "so another Pi using it loses service too");
	assert.ok(
		lines.filter((line) => line.trim()).length >= 5,
		"the cost is more than one aggregate sentence",
	);
});

// Nothing to install means nothing to ask and nothing to download. An
// unreadable release is its own answer, never "there is an update".
test("updateWarpBinary: up-to-date never confirms, and an unreadable release is its own answer (T9c)", async () => {
	const current = updateFakes({ installedTag: "0.5.0" });
	const result = await releaseMod.updateWarpBinary(current.deps);
	assert.equal(result.status, "up-to-date");
	assert.equal(result.tag, "v0.5.0");
	assert.equal(current.calls.confirm, 0, "no consent is asked when there is nothing to install");
	assert.equal(current.calls.download, 0, "nothing is downloaded");
	assert.equal(current.calls.swap, 0);

	const unreadable = updateFakes({ latestTag: async () => null });
	const unknown = await releaseMod.updateWarpBinary(unreadable.deps);
	assert.equal(unknown.status, "unknown", "an unreadable release is not an update");
	assert.match(unknown.reason, /release/i, "it names the release it could not read");
	assert.equal(unreadable.calls.confirm, 0, "an unknown release never asks for consent");
	assert.equal(unreadable.calls.download, 0, "an unknown release downloads nothing");
	assert.equal(unreadable.calls.writeRecord, 0);
});

// A no at the confirm is a complete answer: nothing is fetched, nothing is
// touched, and no record claims an install that never happened.
test("updateWarpBinary: a declined confirmation downloads nothing and changes nothing (T9c)", async () => {
	const fakes = updateFakes({ confirmAnswer: false });
	const result = await releaseMod.updateWarpBinary(fakes.deps);
	assert.equal(result.status, "declined");
	assert.equal(fakes.calls.confirm, 1, "consent is asked exactly once");
	assert.equal(fakes.calls.download, 0, "a declined update downloads nothing");
	assert.equal(fakes.calls.swap, 0, "a declined update swaps nothing");
	assert.equal(fakes.calls.readRunningCommit, 0);
	assert.equal(fakes.calls.writeRecord, 0, "no record is written");
	assert.deepEqual(fakes.written, []);
});

// A download that returns nothing must leave the install exactly as it was and
// say so plainly: the proxy is still running the binary it already had.
test("updateWarpBinary: a failed download changes nothing and says so (T9c)", async () => {
	const fakes = updateFakes({ downloadFails: true });
	const result = await releaseMod.updateWarpBinary(fakes.deps);
	assert.equal(result.status, "failed");
	assert.match(result.reason, /nothing was changed/i, "it says nothing was changed");
	assert.equal(fakes.calls.download, 1);
	assert.equal(fakes.calls.swap, 0, "no swap runs on a download that never landed");
	assert.equal(fakes.calls.readRunningCommit, 0);
	assert.equal(fakes.calls.writeRecord, 0, "no record is written for an install that failed");
	assert.deepEqual(fakes.written, []);
});

// A swap that restored the previous binary reports the rollback with its own
// reason. One that failed without restoring has to say both facts plainly.
test("updateWarpBinary: a rolled-back swap reports the rollback with its reason (T9c)", async () => {
	const rolledBack = updateFakes({
		swapResult: { ok: false, rolledBack: true, reason: "the new binary never answered /health" },
	});
	const result = await releaseMod.updateWarpBinary(rolledBack.deps);
	assert.equal(result.status, "rolled-back");
	assert.equal(result.reason, "the new binary never answered /health", "the swap's own reason is kept");
	assert.equal(rolledBack.calls.swap, 1);
	assert.equal(rolledBack.calls.readRunningCommit, 0, "a rolled-back swap never claims a commit");
	assert.equal(rolledBack.calls.writeRecord, 0, "a rolled-back swap writes no record");
	assert.deepEqual(rolledBack.written, []);

	const notRestored = updateFakes({
		swapResult: { ok: false, rolledBack: false, reason: "the relay would not stop" },
	});
	const failed = await releaseMod.updateWarpBinary(notRestored.deps);
	assert.equal(failed.status, "failed");
	assert.match(failed.reason, /did not prove itself/, "it says the install did not prove itself");
	assert.match(failed.reason, /(was not restored|not restored)/, "and that the old binary was not restored");
	assert.equal(notRestored.calls.writeRecord, 0);
	assert.deepEqual(notRestored.written, []);
});

// Success is not the swap returning ok: it is the proxy reporting the commit it
// runs, and that commit is what the record keeps. A null commit is not success.
test("updateWarpBinary: success writes the record with the commit read from the proxy, and a null commit writes nothing (T9c)", async () => {
	const fakes = updateFakes();
	const result = await releaseMod.updateWarpBinary(fakes.deps);
	assert.equal(result.status, "updated");
	assert.equal(result.tag, "v0.5.0");
	assert.equal(result.commit, "9f1c2ab");
	assert.deepEqual(
		fakes.written,
		[{ tag: "v0.5.0", commit: "9f1c2ab" }],
		"the record carries the installed tag and the commit the proxy reported",
	);
	assert.equal(fakes.calls.writeRecord, 1);
	assert.deepEqual(
		fakes.swaps,
		[{ path: "/tmp/pi-free-bridge-relay", tag: "v0.5.0" }],
		"the swap gets the downloaded path and the tag",
	);

	const anonymous = updateFakes({ runningCommit: null });
	const failed = await releaseMod.updateWarpBinary(anonymous.deps);
	assert.equal(failed.status, "failed", "a build that does not identify itself is not a success");
	assert.match(failed.reason, /identif/i, "it says the new build did not identify itself");
	assert.equal(anonymous.calls.writeRecord, 0, "no record is written without a commit");
	assert.deepEqual(anonymous.written, []);
});
