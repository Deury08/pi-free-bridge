// pi-free-bridge relay — the only process that talks to the OpenCode free tier.
//
// Pi runs on Node, and the `/inference/v1` gate now rejects every request whose
// TLS ClientHello is not Bun's (GATE-DIAGNOSIS.md §3.1). Pi therefore points its
// provider at this local server, which makes the upstream call from Bun, injects
// the `<env>` block and the tools the gate requires, and pipes the response back
// byte-for-byte.
//
//   Pi (Node) -> http://127.0.0.1:<port>/v1/chat/completions -> relay (Bun) -> upstream
//
// The module exports its pure helpers so `test/relay.test.mjs` can run them
// under plain Node; the server only starts when this file is executed directly.
import {
	appendFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Gate helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

const ENV_BLOCK = /<env>[\s\S]*Working directory:[\s\S]*<\/env>/;

/** The block the gate parses for (GATE-DIAGNOSIS.md §3.2). */
function envBlock(cwd) {
	const directory = String(cwd ?? process.cwd()).replace(/\\/g, "/");
	return `<env>\n  Working directory: ${directory}\n  Platform: win32\n</env>`;
}

function appendEnv(content, block) {
	if (typeof content === "string") return content.length > 0 ? `${content}\n\n${block}` : block;
	// A parts array is a legal message shape. Appending one text part keeps every
	// existing part intact; the gate only needs the block somewhere in the prompt.
	if (Array.isArray(content)) return [...content, { type: "text", text: block }];
	return block;
}

/**
 * Append the gate-mandated `<env>` block to the first system/developer message.
 * Prepends a system message when there is none. Returns a new array and never
 * mutates the input, except that an already-conforming prompt is returned as-is.
 */
export function ensureEnvBlock(messages, cwd) {
	const list = Array.isArray(messages) ? messages : [];
	const block = envBlock(cwd);

	const index = list.findIndex(
		(message) => message && (message.role === "system" || message.role === "developer"),
	);
	if (index === -1) return [{ role: "system", content: block }, ...list];

	const target = list[index];
	if (typeof target.content === "string" && ENV_BLOCK.test(target.content)) return list;

	const next = list.slice();
	next[index] = { ...target, content: appendEnv(target.content, block) };
	return next;
}

function gateToolDeclarations() {
	return ["read", "bash"].map((name) => ({
		type: "function",
		function: {
			name,
			description: `${name} (injected by pi-free-bridge for the OpenCode free-tier gate)`,
			parameters: { type: "object", properties: {} },
		},
	}));
}

function toolName(tool) {
	if (!tool || typeof tool !== "object") return undefined;
	const nested = tool.function;
	if (nested && typeof nested === "object" && typeof nested.name === "string") return nested.name;
	if (typeof tool.name === "string") return tool.name;
	return undefined;
}

/**
 * Make the wire body carry both gate tool names. A missing or empty `tools`
 * array is replaced with minimal `read` + `bash` declarations; a partial set is
 * completed with only the missing names. Whenever the array is augmented,
 * `tool_choice` is pinned to `"none"` so the model cannot call them.
 */
export function ensureGateTools(body) {
	const next = { ...(body && typeof body === "object" ? body : {}) };
	const tools = next.tools;

	if (!Array.isArray(tools) || tools.length === 0) {
		next.tools = gateToolDeclarations();
		next.tool_choice = "none";
		return next;
	}

	const present = new Set(tools.map(toolName).filter((name) => typeof name === "string"));
	const missing = ["read", "bash"].filter((name) => !present.has(name));
	if (missing.length === 0) return next;

	next.tools = [...tools, ...gateToolDeclarations().filter((tool) => missing.includes(tool.function.name))];
	next.tool_choice = "none";
	return next;
}

/**
 * Map a local pathname onto the upstream surface. A leading `/v1` is dropped
 * when the base already ends with it, so `/v1/chat/completions` does not become
 * `/v1/v1/chat/completions`; every other path is preserved.
 */
export function toUpstreamUrl(upstreamBase, pathname) {
	const base = String(upstreamBase ?? "").replace(/\/+$/, "");
	let rest = String(pathname ?? "");
	if (!rest.startsWith("/")) rest = `/${rest}`;
	if (/\/v1$/.test(base)) rest = rest.replace(/^\/v1(?=\/|$)/, "");
	if (rest === "" || rest === "/") return base;
	return `${base}${rest}`;
}

// ---------------------------------------------------------------------------
// Session harvest (S31, S32)
// ---------------------------------------------------------------------------
//
// The package ships no session id. The gate only trusts ids the official
// OpenCode client created, so one is harvested from the local store: newest
// session row first, newest `storage/session_diff/ses_*.json` second.
// `bun:sqlite` is imported dynamically so importing this module under plain
// Node (the helper tests) never touches it.

const SESSION_ID = /^ses_/;

/**
 * The session table by OpenCode generation: v1 created `session`, v2 creates
 * `session_v2`. Ordered oldest-schema-first so a v1 store keeps its original
 * path and a v2 store simply skips the absent table.
 */
export const SESSION_TABLES = ["session", "session_v2"];

/**
 * Newest `ses_` id from the first candidate table that yields one. An absent
 * or unreadable table is skipped rather than fatal, and an empty (or all
 * foreign-id) table does not shadow the next candidate. Takes a `runSql`
 * callback instead of a db so it stays independent of the driver API: Bun's
 * `bun:sqlite` exposes `query(sql).all()`, Node's `node:sqlite` only exposes
 * `prepare(sql).all()`.
 */
export function harvestNewestSessionId(runSql, tables = SESSION_TABLES) {
	for (const table of tables) {
		let rows;
		try {
			rows = runSql(`select id from ${table} order by time_created desc limit 5`);
		} catch {
			// Table absent from this schema, or unreadable: try the next candidate.
			continue;
		}
		for (const row of rows) {
			const id = row && typeof row.id === "string" ? row.id : undefined;
			if (id && SESSION_ID.test(id)) return id;
		}
	}
	return undefined;
}

/** `~/.local/share/opencode`, the store the official client writes. */
function openCodeShareDir() {
	return join(homedir(), ".local", "share", "opencode");
}

/** OpenCode's state root. It branches on nothing: the XDG layout is used on
 *  every platform, so `~/.local/state` applies on Windows too
 *  (`packages/util/src/global-roots.ts`). `XDG_STATE_HOME` still wins. */
function openCodeStateDir() {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode");
}

/** The local server's registration file. Only `--service` mode writes it, and
 *  OpenCode's own client calls it "the complete discovery contract": a
 *  foreground `opencode serve` scans ports from 4096, so probing is not viable. */
export function openCodeServicePath() {
	return join(openCodeStateDir(), "service.json");
}

/** Pure: the parts of the registration file we act on, or `undefined` when it is
 *  unusable. Loopback only: a registration pointing anywhere else is foreign and
 *  must never receive the credential. */
export function parseServiceRegistration(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
	const password = typeof parsed.password === "string" ? parsed.password : "";
	if (!url || !password) return undefined;

	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return undefined;
	}
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
		return undefined;
	}
	return { url: url.replace(/\/+$/, ""), password };
}

/** Pure: the Basic credential the local server requires. The username is fixed
 *  to `opencode` (`packages/server/src/auth.ts`). */
export function basicAuthFor(password) {
	return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/** Ask the local OpenCode server to create a session and return its id.
 *
 *  The gate validates session ids against OpenCode's registry: a fabricated
 *  `ses_` id is rejected even when its shape is right, while a server-issued one
 *  is accepted although it has never served a request (measured 2026-11-12,
 *  5/5). Asking the server replaces scraping `opencode.db`, so the bridge stops
 *  depending on a table name OpenCode renames between major versions.
 *
 *  Best-effort by construction: an absent or stale registration, a refused port,
 *  a foreign listener or a body that is not ours all return `undefined`, and the
 *  caller falls through to the store harvest. The relay never spawns the daemon
 *  — lifecycle belongs to the operator. */
export async function mintSessionFromService({
	servicePath = openCodeServicePath(),
	timeoutMs = 2000,
} = {}) {
	let raw;
	try {
		raw = readFileSync(servicePath, "utf8");
	} catch {
		return undefined;
	}
	const registration = parseServiceRegistration(raw);
	if (!registration) return undefined;

	try {
		const response = await fetch(`${registration.url}/api/session`, {
			method: "POST",
			headers: {
				authorization: basicAuthFor(registration.password),
				"content-type": "application/json",
			},
			body: "{}",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const body = await response.json();
		const id = body && body.data && typeof body.data.id === "string" ? body.data.id : undefined;
		return id && SESSION_ID.test(id) ? id : undefined;
	} catch {
		// Absent daemon, refused port, foreign listener, or a non-JSON body.
		return undefined;
	}
}

async function readSessionFromDb(shareDir) {
	const dbPath = join(shareDir, "opencode.db");
	if (!existsSync(dbPath)) return undefined;

	try {
		const { Database } = await import("bun:sqlite");
		const db = new Database(dbPath, { readonly: true });
		try {
			const id = harvestNewestSessionId((sql) => db.query(sql).all());
			if (id) return id;
		} finally {
			db.close();
		}
	} catch {
		// Missing table/column, permissions, or a non-Bun runtime: fall through.
	}
	return undefined;
}

function readSessionFromDiff(shareDir) {
	const diffDir = join(shareDir, "storage", "session_diff");
	let entries;
	try {
		entries = readdirSync(diffDir);
	} catch {
		return undefined;
	}

	let newest;
	for (const name of entries) {
		if (!name.startsWith("ses_") || !name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		if (!SESSION_ID.test(id)) continue;

		let mtimeMs;
		try {
			const stats = statSync(join(diffDir, name));
			if (!stats.isFile()) continue;
			mtimeMs = stats.mtimeMs;
		} catch {
			continue;
		}
		if (!newest || mtimeMs > newest.mtimeMs) newest = { id, mtimeMs };
	}
	return newest?.id;
}

/**
 * Harvest a session id from an OpenCode store rooted at `shareDir`. Returns
 * `{ sessionId, source }` or `undefined`; every source failure is silent.
 */
export async function resolveSessionFromStore({ shareDir = openCodeShareDir() } = {}) {
	const fromDb = await readSessionFromDb(shareDir);
	if (fromDb) return { sessionId: fromDb, source: "opencode.db" };

	const fromDiff = readSessionFromDiff(shareDir);
	if (fromDiff) return { sessionId: fromDiff, source: "session-diff" };

	return undefined;
}

/** Verde (bun-upgrades S2): precedence is user override, then the
 *  Pi-harvested id, then the local server, then the relay's local store.
 *  Exported for tests; takes the store root and the minter as arguments so
 *  tests can inject a temp store and a fake server. */
// ---------------------------------------------------------------------------
// Generating the session id (gate-decode S8)
// ---------------------------------------------------------------------------
//
// OpenCode builds its session ids in `packages/schema/src/identifier.ts`:
//
//     current = BigInt(timestamp) * 0x1000n + BigInt(counter)
//     value   = descending ? ~current : current
//     id      = "ses_" + sixHexBytes(value) + fourteenBase62(random)
//
// Reproduced against eight real ids read from `session_v2`: all eight matched
// once the timestamp was allowed to sit up to 12 ms before `time_created`, which
// is just the row being inserted after the id is made. So the generator is the
// source of truth, and every other source — `service.json`, the local API, the
// SQLite scrape — was an approximation of it. This needs no daemon, no store, no
// running OpenCode and no binary to ship.
//
// It also corrects an earlier reading of the measurements: `ses_` plus 26 base62
// characters is NOT sufficient, because the first twelve must be hex. The
// negative probes used non-hex characters (`ses_ZZZZ…`), so they failed as
// malformed rather than as unregistered.
const SESSION_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastSessionIdMs = 0;
let sessionIdCounter = 0;

/** Reproduces OpenCode's own session id byte for byte.
 *
 *  The counter disambiguates ids minted inside the same millisecond, exactly as
 *  the original does, so a burst never collides. `random` is injectable so a
 *  test can pin the suffix while keeping the encoded prefix observable. */
export function generateSessionId(
	timestamp = Date.now(),
	random = (bytes) => crypto.getRandomValues(bytes),
) {
	if (timestamp !== lastSessionIdMs) {
		lastSessionIdMs = timestamp;
		sessionIdCounter = 0;
	}
	sessionIdCounter++;
	const current = BigInt(timestamp) * 0x1000n + BigInt(sessionIdCounter);
	const value = ~current;
	let out = "";
	for (let index = 0; index < 6; index++) {
		out += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0");
	}
	for (const byte of random(new Uint8Array(14))) out += SESSION_ID_ALPHABET[byte % 62];
	return "ses_" + out;
}

export async function resolveRelaySession({
	shareDir,
	mintSession = mintSessionFromService,
} = {}) {
	// Precedence (bun-upgrades S2): user override, then the id the extension
	// harvested on Pi's machine (works when OpenCode lives elsewhere), then the
	// relay's own local store (same machine as OpenCode).
	const override = process.env.RELAY_SESSION?.trim();
	if (override) {
		const declared = process.env.RELAY_SESSION_SOURCE;
		return { sessionId: override, source: declared === "config" ? "config" : "env" };
	}
	// The id the Pi extension harvested on its own machine (open-code store not
	// necessarily local). It wins over a relay-local harvest but never over a
	// user override, and it is reported with its own source for the doctor.
	const fromPi = process.env.RELAY_SESSION_PI?.trim();
	if (fromPi && /^ses_/.test(fromPi)) {
		return { sessionId: fromPi, source: "pi-harvest" };
	}
	// Gate-decode S4: ask the server before scraping the store. Its id is
	// registry-backed, so it survives even a store the bridge cannot read, and it
	// never depends on a table name OpenCode renames. A missing daemon here is not
	// an error: the store harvest below is the fallback, unchanged.
	const minted = await mintSession();
	if (minted && SESSION_ID.test(minted)) {
		return { sessionId: minted, source: "service" };
	}
	// Gate-decode S8: nothing to harvest, so generate. The id is the one OpenCode
	// itself would have written, which means a machine that has never installed
	// OpenCode now starts the relay instead of failing with advice to run it.
	const fromStore = await resolveSessionFromStore(shareDir ? { shareDir } : {});
	if (fromStore?.sessionId) return fromStore;
	return { sessionId: generateSessionId(), source: "generated" };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const SERVICE = "pi-free-bridge-relay";
const DEFAULT_PORT = 8788;
const DEFAULT_UPSTREAM = "https://opencode.ai/inference/v1";
const DEFAULT_USER_AGENT = "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

function sendJson(res, status, payload) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Egress selection (bun-upgrades S5): off | auto | on
// ---------------------------------------------------------------------------
//
//   off   — every request goes direct (unchanged behavior).
//   auto  — direct first; a rate limit (429) received before the first
//           downstream byte retries through WARP. When a request only succeeds
//           through WARP, the relay prefers WARP from then on (with local as
//           the backoff so a dead WARP cannot brick the bridge).
//   on    — every request goes through WARP.
//
// Failover NEVER happens after the first downstream byte: an SSE stream cannot
// be replayed, a mid-stream retry corrupts it. `warp-minimal` listens on
// 127.0.0.1:8789 (upstream env RELAY_WARP_PROXY).

const WARP_PROXY_DEFAULT = "http://127.0.0.1:8789";
/** warp-minimal's health path when the shared config does not name one. The
 *  configured value arrives as `RELAY_WARP_HEALTH_PATH` (S14), so `/health`
 *  only exists here as the last resort, never as a second source of truth. */
const WARP_HEALTH_PATH_DEFAULT = "/health";

/** Allowed modes, exported for validation in the extension config too. */
export const WARP_MODES = ["off", "auto", "on"];

function normalizeWarpMode(value) {
	const mode = String(value ?? "").trim().toLowerCase();
	return WARP_MODES.includes(mode) ? mode : undefined;
}

/** Pure: the egress order for one request. A parked local egress is
 *  deprioritised, not excluded: a rejected request costs no quota (S4), so
 *  local stays in the chain as the last resort when WARP is down. Excluding it
 *  would turn a burnt local IP into a hard 502 for the rest of the window. */
export function egressOrder(mode, warpPreferred, localParked = false) {
	if (mode === "on") return ["warp"];
	if (mode === "auto") return warpPreferred || localParked ? ["warp", "local"] : ["local", "warp"];
	return ["local"];
}

/** The margin added on top of `retry-after`. The reset lands on a whole second
 *  and the gate's clock is not ours, so the last second of the window is not
 *  worth gambling a request on. */
export const PARK_MARGIN_MS = 10_000;

/** Pure: how long the local egress stays parked, derived from its own 429.
 *  A missing or non-integer `retry-after` parks nothing: guessing the reset is
 *  the exact bug this replaces (S16). */
export function parkDurationMs(retryAfter) {
	const raw = String(retryAfter ?? "").trim();
	if (!/^\d+$/.test(raw)) return undefined;
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(seconds)) return undefined;
	return seconds * 1000 + PARK_MARGIN_MS;
}

/** Pure: the next warp preference after one request.
 *  `used` names the egress that produced the final response, `status` is that
 *  response's own HTTP status: only a success may elevate warp. Taking the
 *  status rather than a boolean keeps the call site from hardcoding "ok",
 *  which is exactly how a delivered 429 used to pin warp as preferred. */
export function updateWarpPreference(mode, used, status) {
	if (mode !== "auto") return false;
	if (!(typeof status === "number" && status < 400)) return false;
	return used === "warp";
}

// ---------------------------------------------------------------------------
// S7 (warp-minimal WireGuard migration): network-error fallback for mode "on"
// ---------------------------------------------------------------------------
//
// When warpMode is "on" every request goes through WARP. If WARP fails with a
// network/socket error (not an HTTP 429/403 quota error) the relay falls back
// to the local egress so the client does not get a 502. Failover never happens
// after the first downstream byte: this only applies while the fetch itself
// rejects (nothing has been delivered to the client yet).

const NETWORK_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNABORTED",
	"ENETUNREACH",
	"ENETDOWN",
	"EHOSTUNREACH",
	"ENOTCONN",
]);

/** Pure: true when `err` is a network/socket failure (not an HTTP status). */
export function isNetworkError(err) {
	if (!err) return false;
	const code = err && err.code ? String(err.code).toUpperCase() : "";
	if (NETWORK_ERROR_CODES.has(code)) return true;
	const name = err && err.name ? String(err.name) : "";
	if (name === "AbortError") return true; // fetch timeout / aborted request
	const msg = String(err && err.message ? err.message : err).toLowerCase();
	return /network|socket|connection refused|connection reset|timed out|aborted|getaddrinfo|failed to fetch|fetch failed|fetch:/.test(msg);
}

// Process-level stickiness for `auto`: once WARP was the only working path,
// later requests try it first.
let warpPreferred = false;
let lastEgress = undefined;

/** Pure: the upstream headers for one egress attempt. `wireMode` "v2" adds the
 *  three headers the v2 client sends besides the v1 set
 *  (packages/core/src/session/model-request.ts:313-324). For a root session
 *  `affinity` is the session id, so both headers carry it. Default "v1" is
 *  byte-identical to the previous behaviour. */
export function egressHeaders(config) {
	const headers = {
		"content-type": "application/json",
		"user-agent": config.userAgent,
		authorization: `Bearer ${config.apiKey}`,
		"x-opencode-session": config.session,
		"x-opencode-session-id": config.session,
	};
	if (config.wireMode === "v2") {
		headers["x-session-affinity"] = config.session;
		headers["X-Session-Id"] = config.session;
		headers["x-opencode-client"] = "opencode";
	}
	return headers;
}

function egressFetch(config, pathname, { body }, egress) {
	const opts = {
		method: "POST",
		headers: egressHeaders(config),
		body,
	};
	if (egress === "warp") opts.proxy = config.warpProxy;
	return fetch(toUpstreamUrl(config.upstream, pathname), opts);
}

/** Pure: per-request warp mode (relay-warp-hot-reload). Precedence: the
 *  normalized env override, then the normalized value from the config file,
 *  then "off". Exported for tests. */
export function resolveWarpModeHot(override, fileValue) {
	return normalizeWarpMode(override) ?? normalizeWarpMode(fileValue) ?? "off";
}

/** Normalize a wire mode: "v1" | "v2", or undefined for anything else. */
export function normalizeWireMode(value) {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return text === "v1" || text === "v2" ? text : undefined;
}

/** Per-request wire mode (relay-wire-hot-reload). Precedence: the env override,
 *  then the extension's config file, then "v1" — the header set every shipped
 *  install already sends, so an absent field changes nothing. */
export function resolveWireModeHot(override, fileValue) {
	return normalizeWireMode(override) ?? normalizeWireMode(fileValue) ?? "v1";
}

/** The `wireMode` field of the extension's config file, or undefined on any
 *  missing/foreign/malformed file. Never throws, so the caller keeps the last
 *  known mode. */
export function readFileWireMode(path) {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
		return normalizeWireMode(parsed && typeof parsed === "object" ? parsed.wireMode : undefined);
	} catch {
		return undefined;
	}
}

/** Read the extension's persisted config file and return its normalized warp
 *  mode, or undefined on any missing/foreign/malformed file so the caller can
 *  keep the last known mode. Never throws. */
export function readFileWarpMode(path) {
	try {
		const raw = readFileSync(path, "utf8");
		// Strip a UTF-8 BOM (Windows editors) so JSON.parse cannot reject the file.
		const parsed = JSON.parse(raw.startsWith("﻿") ? raw.slice(1) : raw);
		const value =
			parsed && typeof parsed === "object" ? parsed.warpEnabled ?? parsed.warpMode : undefined;
		return normalizeWarpMode(value);
	} catch {
		return undefined;
	}
}

/** Hot reload (relay-warp-hot-reload): re-read the warp mode from the config
 *  file the extension points at via RELAY_CONFIG_PATH. A read/parse failure
 *  keeps the last known mode and never crashes the request; it warns at most
 *  once for the life of the process. A RELAY_WARP_MODE env override is
 *  absolute and pins the mode (source "env", by design). */
let warpConfigWarned = false;
function refreshWarpMode(config) {
	if (config.warpModeSource === "env" || !config.warpConfigPath) return;
	const fileMode = readFileWarpMode(config.warpConfigPath);
	if (fileMode) {
		config.warpMode = fileMode;
		return;
	}
	if (!warpConfigWarned) {
		warpConfigWarned = true;
		process.stderr.write(
			`pi-free-bridge relay: could not read a warp mode from ${config.warpConfigPath} — ` +
				`keeping ${config.warpMode}\n`,
		);
	}
}

/* relay-warp-auto-recycle (user-approved): the opencode free gate counts quota
 *  per (session, egress IP) and per UTC day, so a warp 429 means that exit IP
 *  burnt its day and only the proxy can re-enroll it. The streak that detects it
 *  counts 429s OBSERVED on the warp egress; `bumpWarp429Streak` and
 *  `needsWarpRecycle` below are the whole policy, and S12 left no timer in it:
 *  the measurement (18 enrollments in 55 minutes, never a rate-limit refusal)
 *  says a cool-down only ever blocks a recovery that would have worked. What
 *  serializes a rotation is single-flight, which is mutual exclusion, not a
 *  clock. */

/** Pure: the proxy's health URL. The path is warp-minimal's own (`health_path`
 *  in its config, handed over as `RELAY_WARP_HEALTH_PATH`); a missing or
 *  shapeless value falls back to the documented default, because probing an
 *  invented route forwards it upstream and kills the exit (L27). */
export function warpHealthUrl(proxy, path) {
	const base = String(proxy ?? "").trim().replace(/\/+$/, "") || WARP_PROXY_DEFAULT;
	const healthPath = typeof path === "string" && path.startsWith("/") ? path : WARP_HEALTH_PATH_DEFAULT;
	return `${base}${healthPath}`;
}

/** Pure: reduce a /health body to the two fields the poll reads. A body that is
 *  not an object (an HTML error page, an array) is not a health report at all.
 *  An exit entry is the name followed by its live state
 *  (`warp-18e4af... (in_use, streams=1)`), so the name is the whole identity:
 *  keeping the annotation would make a stream count that moved from 1 to 2 look
 *  like a brand new exit and confirm a rotation that never ran. */
export function warpHealthState(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const exits = Array.isArray(body.exits)
		? body.exits
				.filter((exit) => typeof exit === "string")
				.map((exit) => exit.trim().split(/[\s(]/, 1)[0])
				.filter((name) => name.length > 0)
		: [];
	return { recycling: body.recycling === true, exits };
}

/** Pure: did the recycle actually replace an exit (S6)? `recycling: false` is
 *  the resting state of a healthy pool, so it proves nothing on its own. The
 *  primary proof is the recycle window being observed at least once during the
 *  poll. The secondary one is an exit NAME absent from the pre-POST snapshot:
 *  names are compared, never the raw label, because the label carries the
 *  live state (`streams=1` -> `streams=2`) and that changes constantly. For
 *  this proxy the name is a fixed pool label too (L26), so that branch is only
 *  a fallback for a proxy whose exits do have distinct names. */
export function isRotationConfirmed(before, health, seenRecycling) {
	if (!health || typeof health !== "object") return false;
	if (health.recycling === true) return false;
	const current = Array.isArray(health.exits) ? health.exits : [];
	if (current.length === 0) return false;
	if (seenRecycling === true) return true;
	// No usable snapshot means no evidence, so a rotation without one is only
	// confirmable through the observed recycle window.
	const known = before && Array.isArray(before.exits) ? new Set(before.exits) : undefined;
	if (!known) return false;
	return current.some((exit) => !known.has(exit));
}

// ---------------------------------------------------------------------------
// Slice 2 — attribution, and the tunnel -> exit map it feeds (S6)
// ---------------------------------------------------------------------------
//
// The relay cannot see the CONNECT at all: Bun owns it, and `fetch({proxy})`
// exposes neither the CONNECT request nor its response headers (measured, not
// assumed). So `X-Warp-Exit` is invisible from here, and the only channel left
// is the proxy's own `/health` report.
//
// Since slice 2 that report publishes each exit as
// `<full id> (<state>, served=N, streams=N)` — always the three fields, in that
// order, no optional ones. `served` counts the CONNECT tunnels that exit
// established and never resets while the exit lives, so a delta between two
// snapshots is the one honest way to learn which exit served a request.
//
// Two consequences shape everything below. First, a counter, not a request: one
// tunnel carries many requests, so the relay learns ONCE and then reuses the
// answer (Bun reuses the tunnel — three requests, one CONNECT, measured).
// Second, the counter belongs to the EXIT, not to us: any other process on this
// machine opening a tunnel through the same proxy moves it too. That is why the
// map refuses to re-learn while it holds an answer it can still trust.

/** Pure: reduce a /health body to its exits with their counters. An older
 *  proxy publishes no `served`, which stays `undefined` rather than defaulting
 *  to zero: "no evidence" and "zero tunnels" are different answers, and only
 *  the first one forbids learning the map. */
export function warpExitSnapshot(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const exits = [];
	for (const entry of Array.isArray(body.exits) ? body.exits : []) {
		if (typeof entry !== "string") continue;
		const open = entry.indexOf("(");
		const id = (open === -1 ? entry : entry.slice(0, open)).trim();
		if (!id) continue;
		const inner = open === -1 ? "" : entry.slice(open + 1, entry.lastIndexOf(")"));
		const fields = inner
			.split(",")
			.map((field) => field.trim())
			.filter((field) => field.length > 0);
		const counter = (name) => {
			const field = fields.find((candidate) => candidate.startsWith(`${name}=`));
			if (!field) return undefined;
			const value = Number.parseInt(field.slice(name.length + 1), 10);
			return Number.isInteger(value) ? value : undefined;
		};
		exits.push({
			id,
			state: fields.length > 0 ? fields[0] : undefined,
			served: counter("served"),
			streams: counter("streams"),
		});
	}
	// The pool's own count of exits that can serve new work. A body without it
	// stays `undefined`: "no count" and "no healthy exit" are different answers,
	// and only the caller knows which policy the first one deserves.
	const healthy = Number.isInteger(body.healthy) && body.healthy >= 0 ? body.healthy : undefined;
	return { recycling: body.recycling === true, exits, healthy };
}

/** Pure: is any exit in this snapshot parked (S13)? An exit in `cooldown` was
 *  parked by the proxy for 30 minutes after it burnt its quota, and the parks
 *  are only cleared by enrolling fresh exits — a targeted swap replaces one exit
 *  and leaves every park in place. So a parked pool is the recycle's case, in the
 *  manual sweep and in the automatic ladder alike. */
export function hasParkedExit(snapshot) {
	return Boolean(
		snapshot &&
			Array.isArray(snapshot.exits) &&
			snapshot.exits.some((exit) => exit && exit.state === "cooldown"),
	);
}

/** Pure: what moved between two snapshots. Only exits present in BOTH are
 *  compared: the contract guarantees a NEW id per enrollment, so a fresh id
 *  starts from zero and comparing it against nothing would invent a delta. A
 *  single exit that advanced by exactly one tunnel is the only learnable
 *  answer; two exits, or one that jumped by more, mean the window saw tunnels
 *  that may not be ours, and that must never be guessed around. */
export function servedDelta(before, after) {
	const result = { learned: undefined, changed: [], gone: [], unchanged: true, ambiguous: false };
	if (!after || !Array.isArray(after.exits)) return result;
	const prior = new Map();
	if (before && Array.isArray(before.exits)) {
		for (const exit of before.exits) prior.set(exit.id, exit.served);
	}
	for (const exit of after.exits) {
		if (!prior.has(exit.id)) continue;
		const was = prior.get(exit.id);
		if (typeof was !== "number" || typeof exit.served !== "number") continue;
		if (exit.served > was) result.changed.push({ id: exit.id, delta: exit.served - was });
	}
	const alive = new Set(after.exits.map((exit) => exit.id));
	for (const id of prior.keys()) if (!alive.has(id)) result.gone.push(id);
	result.unchanged = result.changed.length === 0;
	result.ambiguous =
		result.changed.length > 1 || (result.changed.length === 1 && result.changed[0].delta !== 1);
	if (!result.ambiguous && result.changed.length === 1) result.learned = result.changed[0].id;
	return result;
}

/** Pure: the tunnel -> exit map, and the policy that keeps it honest (D8).
 *  `mapValid` is the caller's statement that the exit it holds still exists and
 *  was not just swapped — when it is false the previous answer is dead and a
 *  single delta is the new truth. While the map is valid the answer is sticky:
 *  our tunnel is reused, so its counter must not move, and any movement is
 *  either foreign traffic (another exit, keep ours) or a contradiction (our own
 *  exit, drop it). Ambiguity drops it too. Dropping is cheap and self-healing:
 *  an empty map is learned again on the next window, and until then the caller
 *  does not rotate at all. */
export function updateTunnelExit(previous, delta, { mapValid = false } = {}) {
	if (!delta || delta.unchanged) return { exitId: previous, decision: "kept" };
	if (delta.ambiguous) return { exitId: undefined, decision: "knockout" };
	if (!delta.learned) return { exitId: previous, decision: "kept" };
	if (!previous || mapValid === false) return { exitId: delta.learned, decision: "learned" };
	if (delta.learned === previous) return { exitId: undefined, decision: "knockout" };
	return { exitId: previous, decision: "ignored_foreign" };
}

/** How short a `retry-after` makes waiting cheaper than re-enrolling. A swap
 *  spends one Cloudflare enrollment, and under a 429 storm enrollments are the
 *  scarce thing, so a window measured in seconds is not worth one. */
const SWAP_MIN_RETRY_AFTER_MS = (() => {
	const n = Number.parseInt(process.env.RELAY_WARP_SWAP_MIN_RETRY_AFTER_MS ?? "", 10);
	return Number.isInteger(n) && n >= 0 ? n : 120_000;
})();

/** Pure: whether the ladder may spend a targeted swap on this 429 (S7, S9).
 *  No attributed exit means no target, and rotating without a target is the
 *  blind swap the proxy's own contract warns against (the body-less default
 *  picks by live streams, and by the time we decide the culprit is idle). */
export function decideWarpSwap({
	exitId,
	retryAfterMs,
	enabled = true,
	unavailable = false,
	inFlight = false,
	healthy,
	parked = false,
	shortWindowMs = SWAP_MIN_RETRY_AFTER_MS,
} = {}) {
	if (unavailable) return { swap: false, reason: "unavailable" };
	if (!enabled) return { swap: false, reason: "disabled" };
	// S13: a parked exit is a pool-level fact, so it is judged before the target
	// is: no exit the swap could name is the reason the pool is empty, and only
	// fresh enrollments clear the 30 minute parks a swap never touches.
	if (parked) return { swap: false, reason: "cooldown" };
	if (!exitId) return { swap: false, reason: "no_attribution" };
	// The swap drains the exit that served the 429, so it may only run while the
	// pool still has a standby to serve the retry: draining the last serving exit
	// would trade a 429 for a dead pool. Only a count is judged here, so a caller
	// that could not read the pool passes `0` and an unknown pool is not a standby
	// either — when in doubt, do not rotate.
	if (healthy !== undefined && !(healthy >= 2)) return { swap: false, reason: "no_standby" };
	// S12: single-flight, never a cool-down. A second 429 is a second signal, and
	// a timer here only ever blocked a recovery that would have worked.
	if (inFlight) return { swap: false, reason: "in_flight" };
	if (typeof retryAfterMs === "number" && retryAfterMs >= 0 && retryAfterMs < shortWindowMs) {
		return { swap: false, reason: "short_retry_after" };
	}
	return { swap: true, reason: "ok" };
}

/** Pure: S10's kill switch. Only an explicit `0` turns the swap off; unset,
 *  empty or garbage all mean "on", so a typo cannot silently disable the
 *  ladder and leave the user back where this slice started. */
export function warpSwapEnabled(value) {
	return String(value ?? "").trim() !== "0";
}

/** Pure: S18's kill switch. Only an explicit `0` turns the resend off; unset,
 *  empty or garbage all mean "on", so a typo cannot silently disable it. */
export function warpResendEnabled(value) {
	return String(value ?? "").trim() !== "0";
}

const WARP_RESEND_ENABLED = warpResendEnabled(process.env.RELAY_WARP_RETRY_AFTER_RECYCLE);
const WARP_SWAP_ENABLED = warpSwapEnabled(process.env.RELAY_WARP_SWAP);
/** A rotation takes ~4s end to end (L26). 10s covers a slow enroll without
 *  holding the client past its own patience. */
const ROTATION_TIMEOUT_MS = 10_000;
const ROTATION_POLL_MS = 250;
let rotationTimeoutMs = ROTATION_TIMEOUT_MS;
let rotationPollMs = ROTATION_POLL_MS;

/** Pure: only WARP-egress outcomes move the streak — a warp 429 extends it and
 *  a warp success resets it. LOCAL results say nothing about the exit IP: a
 *  local 429 is not exit evidence, and the local fallback 200 that delivered
 *  the response must not erase the warp 429s observed before it. */
export function bumpWarp429Streak(streak, status, egress) {
	if (egress !== "warp") return streak;
	if (status === 429) return streak + 1;
	if (typeof status === "number" && status < 400) return 0;
	return streak;
}

/** Pure: the cause the relay can actually justify when the gate answers 429.
 *
 *  The vendor returns `FreeUsageLimitError` for three unrelated conditions: an
 *  unknown session id, a contract violation (user-agent or the `<env>` block),
 *  and a real daily quota. `retry-after` is identical for all three — measured
 *  2026-11-12, an id the registry never issued carried the same 00:00-UTC
 *  window as an exhausted quota — so a 429 on its own confirms nothing.
 *
 *  Ranked by the evidence the relay holds, never by the vendor's label:
 *  - the local egress is parked after burning its own quota: that IS the answer,
 *    and reporting "undetermined" while the relay has already parked the exit
 *    hides the one fact it knows for certain.
 *  - two consecutive warp 429s: the exit is not the variable, so rotating is
 *    not the answer; the id or the contract is.
 *  - an id the relay could not vouch for (`env`, `config`): suspect, because a
 *    stale or fabricated `ses_` id fails exactly like a spent quota.
 *  - otherwise: undetermined. One rotation separates quota from the rest, and
 *    reporting "quota" before it is the false negative that cost this project
 *    five chained diagnoses. */
export function classifyGate429({ sessionSource, warp429Streak = 0, parkedSeconds = 0 } = {}) {
	if (parkedSeconds > 0) {
		return {
			cause: "egress_parked",
			detail: `the local egress spent its own free quota and stays parked for another ${parkedSeconds}s: route through warp or wait, and stop suspecting the id`,
		};
	}
	if (warp429Streak >= 2) {
		return {
			cause: "not_egress",
			detail:
				"two warp 429s in a row: the exit is not the variable, so check the session id or the request contract",
		};
	}
	if (sessionSource === "env" || sessionSource === "config") {
		return {
			cause: "session_suspect",
			detail:
				"the session id was not issued by the local server, and a stale or fabricated one fails exactly like a spent quota",
		};
	}
	return {
		cause: "undetermined",
		detail:
			"quota, session id or contract: rotate once to separate quota from the rest, and do not report quota before that",
	};
}

/** Pure: rotate on the first warp 429 of a burst. S12 removed the cool-down,
 *  so there is nothing left to skip on: a second 429 is a second signal, and
 *  the rotation is guarded by single-flight, not by a clock. */
export function needsWarpRecycle(streak) {
	return streak > 0;
}

let warp429Streak = 0;
let warpRecycles = 0;
let warpResends = 0;
let warpRecycleInFlight = false;
let warpRecycleUnavailableWarned = false;
let warpSwapInFlight = false;
let warpSwaps = 0;
// The proxy answered that it has no /swap at all — an older binary, or one
// running the WireGuard stack, where the route is a 501. Nothing about the exit
// is wrong in that case, so retrying would be a routine for the life of the
// process: the ladder steps aside once and stays aside.
let warpSwapUnsupported = false;
let warpSwapUnsupportedWarned = false;
// Two stranded swaps in a row are not one exit having a bad day: the pool is not
// coming back on its own, so the ladder stops attempting targeted swaps for the
// rest of the process. A swap that does settle proves the pool can still
// replace what the ladder drains, so the streak starts over.
let warpSwapStrandedStreak = 0;
// S14: how many usable exits the pool had when the last accepted swap went out,
// judged on the NEXT ladder run and never inline. A real drain takes up to 120s
// (measured `20:37:18` asked -> `20:39:18` drained), so no wait inside the
// request can conclude that the drained exit did not come back; only the next
// look can. The measurement is a COUNT, never an identity: a re-enrolment
// publishes a NEW id (E7), so the absence of the drained id is no evidence of
// anything and would call every successful swap a stranding. `undefined` means
// "no swap to judge", which is also the state a verdict leaves behind.
let warpSwapPoolBefore = undefined;
// Test-only mirror of `RELAY_WARP_SWAP`, which is read once at load.
let warpSwapEnabledOverride = true;
// The exit the relay believes its own tunnel rides on, learned from the
// proxy's `served` counter. `undefined` means "unknown", and unknown is a
// decision on its own: the ladder does not rotate without a target.
let tunnelExit = undefined;
// S16/S17: when the LOCAL egress gets a 429, that IP spent its day. The header
// says when it resets, so local stops being offered first until then. In memory
// only — a restart re-learns it with one request that costs no quota (S4).
let localParkedUntil = 0;

// How many responses we are DELIVERING right now over the warp tunnel — not how
// many requests are in flight. The distinction is the whole point: a rotation
// replaces the exit, and that kills every stream multiplexed over it. A response
// we already hold has passed the gate and will complete on its own, so it is
// worth protecting. A request still waiting for headers on a burnt IP will get
// its own 429 no matter what we do, so waiting for that one buys nothing.
// Counting ours is also the only honest source: the proxy publishes
// `streams=N`, but it lags (it reports 1 on an idle bridge).
let deliveringWarpStreams = 0;

/** The valve on the drain wait, and it is a valve, not a budget. The wait itself
 *  has no clock: a peer that takes 40s to finish gets its 40s. This only exists
 *  so a stream that hangs forever cannot trap the request that ate the 429 — Pi
 *  gives up at 5 minutes, so 2 of them is already past the point of no return
 *  and well short of losing both turns. */
const DRAIN_VALVE_MS = 120_000;
const DRAIN_POLL_MS = 50;
let drainValveMs = DRAIN_VALVE_MS;

// ---------------------------------------------------------------------------
// Warp event log (S1, S2)
// ---------------------------------------------------------------------------
//
// Every warp decision that costs something — a 429 observed, a rotation asked
// for, the drain that refused to let it run, the exit that came back — is
// written as one JSON object per line. This exists because the relay writes its
// diagnostics to stderr, and stderr goes to a pipe the parent drains: when a
// turn dies the evidence dies with it. A file survives.
//
// What is never written: request bodies, headers, prompts, or the gate's error
// body. Those are the user's content. An event records the decision, not the
// traffic.

/** The size at which the log rolls. One file plus one `.1` is already weeks of
 *  incidents; an unbounded file is unreadable exactly when it is needed. */
export const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/** Pure: one log record. `JSON.stringify` escapes newlines, so a reason that
 *  carries one can never forge a second event. */
export function logLine(ev, fields = {}, now = Date.now()) {
	return `${JSON.stringify({ t: new Date(now).toISOString(), ev, ...fields })}\n`;
}

/** Pure: whether the live file has to roll before the next record. An
 *  unreadable size (`NaN`) never rolls — a log that cannot measure itself is not
 *  a reason to throw away the incident being written. */
export function shouldRotateLog(size, limit = LOG_LIMIT_BYTES) {
	return Number.isFinite(size) && size >= limit;
}

/** Build the writer. No path means no file and no work at all: the log is
 *  opt-in (`RELAY_LOG_FILE`), and an unset value must cost nothing on the
 *  request path. Every failure is swallowed on purpose — a full disk is not a
 *  reason to fail a user's turn. */
export function makeEventLogger(file, { limit = LOG_LIMIT_BYTES, now = Date.now } = {}) {
	const path = String(file ?? "").trim();
	if (!path) return () => {};
	let size;
	const measure = () => {
		if (size !== undefined) return;
		try {
			size = statSync(path).size;
		} catch {
			size = 0;
		}
	};
	return (ev, fields) => {
		try {
			measure();
			if (shouldRotateLog(size, limit)) {
				// Windows refuses `rename` onto an existing name, so the kept
				// generation is removed first: the contract is one `.1`, always.
				try {
					rmSync(`${path}.1`, { force: true });
				} catch {
					/* best effort: a missing previous generation is the normal case */
				}
				renameSync(path, `${path}.1`);
				size = 0;
			}
			const line = logLine(ev, fields, now());
			appendFileSync(path, line);
			size += Buffer.byteLength(line);
		} catch {
			/* a log that cannot write must never fail a request */
		}
	};
}

let logWarpEvent = makeEventLogger(process.env.RELAY_LOG_FILE);

// ---------------------------------------------------------------------------
// Manual rotation (S3)
// ---------------------------------------------------------------------------
//
// The relay binds 127.0.0.1 only (`server.listen(port, "127.0.0.1")`), so a
// control route is loopback by construction and needs no token: the only peer
// that can reach it is a process on this machine.

/** Pure: the one control request the relay answers. Anything that is not an
 *  exact match keeps flowing to the proxy path — a control route that matched by
 *  prefix would eat a user request. */
export function warpControlRoute(method, pathname) {
	if (method === "POST" && pathname === "/warp/recycle") return "recycle";
	return undefined;
}

/** Best-effort: why a manual rotation was refused. The authoritative trace of
 *  the decision is the event log (`rotate_skipped` with its reason); this only
 *  spares the caller from reading the log for the common cases. The drain is not
 *  one of them: it never refuses on its own — a valve that expires lets the
 *  rotation run, because a hung stream must not trap the request that ate the
 *  429. */
function refusalReason(config, inFlightBefore, rotated) {
	if (rotated) return undefined;
	if (inFlightBefore || warpRecycleInFlight) return "in_flight";
	if (!config.warpProxy) return "no_proxy";
	return "not_confirmed";
}

/** Pure: the order the manual sweep drains exits in (S11). The exit the proxy
 *  publishes as `in_use` goes first — it is the one serving the burst that
 *  prompted the command — and the rest follow in snapshot order. An exit the
 *  proxy already parked (`cooldown`) or is draining is never a target: asking to
 *  swap one spends a POST to be told no. */
function sweepTargets(snapshot) {
	if (!snapshot || !Array.isArray(snapshot.exits)) return [];
	const candidates = snapshot.exits.filter(
		(exit) => exit.id && exit.state !== "cooldown" && exit.state !== "draining",
	);
	const inUse = candidates.filter((exit) => exit.state === "in_use");
	return [...inUse, ...candidates.filter((exit) => exit.state !== "in_use")];
}

/** S11: the manual recovery, by the CHEAPEST step first, reported per step.
 *
 *  One usable exit means there is no standby, so the only step that can work is
 *  the recycle. Otherwise the sweep drains exits one at a time, `in_use` first,
 *  and stops as soon as one usable exit remains: draining every exit at once is
 *  what emptied the pool (`acquire failed: no WARP exit available (all cooling
 *  down or starting)`). Two consequences of that rule:
 *
 *  - A two-exit pool spends exactly ONE swap per invocation and a three-exit
 *    pool at most two. The bound is the pool the sweep STARTED from, never the
 *    live count: the drain is asynchronous and the proxy may keep reporting the
 *    drained exit for up to 120s (S14), so following the live number would sweep
 *    the whole pool in one run.
 *  - Nothing waits for a drain to settle. The id of the exit that was drained is
 *    usable state for the report; the settle verdict belongs to a later
 *    automatic run (`judgeStrandedWarpSwap`), never to this command.
 *
 *  S13: a pool holding a parked exit goes to the recycle in either branch — the
 *  swap replaces one exit and leaves the 30 minute parks in place, while fresh
 *  enrollments are the only thing that clears them.
 *
 *  A refused swap (409 no standby, or a proxy without the route) STOPS the
 *  sweep: insisting spends enrollments on a pool that just said no, and falling
 *  back to the recycle in the same run is only allowed when the pool itself was
 *  the reason (the single-exit branch above). */
export async function manualWarpRecycle(config) {
	const inFlightBefore = warpRecycleInFlight;
	// One pool read decides the cheapest step, and the same read is the
	// pre-POST snapshot the rotation confirms against. With no proxy there is no
	// pool to read, and the rotation below reports `no_proxy` on its own.
	const snapshot = config.warpProxy ? await readWarpSnapshot(config) : undefined;
	const parked = hasParkedExit(snapshot);
	const startUsable = usableExitCount(snapshot);
	const steps = [];
	let current = snapshot;
	let reason;

	if (parked || !(startUsable >= 2)) {
		if (parked) logWarpEvent("manual_sweep_skip_swap", { reason: "cooldown" });
		const rotation = await runWarpRotation(config, undefined, snapshot);
		reason = refusalReason(config, inFlightBefore, rotation.rotated);
		steps.push({
			action: "recycle",
			outcome: rotation.rotated ? "accepted" : reason === "not_confirmed" ? "refused" : "degraded",
			// No rotation, no new observation: the last count read is the honest one.
			usable: rotation.usable ?? usableExitCount(current) ?? null,
		});
	} else {
		const targets = sweepTargets(snapshot);
		const budget = Math.max(0, startUsable - 1);
		for (let index = 0; index < budget; index += 1) {
			const target = targets[index];
			if (!target) break;
			// Never start a swap that would leave zero usable exits.
			if (!(usableExitCount(current) >= 2)) break;
			const swap = await swapWarpExit(config, target.id);
			if (swap.swapped) {
				// The step is judged by the pool it left behind, so the pool is re-read
				// after every ACCEPTED swap and the sweep stops at one usable exit.
				const next = await readWarpSnapshot(config);
				if (next) current = next;
			}
			steps.push({
				action: "swap",
				exit: target.id,
				outcome: swap.swapped ? "accepted" : swap.reason === "unavailable" ? "degraded" : "refused",
				usable: usableExitCount(current) ?? null,
			});
			if (!swap.swapped) {
				reason = swap.reason;
				break;
			}
		}
	}

	const rotated = steps.some((step) => step.action === "recycle" && step.outcome === "accepted");
	const result = {
		ok: steps.length > 0 && steps.every((step) => step.outcome === "accepted"),
		rotated,
		steps,
		usable: usableExitCount(current) ?? null,
		warpMode: config.warpMode,
		warpRecycles,
		warp429Streak,
		delivering: deliveringWarpStreams,
	};
	if (reason) result.reason = reason;
	logWarpEvent("manual_sweep", {
		steps: steps.map((step) => ({
			action: step.action,
			...(step.exit ? { exit: step.exit } : {}),
			outcome: step.outcome,
			usable: step.usable,
		})),
		usable: result.usable,
		...(reason ? { reason } : {}),
	});
	return result;
}

// ---------------------------------------------------------------------------
// Test-only hooks (test/relay.test.mjs)
// ---------------------------------------------------------------------------
// The relay reaches the network through the global `fetch` and keeps the warp
// counters in module state, so the request path is testable under plain Node by
// swapping one and reading the other. Nothing in the relay calls what follows:
// it exists only so a test can start from a known state, shrink the 10s window
// and see the numbers `/health` would publish.

/** Test-only: reset the module-level warp state between cases. */
export function resetWarpStateForTests() {
	warp429Streak = 0;
	warpRecycles = 0;
	warpRecycleInFlight = false;
	warpResends = 0;
	warpSwapInFlight = false;
	warpSwaps = 0;
	warpSwapUnsupported = false;
	warpSwapUnsupportedWarned = false;
	warpSwapStrandedStreak = 0;
	warpSwapPoolBefore = undefined;
	warpSwapEnabledOverride = true;
	tunnelExit = undefined;
	warpPreferred = false;
	lastEgress = undefined;
	localParkedUntil = 0;
	deliveringWarpStreams = 0;
}

/** Test-only: the state `/health` reports, without standing a server up. */
export function warpStateForTests() {
	return {
		warp429Streak,
		warpRecycles,
		warpResends,
		warpSwaps,
		warpSwapInFlight,
		warpSwapUnsupported,
		tunnelExit,
		warpRecycleInFlight,
		warpPreferred,
		lastEgress,
		localParkedUntil,
		deliveringWarpStreams,
	};
}

/** Test-only: turn the targeted swap off the way `RELAY_WARP_SWAP=0` does. The
 *  production flag is read once at load, which a test cannot re-read. */
export function setWarpSwapEnabledForTests(enabled) {
	warpSwapEnabledOverride = enabled !== false;
}

/** Test-only: shrink the rotation window; a real rotation poll would cost the
 *  suite 10s per case. Called with no arguments it restores the production
 *  defaults (10_000ms timeout, 250ms poll, 120_000ms drain valve), which are the
 *  contract. */
export function setWarpRotationTimingForTests(timeoutMs, pollMs, valveMs) {
	rotationTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : ROTATION_TIMEOUT_MS;
	rotationPollMs = Number.isFinite(pollMs) ? pollMs : ROTATION_POLL_MS;
	drainValveMs = Number.isFinite(valveMs) ? valveMs : DRAIN_VALVE_MS;
}

/** Test-only: pretend `count` responses are being delivered over warp now. */
export function setDeliveringStreamsForTests(count) {
	deliveringWarpStreams = Number.isFinite(count) ? count : 0;
}

/** Test-only: point the event log somewhere writable, or silence it with an
 *  empty string. The production writer is built once from `RELAY_LOG_FILE` at
 *  load, which a test cannot re-read. */
export function setLogFileForTests(file) {
	logWarpEvent = makeEventLogger(file);
}

/** POST /recycle and read the answer, because the status alone cannot tell an
 *  accepted rotation from a refused one. A `202` with `ok:false` means the proxy
 *  refused: a swap or another recycle already owns its state, and nothing
 *  happened. Nothing happened means nothing may be spent — no counter — and no
 *  waiting for a confirmation that cannot come.
 *
 *  The body also says which one refused it, without any new surface: only a swap
 *  publishes an exit in `draining`, so an exit in that state is the swap and its
 *  absence is the recycle. */
async function postRecycle(config) {
	const res = await fetch(`${config.warpProxy}/recycle`, {
		method: "POST",
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	let body;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	if (body && body.ok === false) {
		const reason = warpExitSnapshot(body).exits.some((exit) => exit.state === "draining")
			? "blocked_by_swap"
			: "blocked_by_recycle";
		logWarpEvent("recycle_refused", { reason });
		return { accepted: false, reason };
	}
	return { accepted: true };
}

async function maybeRecycleWarp(config) {
	// One recycle at a time: a burst of concurrent 429s must not stack POSTs.
	if (warpRecycleInFlight) return;
	if (!needsWarpRecycle(warp429Streak)) return;
	if (!config.warpProxy) return;
	// This is the everyday `auto` rotation: a warp 429 the chain already absorbed
	// (warp 429, then a local success) lands here, not in the resend path. The
	// wait belongs to the POST, not to one of its callers, so it happens here too
	// — and still before the POST, never after.
	// No `client` is passed on purpose: this rotation repairs the exit for every
	// later request, not to serve a resend, so a caller that left is not a reason
	// to leave the burnt IP in place.
	if (!(await drainBeforeRotation())) return;
	// The wait is an await: a peer may have rotated meanwhile.
	if (warpRecycleInFlight) return;
	if (!needsWarpRecycle(warp429Streak)) return;
	warp429Streak = 0;
	warpRecycleInFlight = true;
	try {
		const recycle = await postRecycle(config);
		if (!recycle.accepted) return;
		warpRecycles += 1;
		process.stderr.write(
			`pi-free-bridge relay: warp exit recycled (fresh egress IP) after a warp 429\n`,
		);
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		if (!warpRecycleUnavailableWarned) {
			warpRecycleUnavailableWarned = true;
			process.stderr.write(
				`pi-free-bridge relay: warp auto-recycle unavailable (${reason}) — continuing without it
`,
			);
		} else {
			process.stderr.write(`pi-free-bridge relay: warp auto-recycle attempt failed — ${reason}
`);
		}
	} finally {
		warpRecycleInFlight = false;
	}
}

/** Reduce a `/health` snapshot to what the rotation poll reads. One read serves
 *  both answers the poll needs: the exit NAMES the confirmation helper compares
 *  and the usable count the manual sweep reports, so no rotation reads the proxy
 *  twice per poll. A snapshot already treats every failure (refused, timeout,
 *  non-2xx, unparseable body) as "no report", so the poll keeps waiting and
 *  eventually falls back to the original 429. */
function healthFromSnapshot(snapshot) {
	if (!snapshot) return undefined;
	return {
		recycling: snapshot.recycling === true,
		exits: Array.isArray(snapshot.exits) ? snapshot.exits.map((exit) => exit.id) : [],
	};
}

/** Wait until nothing is being delivered over the warp tunnel, because the
 *  POST that follows tears the tunnel down. No clock on the wait itself — only
 *  the valve, which is there for a stream that hung, not for a peer that is
 *  slow. Returns whether the rotation may proceed.
 *  `client` is the request that asked for the rotation. If it left, nobody is
 *  waiting for the resend, so rotating up to two minutes later would only cost
 *  the other tenants their own retry. */
async function drainBeforeRotation(client) {
	if (deliveringWarpStreams <= 0) return true;
	const startedAt = Date.now();
	const valve = startedAt + drainValveMs;
	let valveHit = false;
	while (deliveringWarpStreams > 0) {
		if (client && client.gone) {
			process.stderr.write(
				`pi-free-bridge relay: client left ${Date.now() - startedAt}ms into the drain wait — not rotating\n`,
			);
			return false;
		}
		if (Date.now() >= valve) {
			valveHit = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
	}
	const stuck = valveHit ? `, ${deliveringWarpStreams} still delivering — valve hit` : "";
	process.stderr.write(
		`pi-free-bridge relay: waited ${Date.now() - startedAt}ms for in-flight warp responses before rotating${stuck}\n`,
	);
	return true;
}

/** Rotate the warp exit and wait until the rotation is CONFIRMED (S6). Returns
 *  `{ rotated, usable }` — true only when confirmed, because an unconfirmed
 *  rotation must not buy a resend (the resend would leave through the same burnt
 *  IP and burn the one attempt), plus the usable exit count observed on the last
 *  read, which is the number the manual sweep reports for its step.
 *  Concurrency: a rotation already in flight belongs to another handler, and
 *  the correct degradation is today's behaviour (deliver the 429) rather than
 *  stacking POSTs on the proxy.
 *
 *  `snapshot` is an optional pool read the caller already made: the manual sweep
 *  reads the pool to choose its cheapest step, and that same read is the
 *  pre-POST snapshot the confirmation compares against, so the rotation never
 *  reads the proxy twice for one answer. */
async function runWarpRotation(config, client, snapshot) {
	// A rotation already in flight belongs to another handler: a second POST
	// would rotate the exit out from under that handler's in-flight resend and
	// hand this request a stream nobody can serve. The original 429 is the honest
	// answer. This is single-flight, not a clock: S12 removed the cool-down that
	// used to keep a burst of 429s from rotating twice.
	if (warpRecycleInFlight) {
		logWarpEvent("rotate_skipped", { reason: "in_flight" });
		return { rotated: false };
	}
	if (!config.warpProxy) {
		logWarpEvent("rotate_skipped", { reason: "no_proxy" });
		return { rotated: false };
	}

	if (!(await drainBeforeRotation(client))) {
		logWarpEvent("rotate_skipped", {
			reason: "drain_refused",
			delivering: deliveringWarpStreams,
		});
		return { rotated: false };
	}
	// The drain is an await: another handler may have recycled meanwhile.
	if (warpRecycleInFlight) {
		logWarpEvent("rotate_skipped", { reason: "in_flight" });
		return { rotated: false };
	}
	warpRecycleInFlight = true;
	// This rotation pays for the 429s that asked for it.
	logWarpEvent("rotate_start", { streak: warp429Streak, delivering: deliveringWarpStreams });
	warp429Streak = 0;
	let usable;
	try {
		// Snapshot BEFORE the POST: the exit list is the only observable proof
		// that an exit was actually replaced.
		const before = snapshot ?? (await readWarpSnapshot(config));
		const recycle = await postRecycle(config);
		if (!recycle.accepted) return { rotated: false };
		warpRecycles += 1;

		// A rotation is ACCEPTED before the pool changes: the proxy publishes the new
		// exits minutes later. With a client waiting, the resend waits for exactly
		// that change and nothing else bounds it (`waitForPoolReplacement`); a caller
		// that passed no client has nothing to keep waiting for, so it keeps the
		// confirmation window this rotation always had. The deadline survives only
		// here, where nobody is waiting for an answer.
		if (!client) {
			const previous = healthFromSnapshot(before);
			const deadline = Date.now() + rotationTimeoutMs;
			let seenRecycling = false;
			while (Date.now() < deadline) {
				const current = await readWarpSnapshot(config);
				const observed = usableExitCount(current);
				if (observed !== undefined) usable = observed;
				const state = healthFromSnapshot(current);
				if (state && state.recycling) seenRecycling = true;
				if (isRotationConfirmed(previous, state, seenRecycling)) {
					logWarpEvent("rotate_ok", { recycles: warpRecycles });
					return { rotated: true, accepted: true, usable };
				}
				await new Promise((resolve) => setTimeout(resolve, rotationPollMs));
			}
			logWarpEvent("rotate_failed", { reason: "not_confirmed" });
			return { rotated: false, accepted: true, usable };
		}

		const replaced = await waitForPoolReplacement(config, before, exitIds(before), client);
		if (replaced.changed) {
			logWarpEvent("rotate_ok", { recycles: warpRecycles });
			return { rotated: true, accepted: true, usable: replaced.usable, newExit: replaced.newExit };
		}
		// The client left before the pool changed: nobody is left to answer, so
		// nothing is resent. The rotation finishes in the proxy and the next request
		// finds the fresh exits.
		logWarpEvent("rotate_abandoned", { reason: replaced.reason, recycles: warpRecycles });
		return { rotated: false, accepted: true, abandoned: true, usable: replaced.usable };
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp rotation failed — ${reason}\n`);
		logWarpEvent("rotate_failed", { reason });
		return { rotated: false, usable };
	} finally {
		warpRecycleInFlight = false;
	}
}

/** S3: the rotation itself. Every caller that only asks "did it rotate?" keeps
 *  that answer; the manual sweep asks the richer `runWarpRotation` directly. */
export async function rotateWarpExit(config, client) {
	return (await runWarpRotation(config, client, undefined)).rotated;
}

/** The `/health` read behind both the rotation poll and the manual sweep. It
 *  keeps the counters because attribution and the sweep's per-step usable count
 *  need more than exit names; `healthFromSnapshot` reduces it to what the
 *  rotation's confirmation helper compares. */
async function readWarpSnapshot(config) {
	try {
		const res = await fetch(warpHealthUrl(config.warpProxy, config.warpHealthPath), {
			signal: AbortSignal.timeout(2_000),
		});
		if (!res.ok) return undefined;
		return warpExitSnapshot(await res.json());
	} catch {
		return undefined;
	}
}

/** S6: learn which exit owns the tunnel this request just opened. The `served`
 *  counter is monotonic and belongs to the exit, so only its movement between a
 *  snapshot taken before our attempt and one taken after says a tunnel opened —
 *  and even then a single delta does not say WHOSE tunnel it was. The policy
 *  that keeps it honest lives in `updateTunnelExit`; this only feeds it the two
 *  facts it cannot get itself: the live delta and whether the exit we hold still
 *  exists.
 *
 *  A failure to read is not a contradiction, so the map is kept as it was: an
 *  unreadable `/health` must not cost a good attribution that will be needed on
 *  the next 429. */
async function noteWarpAttribution(config, before) {
	if (!before) return;
	const after = await readWarpSnapshot(config);
	if (!after) {
		logWarpEvent("attribution_unreadable", {});
		return;
	}
	const delta = servedDelta(before, after);
	// A vanished exit is not evidence about the tunnel, it is proof that the map
	// itself is stale: whatever replaced it gets learned from scratch, and the old
	// id is never pinned. That is the difference between a cache and a mistake.
	const replaced = tunnelExit !== undefined && delta.gone.includes(tunnelExit);
	const mapValid =
		tunnelExit !== undefined && !replaced && after.exits.some((candidate) => candidate.id === tunnelExit);
	const next = replaced
		? { exitId: delta.learned, decision: delta.learned ? "relearned" : "exit_gone" }
		: updateTunnelExit(tunnelExit, delta, { mapValid });
	const previous = tunnelExit;
	tunnelExit = next.exitId;
	if (next.decision === "kept" && previous === tunnelExit) return;
	logWarpEvent(`attribution_${next.decision}`, {
		exit: tunnelExit,
		...(previous ? { previous } : {}),
	});
}

/** S7: rotate ONE exit instead of the whole pool. The proxy stops handing work
 *  to the target, re-enrolls only that exit, and keeps serving through the
 *  other one — one enrollment instead of N, and the pool is never left empty.
 *
 *  The drain wait is reused on purpose: our own deliveries are multiplexed over
 *  the target too, so replacing it still kills the streams riding it. It is
 *  cheap in the case this exists for, because by the time a 429 is being
 *  diagnosed nothing of ours is still streaming.
 *
 *  A `202` is acceptance, and it is also the state: the proxy publishes the new
 *  state under the same lock that accepts the swap, so the body already carries
 *  the target `draining` and the other exit serving. The caller may NOT resend on
 *  it: the drained exit stays listed for minutes while the standby answers, so the
 *  ladder waits for the pool to change first (`waitForPoolReplacement`). `409` (no
 *  standby) and `404` (unknown exit) are real answers, and both mean "do not insist
 *  now" — with two exits a 409 says the other one is already down, so hammering
 *  would only burn enrollments while the gate is rate-limiting. */
export async function swapWarpExit(config, exitId, client) {
	const decision = decideWarpSwap({
		exitId,
		enabled: WARP_SWAP_ENABLED && warpSwapEnabledOverride,
		unavailable: warpSwapUnsupported,
		inFlight: warpSwapInFlight,
	});
	if (!decision.swap) {
		logWarpEvent("swap_skipped", { reason: decision.reason, exit: exitId });
		return { swapped: false, reason: decision.reason };
	}
	if (!config.warpProxy) {
		logWarpEvent("swap_skipped", { reason: "no_proxy", exit: exitId });
		return { swapped: false, reason: "no_proxy" };
	}
	if (!(await drainBeforeRotation(client))) {
		logWarpEvent("swap_skipped", { reason: "drain_refused", exit: exitId, delivering: deliveringWarpStreams });
		return { swapped: false, reason: "drain_refused" };
	}
	// The drain is an await: another handler may have started a swap meanwhile.
	if (warpSwapInFlight) {
		logWarpEvent("swap_skipped", { reason: "in_flight", exit: exitId });
		return { swapped: false, reason: "in_flight" };
	}
	warpSwapInFlight = true;
	logWarpEvent("swap_start", { exit: exitId, delivering: deliveringWarpStreams });
	try {
		const res = await fetch(`${config.warpProxy}/swap`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ exit: exitId }),
			signal: AbortSignal.timeout(10_000),
		});
		let body;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		const target = body && typeof body.target === "string" ? body.target : undefined;
		// Not every non-2xx is JSON, and the reason lives in `error`, never in
		// `reason`: that field does not exist in the contract. A 405 and a 501 answer
		// in plain text, and a 404 without our own `unknown_exit` error is a route
		// that does not exist. Those
		// are not exit problems, so retrying would be a routine for the life of the
		// process: the ladder steps aside once and stays aside.
		const unsupported =
			res.status === 405 ||
			res.status === 501 ||
			(res.status === 404 && !(body && body.error === "unknown_exit"));
		if (unsupported) {
			warpSwapUnsupported = true;
			if (!warpSwapUnsupportedWarned) {
				warpSwapUnsupportedWarned = true;
				process.stderr.write(
					`pi-free-bridge relay: this proxy has no /swap (HTTP ${res.status}) — the targeted swap is off, rotating hard instead\n`,
				);
			}
			logWarpEvent("swap_unavailable", { status: res.status, exit: exitId });
			return { swapped: false, reason: "unavailable", status: res.status };
		}
		// `ok:false` is the proxy saying nothing happened: a swap or a recycle is
		// already in flight and this one was refused. A 202 alone is not enough to
		// call it accepted, and neither is an exit in `cooldown` — a target in
		// cooldown is rejected as `no_standby`, so it can never prove a swap
		// started. Only `ok` and the 202 that carries it do that.
		const blocked = res.status === 202 && Boolean(body && body.ok === false);
		if (res.status === 202 && !blocked) {
			warpSwaps += 1;
			logWarpEvent("swap_ok", { exit: exitId, target });
			return { swapped: true, target };
		}
		const reason = blocked
			? typeof body.error === "string" && body.error
				? body.error
				: "blocked"
			: res.status === 409
				? "no_standby"
				: res.status === 404
					? "unknown_exit"
					: `HTTP ${res.status}`;
		if (res.status !== 409 && res.status !== 404) {
			process.stderr.write(`pi-free-bridge relay: warp swap failed — HTTP ${res.status}\n`);
		}
		logWarpEvent("swap_refused", { exit: exitId, status: res.status, reason });
		return { swapped: false, reason, status: res.status, target };
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp swap failed — ${reason}\n`);
		logWarpEvent("swap_failed", { exit: exitId, reason });
		// Not armed: a transport error says nothing about the proxy's state.
		return { swapped: false, reason };
	} finally {
		warpSwapInFlight = false;
	}
}

/** S5/S7/S10: one resend, only after a confirmed rotation, and always on the
 *  warp egress — the fresh IP lives there whatever order the chain used. Never
 *  a loop: the attempt happens once and only a non-error answer is adopted.
 *  Every refused resend — the same 429, a 5xx, or a 4xx from the fresh exit —
 *  hands back the original 429 byte-exact with its real status on stderr, so a
 *  real rate limit is never hidden behind a different error. Returns what it
 *  delivered and the egress that delivered it; `egress` is undefined when the
 *  original comes back, because then the original's own egress still stands. */
function rebuildOriginal(original) {
	return {
		egress: undefined,
		response: new Response(original.body, {
			status: original.status,
			headers: original.contentType ? { "content-type": original.contentType } : {},
		}),
	};
}

/** The exit ids of a snapshot, in pool order. The waits below compare sets of
 *  ids, and a failed read has no ids to compare. */
function exitIds(snapshot) {
	return snapshot && Array.isArray(snapshot.exits) ? snapshot.exits.map((exit) => exit.id) : [];
}

/** Pure: the pool has ACTUALLY replaced what a step drained when every drained id
 *  is gone from `exits[]` AND an id that was not in the pool before the step is
 *  present. Returns that fresh id, or `undefined` while the pool still shows the
 *  old one. One condition is not enough: an accepted swap keeps the drained exit
 *  listed as `draining` for minutes while the STANDBY serves, so a resend sent on
 *  a new id alone can still ride an exit the step did not replace, and an exit
 *  list that merely lost the drained id is a pool that came back short. */
function replacedExit(before, current, drained) {
	if (!current || !Array.isArray(current.exits)) return undefined;
	const known = new Set(exitIds(before));
	const gone = new Set(drained ?? []);
	const ids = current.exits.map((exit) => exit.id);
	if (ids.some((id) => gone.has(id))) return undefined;
	return ids.find((id) => !known.has(id));
}

/** Wait until the pool has changed for real, because the resend that follows must
 *  be SERVED by the exit the step enrolled and not by the standby the drained one
 *  left behind. Live evidence (2026-11-05, 21:46-21:49): a swap was accepted, the
 *  resend left while the drained exit was still out and the standby answered it,
 *  and the pool was whole again with a NEW id only ~3 minutes later — the first
 *  request served by that id was the next one.
 *
 *  There is no clock of its own, and that is the point: the drain measured on
 *  2026-11-05 took 120s (`20:37:18` asked -> `20:39:18` drained) and the pool took
 *  minutes longer, so any budget short enough to keep a client waiting is short
 *  enough to call a healthy step failed. The single bound is the client's own
 *  patience, observed through `client.gone` — the same signal the drain wait uses
 *  — and a caller with no client at all keeps the rotation deadline as its only
 *  bound, because it has nothing else to observe.
 *
 *  A wait that ends because the client left is NOT evidence about the exit: the
 *  deferred judgement (`judgeStrandedWarpSwap`) stays the only thing that
 *  measures stranding, on the next ladder run, by usable-exit count. */
async function waitForPoolReplacement(config, before, drained, client) {
	const deadline = client ? Infinity : Date.now() + rotationTimeoutMs;
	let usable;
	for (;;) {
		if (client && client.gone) return { changed: false, reason: "client_gone", usable };
		const current = await readWarpSnapshot(config);
		const observed = usableExitCount(current);
		if (observed !== undefined) usable = observed;
		const fresh = replacedExit(before, current, drained);
		// A client that left during the read must not spend the resend, even when the
		// pool happened to change in the same window.
		if (fresh && !(client && client.gone)) return { changed: true, newExit: fresh, usable };
		if (Date.now() >= deadline) return { changed: false, reason: "timeout", usable };
		await new Promise((resolve) => setTimeout(resolve, rotationPollMs));
	}
}

/** S5: the one attempt a fresh exit buys. Returns the adopted response, or
 *  `undefined` when that exit refused as well, so the caller decides whether
 *  anything harder is still worth it and the original 429 is rebuilt once, in
 *  the only place that delivers it. */
async function resendWarpOnce(config, pathname, body, original, via) {
	// S6: the same window, on the resend. After a swap the tunnel is a NEW exit,
	// so the map relearns from this attempt instead of keeping the id that was
	// just replaced.
	const before = await readWarpSnapshot(config);
	let attempt;
	try {
		attempt = await egressFetch(config, pathname, { body: JSON.stringify(body) }, "warp");
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp resend after ${via} failed — ${reason}\n`);
		logWarpEvent("resend_failed", { reason, via });
		return undefined;
	}

	if (attempt.status < 400) {
		warp429Streak = bumpWarp429Streak(warp429Streak, attempt.status, "warp");
		warpResends += 1;
		process.stderr.write(
			`pi-free-bridge relay: warp resend after ${via} delivered ${attempt.status} on the fresh exit IP\n`,
		);
		logWarpEvent("resend_ok", { status: attempt.status, egress: "warp", resends: warpResends, via });
		return { egress: "warp", response: attempt };
	}

	await attempt.arrayBuffer(); // drain for connection reuse
	// A 429 from the fresh exit is exit evidence like any other warp 429, so the
	// same helper the loop uses must count it; otherwise a second burnt exit
	// under-reports the streak and the next burst rotates late.
	warp429Streak = bumpWarp429Streak(warp429Streak, attempt.status, "warp");
	if (attempt.status === 429) await noteWarpAttribution(config, before);
	process.stderr.write(
		`pi-free-bridge relay: warp resend after ${via} got ${attempt.status} — delivering the original ${original.status}\n`,
	);
	logWarpEvent("resend_refused", { status: attempt.status, delivered: original.status, via });
	return undefined;
}

export async function resendAfterRotation(config, pathname, body, original, client) {
	if (!(await rotateWarpExit(config, client))) {
		process.stderr.write(
			`pi-free-bridge relay: warp rotation not confirmed — delivering the original ${original.status}\n`,
		);
		logWarpEvent("resend_skipped", { reason: "rotation_not_confirmed" });
		return rebuildOriginal(original);
	}
	return (await resendWarpOnce(config, pathname, body, original, "rotation")) ?? rebuildOriginal(original);
}

/** Pure: how many exits could serve new work in this snapshot. The pool's own
 *  `healthy` counter is the honest source; a proxy that publishes no count at
 *  all leaves the listed exits as the best available answer. */
function usableExitCount(snapshot) {
	if (!snapshot) return undefined;
	if (Number.isInteger(snapshot.healthy)) return snapshot.healthy;
	if (Array.isArray(snapshot.exits)) return snapshot.exits.length;
	return undefined;
}

/** S14: judge the drain of the PREVIOUS swap, on the next ladder run and never
 *  inline. A real drain takes up to 120s (measured `20:37:18` asked ->
 *  `20:39:18` drained), so any wait inside the request that ate the 429 would
 *  label a perfectly healthy swap as stranded — that is exactly what the
 *  10s budget did. The evidence is a COUNT of usable exits, never the drained
 *  id: a re-enrolment publishes a new id (E7), so identity would read a healthy
 *  replacement as a stranding and suspend the swap after two ordinary swaps.
 *
 *  - fewer usable exits than when the swap went out -> one stranding;
 *  - the same number or more, even with brand-new ids -> it settled, streak
 *    resets;
 *  - `/health` cannot be read, or a swap is still in flight -> no verdict yet,
 *    the count stays remembered for the next pass (neither is evidence of a lost
 *    exit).
 *
 *  A stranding is also this run's answer to "may I spend another swap?": no.
 *  Draining a second exit for a pool that never replaced the first only spends
 *  enrollments, so the run hands the recovery to the recycle instead. The
 *  verdict is consumed here, so it counts once.
 *
 *  Two consecutive strandings mean the pool cannot replace what the ladder
 *  drains, so the ladder steps aside through the same state a proxy without
 *  `/swap` sets. The event name and the warning stay distinct on purpose: a
 *  stranded pool and a missing route are different failures, and whoever reads
 *  the log has to be able to tell them apart.
 *
 *  Returns whether this run counted a stranding. */
function judgeStrandedWarpSwap(snapshot) {
	const before = warpSwapPoolBefore;
	if (before === undefined || warpSwapInFlight) return false;
	const usable = usableExitCount(snapshot);
	if (usable === undefined) return false;
	warpSwapPoolBefore = undefined;
	if (usable >= before) {
		warpSwapStrandedStreak = 0;
		logWarpEvent("swap_settled", { usableBefore: before, usable });
		return false;
	}
	warpSwapStrandedStreak += 1;
	logWarpEvent("swap_stranded", { usableBefore: before, usable, stranded: warpSwapStrandedStreak });
	if (warpSwapStrandedStreak >= 2 && !warpSwapUnsupported) {
		warpSwapUnsupported = true;
		if (!warpSwapUnsupportedWarned) {
			warpSwapUnsupportedWarned = true;
			process.stderr.write(
				"pi-free-bridge relay: two targeted swaps in a row stranded the pool — the targeted swap is off, rotating hard instead\n",
			);
		}
		logWarpEvent("swap_suspended_stranded", { stranded: warpSwapStrandedStreak, usableBefore: before, usable });
	}
	return true;
}

/** S8/S14: the bounded ladder, in ascending cost. A targeted swap replaces ONLY
 *  the exit that served the 429 and keeps the pool serving through the other
 *  one: one enrollment instead of N, no stream cut, nothing left empty. One
 *  resend on the fresh exit decides whether that was enough.
 *
 *  The harder rotation runs last and only when the fresh exit refused too,
 *  because it is the only step that tears down our own tunnel and every stream
 *  riding it. Bounded by construction: at most two attempts per request, and the
 *  original 429 is delivered byte-exact when neither works.
 *
 *  An accepted swap is waited out (`waitForPoolReplacement`) so the resend is
 *  served by the exit it enrolled instead of the standby the drained one left
 *  behind. That wait is NOT a settle verdict: it only asks whether the pool
 *  changed, so whether a swap stranded the pool is still judged on the next run
 *  (`judgeStrandedWarpSwap`), by usable-exit count.
 *
 *  No attribution means no target, and a body-less swap picks by live streams —
 *  which, by the time a 429 is being diagnosed, points at the wrong exit. So the
 *  ladder skips straight to the rotation instead of guessing. */
export async function recoverWarp429(config, pathname, body, original, client) {
	// Read the pool once, before the decision: a targeted swap costs the exit that
	// served us, so it is only worth spending while another healthy exit remains
	// to serve the retry. A snapshot that cannot be read counts as no standby.
	const snapshot = await readWarpSnapshot(config);
	// S14: the previous swap's drain gets its verdict here, before this run decides
	// anything of its own. No wait was spent inside the request that asked for it.
	const stranded = judgeStrandedWarpSwap(snapshot);
	const decision = stranded
		? { swap: false, reason: "stranded" }
		: decideWarpSwap({
				exitId: tunnelExit,
				healthy: snapshot ? snapshot.healthy : 0,
				// S13: a parked exit makes the recycle the right tool — the swap
				// replaces one exit and leaves the 30 minute parks alone, while only
				// fresh enrollments clear them.
				parked: hasParkedExit(snapshot),
				retryAfterMs: original.retryAfterMs,
				enabled: WARP_SWAP_ENABLED && warpSwapEnabledOverride,
				inFlight: warpSwapInFlight,
			});
	if (!decision.swap) {
		logWarpEvent("ladder_swap_skipped", { reason: decision.reason, exit: tunnelExit });
		return resendAfterRotation(config, pathname, body, original, client);
	}
	const drainedExit = tunnelExit;
	const swap = await swapWarpExit(config, drainedExit, client);
	if (swap.swapped) {
		// S14: the swap was accepted, not finished, so the usable exit count is
		// remembered for the NEXT run's verdict (by count, because a re-enrolment
		// publishes a new id and identity proves nothing).
		warpSwapPoolBefore = usableExitCount(snapshot);
		// The resend waits for the pool to actually change: sent on the acceptance
		// alone it leaves while the drained exit is still out and the standby serves
		// it, which is the swap buying nothing (observed live on 2026-11-05). The
		// only bound is the client's own patience.
		const replaced = await waitForPoolReplacement(config, snapshot, [drainedExit], client);
		if (!replaced.changed) {
			// The client left before the pool changed: nobody to answer, so nothing is
			// resent. The swap finishes in the proxy and the next request finds the
			// fresh exit. This wait says nothing about stranding — see above.
			logWarpEvent("swap_wait_abandoned", { exit: drainedExit, reason: replaced.reason });
			return rebuildOriginal(original);
		}
		logWarpEvent("swap_wait_ok", { exit: drainedExit, newExit: replaced.newExit, usable: replaced.usable });
		const attempt = await resendWarpOnce(config, pathname, body, original, "swap");
		if (attempt) return attempt;
		return resendAfterRotation(config, pathname, body, original, client);
	}
	return resendAfterRotation(config, pathname, body, original, client);
}

/** Pure: the upstream headers the relay forwards downstream. `content-type`
 *  keeps the body readable; `retry-after` is what makes a gate 429 actionable,
 *  because it carries the seconds until the quota resets. Without it the client
 *  can only guess, and guessing midnight UTC is exactly the wrong answer for a
 *  user in any other time zone. Everything else stays upstream: it is the
 *  upstream's business, not the client's. */
export function forwardedHeaders(source) {
	const headers = {};
	if (!source || typeof source.get !== "function") return headers;
	const contentType = source.get("content-type");
	if (contentType) headers["content-type"] = contentType;
	const retryAfter = source.get("retry-after");
	if (retryAfter) headers["retry-after"] = retryAfter;
	return headers;
}

/** S13: has this connection lost its client while the response is still unwritten?
 *  Node answers that with the response's `close` (handled in `trackClient`). Bun
 *  never fires it for a client that left: measured on Bun 1.3.12 (2026-11-06,
 *  `.tmp-probe/signals.mjs`), an abandoned request emits nothing at all — no
 *  `res:close`, no `res:finish`, no socket `close`/`end`, and `res.destroyed`,
 *  `res.writableEnded` and `res.socket.destroyed` all stay `false` — while the
 *  connection's remote endpoint, documented `net.Socket` properties, go away:
 *  `remoteAddress`/`remotePort`/`remoteFamily` turn `undefined` about 50 ms after
 *  the client hangs up. In the normal case those properties keep their values for
 *  the whole life of the request, including past `res:finish` and `res:close`, so
 *  they only ever disappear for a client that is no longer there. */
function clientLeft(res) {
	if (res.writableEnded) return false;
	const socket = res.socket;
	if (!socket) return false;
	return socket.remoteAddress === undefined;
}

/** S13: marks a client that went away before the response finished. Two signals
 *  because the runtimes disagree: the response's `close` (also fires after a
 *  normal finish, so the `writableEnded` guard matters) and the connection's
 *  lost remote endpoint, observed when `gone` is read. Both flip forward only;
 *  neither ever resets, so a wait that has been abandoned stays abandoned. */
function trackClient(res) {
	let gone = false;
	res.on("close", () => {
		if (!res.writableEnded) gone = true;
	});
	return {
		get gone() {
			if (!gone && clientLeft(res)) gone = true;
			return gone;
		},
	};
}

// Exported for the request-path tests: the counter and the drain order are only
// observable from a real `forward()` call.
export async function forward(req, res, pathname, config) {
	const client = trackClient(res);
	let countedDelivering = false;
	try {
		const raw = await readBody(req);
		const incoming = JSON.parse(raw);
		const source = incoming && typeof incoming === "object" ? incoming : {};

		// The only mutations on the Pi path: the gate-mandated `<env>` block, the
		// tool names, and `stream: true` (S21-S23).
		const body = ensureGateTools({
			...source,
			messages: ensureEnvBlock(source.messages, config.cwd),
			stream: true,
		});

		// S5: walk the egress chain, failover only while nothing has reached
		// the client. Whatever response ends the loop is delivered verbatim by
		// the code below (error body byte-exact included).
		const order = egressOrder(config.warpMode, warpPreferred, Date.now() < localParkedUntil);
		const errors = [];
		let response = undefined;
		let last429 = undefined;
		let sawWarp429 = false;
		// Request-local: a long rotation waits next to other requests, so the
		// egress that answered THIS request cannot live in a module global that
		// another handler overwrites in the meantime.
		let egressUsed = undefined;
		for (const egress of order) {
			egressUsed = egress;
			let candidate;
			try {
				// S6: attribution needs the counters from BEFORE this attempt, because
				// `served` is monotonic and only its movement says a tunnel opened.
				const warpBefore = egress === "warp" ? await readWarpSnapshot(config) : undefined;
				candidate = await egressFetch(config, pathname, { body: JSON.stringify(body) }, egress);
				// relay-warp-auto-recycle: count OBSERVED warp responses, not only
				// the delivered one — a warp 429 that falls back to a local
				// success must still extend the streak.
				if (egress === "warp") {
					warp429Streak = bumpWarp429Streak(warp429Streak, candidate.status, "warp");
					if (candidate.status === 429) {
						logWarpEvent("warp_429", { streak: warp429Streak, delivering: deliveringWarpStreams });
						await noteWarpAttribution(config, warpBefore);
					}
					// S10: the trigger is the whole request, not the last egress — in
					// either `auto` order, a 429 observed through warp is exit evidence
					// even when a local fallback delivered something else. Mode `off`
					// never reaches warp at all, so it keeps today's behavior by
					// construction (S9).
					if (candidate.status === 429) sawWarp429 = true;
				}
				// S16: a local 429 is the local IP's own quota, and its `retry-after`
				// is the only honest source for when that ends. Park it, so the next
				// turns do not spend themselves on an IP the gate already refused.
				if (egress === "local" && candidate.status === 429) {
					const parked = parkDurationMs(candidate.headers.get("retry-after"));
					if (parked) {
						localParkedUntil = Date.now() + parked;
						process.stderr.write(
							`pi-free-bridge relay: local egress parked for ${Math.round(parked / 1000)}s after its own 429\n`,
						);
						logWarpEvent("local_parked", { parkedMs: parked });
					}
				}
			} catch (err) {
				// S7: modo "on" y WARP falla con error de red (no 429/403 de
				// quota) → fallback a local para evitar 502. Nada se ha
				// entregado al cliente aún (fetch rechazó antes del primer byte).
				if (config.warpMode === "on" && egress === "warp" && isNetworkError(err)) {
					try {
						candidate = await egressFetch(config, pathname, {
							body: JSON.stringify(body),
						}, "local");
						egressUsed = "local";
						response = candidate;
						break;
					} catch (err2) {
						errors.push(`local: ${err2 && err2.message ? err2.message : String(err2)}`);
						continue;
					}
				}
				errors.push(`${egress}: ${err && err.message ? err.message : String(err)}`);
				continue;
			}
			if (candidate.status === 429) {
				// The raw gate 429 is payday evidence for the client; the old
				// relay piped it through byte-exact when there was no alternate
				// egress. Keep it instead of the drain, and only fall back while
				// another egress in the chain actually exists.
				if (egress === order[order.length - 1]) {
					response = candidate;
					break;
				}
				await candidate.arrayBuffer(); // drain for connection reuse
				last429 = `429 (${egress})`;
				errors.push(`${egress}: 429`);
				continue;
			}
			response = candidate;
			break;
		}
		// S5/S7/S8: nothing has been written downstream, so a confirmed rotation
		// can buy exactly one resend. The original is buffered BEFORE the wait: a
		// rotation takes seconds, nothing may reach the client meanwhile, and if
		// the resend is refused those exact bytes are what gets delivered.
		if (response && response.status === 429 && sawWarp429 && WARP_RESEND_ENABLED && !client.gone) {
			const resend = await recoverWarp429(
				config,
				pathname,
				body,
				{
					status: response.status,
					contentType: response.headers.get("content-type"),
					body: Buffer.from(await response.arrayBuffer()),
					// Read here, while the header still exists: the decision to spend an
					// enrollment instead of waiting depends on how long the wait is.
					retryAfterMs: parkDurationMs(response.headers.get("retry-after")),
				},
				client,
			);
			response = resend.response;
			// No egress means the original 429 was handed back, so it keeps the
			// egress that produced it.
			if (resend.egress) egressUsed = resend.egress;
		}

		// Count this response for as long as it is being delivered over warp. A
		// rotation would kill it, and it already passed the gate, so it is exactly
		// what the drain wait protects. Counted BEFORE the rotation below, so that no
		// await added between here and there can leave a fresh delivery invisible.
		// Errors are not counted: they are short and not worth making a wait for.
		if (response && egressUsed === "warp" && response.status < 400) {
			deliveringWarpStreams += 1;
			countedDelivering = true;
		}

		// relay-warp-auto-recycle: evaluate after the whole chain, and whatever
		// we deliver — a fully rate-limited chain (502 below) still rotates the
		// burnt exit before the client retries.
		await maybeRecycleWarp(config);
		if (!response && last429) {
			// Non-last 429 with every fallback exhausted: surface the chain.
			sendJson(res, 502, { error: { message: `rate limited on every egress: ${errors.join("; ")}` } });
			return;
		}
		if (!response) {
			const message =
				errors.length > 0
					? `all egress attempts failed: ${errors.join("; ")}`
					: "no egress configured";
			sendJson(res, 502, { error: { message } });
			return;
		}
		warpPreferred = updateWarpPreference(config.warpMode, egressUsed, response.status);
		// The module global is written once per finished request, from this
		// request's own value: `/health` reports the last egress of the last
		// completed request, and a concurrent one cannot leak into it.
		lastEgress = egressUsed;
		logWarpEvent("deliver", { status: response.status, egress: egressUsed });

		// S20: status and content-type pass through, the body is piped unparsed.
		// S15: `retry-after` rides along, so a 429 arrives with its own reset
		// window instead of forcing the client to guess.
		const headers = forwardedHeaders(response.headers);

		// Error diagnostics (bun-upgrades S3): a gate rejection carries the
		// usable evidence in its JSON body. Snapshot it (bounded) before piping,
		// and hand the exact same bytes back — never rewrite or terminate them,
		// so Content-Length and SSE framing stay untouched.
		if (response.status >= 400) {
			const errorBody = Buffer.from(await response.arrayBuffer());
			const snapshot = errorBody.subarray(0, 4096);
			process.stderr.write(
				`pi-free-bridge relay: upstream ${response.status} via ${egressUsed} ${toUpstreamUrl(config.upstream, pathname)}
` +
					`pi-free-bridge relay: session ${config.session} (from ${config.sessionSource})
` +
					`pi-free-bridge relay: upstream body: ${snapshot.toString("utf8")}
`,
			);
			res.writeHead(response.status, headers);
			res.end(errorBody);
			return;
		}

		res.writeHead(response.status, { ...headers, "x-egress-used": egressUsed });

		if (!response.body) {
			res.end();
			return;
		}

		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (client.gone) {
				// Nobody is listening: stop draining the upstream into a dead socket.
				await reader.cancel();
				return;
			}
			res.write(Buffer.from(value));
		}
		res.end();
	} catch (err) {
		sendJson(res, 502, { error: { message: err && err.message ? err.message : String(err) } });
	} finally {
		if (countedDelivering) deliveringWarpStreams -= 1;
	}
}

export async function handle(req, res, config) {
	// Hot reload (relay-warp-hot-reload): one cheap config re-read per request
	// drives both /health and /v1.
	refreshWarpMode(config);

	const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");

	if (warpControlRoute(req.method, pathname) === "recycle") {
		const result = await manualWarpRecycle(config);
		// 409 is the honest status for a refused rotation: the request was well
		// formed, the relay's own state says no, and the body says which state.
		sendJson(res, result.ok ? 200 : 409, result);
		return;
	}

	if (req.method === "GET" && pathname === "/health") {
		// S33: the marker stays `service` + `ok`; the extra fields let the
		// extension report which id is actually on the wire.
		sendJson(res, 200, {
			service: SERVICE,
			ok: true,
			sessionId: config.session,
			sessionSource: config.sessionSource,
			warpMode: config.warpMode,
			warpModeSource: config.warpModeSource,
			warpProxy: config.warpProxy,
			warp429Streak: warp429Streak,
			// Gate-decode S3: `FreeUsageLimitError` is not evidence of quota. This field
			// carries what the relay can justify, not the label the vendor chose.
			gate429: classifyGate429({
				sessionSource: config.sessionSource,
				warp429Streak,
				parkedSeconds: Math.max(0, Math.ceil((localParkedUntil - Date.now()) / 1000)),
			}),
			warpRecycles: warpRecycles,
			warpResends: warpResends,
			// The ladder is invisible from outside for a different reason than the
			// counters above: a finished swap leaves the proxy snapshot healthy
			// again, so whether it ran, was disabled, or degraded is only knowable
			// from the process that ran it.
			warpSwaps: warpSwaps,
			warpSwapEnabled: warpSwapEnabledOverride ? WARP_SWAP_ENABLED : false,
			warpSwapUnsupported: warpSwapUnsupported,
			warpSwapInFlight: warpSwapInFlight,
			tunnelExit: tunnelExit ?? null,
			warpResendEnabled: WARP_RESEND_ENABLED,
			// S16: 0 means the local egress is free to use again. Reported as a
			// remaining window rather than a timestamp, because that is the number
			// a human reading /health actually wants.
			localParkedForMs: Math.max(0, localParkedUntil - Date.now()),
			lastEgress: lastEgress,
			pid: process.pid,
		});
		return;
	}

	if (req.method === "POST" && pathname.startsWith("/v1/")) {
		await forward(req, res, pathname, config);
		return;
	}

	sendJson(res, 404, { error: { message: `no route for ${req.method} ${pathname}` } });
}

async function startServer() {
	const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
	const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : DEFAULT_PORT;

	// S31: resolve the session before listening, so a missing id is a clear
	// startup failure instead of a 429 on the first request.
	const session = await resolveRelaySession();
	if (!session) {
		process.stderr.write(
			"pi-free-bridge relay: no OpenCode session id found — run OpenCode once, " +
				"or set PI_FREE_BRIDGE_SESSION_ID.\n",
		);
		process.exit(1);
	}

	// relay-warp-hot-reload: when RELAY_WARP_MODE is a real env override the
	// mode is absolute (source "env") and the relay stays static, by design.
	// Otherwise the per-request hot refresh resolves it from the config file
	// the extension points at via RELAY_CONFIG_PATH.
	const envOverride = normalizeWarpMode(process.env.RELAY_WARP_MODE);
	const config = {
		upstream: process.env.RELAY_UPSTREAM || DEFAULT_UPSTREAM,
		session: session.sessionId,
		sessionSource: session.source,
		cwd: process.env.RELAY_CWD || process.cwd(),
		userAgent: process.env.RELAY_USER_AGENT || DEFAULT_USER_AGENT,
		apiKey: process.env.RELAY_API_KEY || "public",
		wireMode: resolveWireModeHot(
			process.env.RELAY_WIRE_MODE,
			readFileWireMode(process.env.RELAY_CONFIG_PATH || ""),
		),
		warpMode: resolveWarpModeHot(envOverride, readFileWarpMode(process.env.RELAY_CONFIG_PATH || "")),
		warpModeSource: envOverride ? "env" : "config",
		warpConfigPath: process.env.RELAY_CONFIG_PATH || "",
		warpProxy: process.env.RELAY_WARP_PROXY || WARP_PROXY_DEFAULT,
		warpHealthPath: process.env.RELAY_WARP_HEALTH_PATH || WARP_HEALTH_PATH_DEFAULT,
	};

	const server = createServer((req, res) => {
		void handle(req, res, config).catch((err) => {
			sendJson(res, 502, { error: { message: err && err.message ? err.message : String(err) } });
		});
	});

	server.on("error", (err) => {
		const message =
			err && err.code === "EADDRINUSE"
				? `port ${port} is already in use — set PI_FREE_BRIDGE_RELAY_PORT to a free port`
				: err && err.message
					? err.message
					: String(err);
		process.stderr.write(`pi-free-bridge relay: ${message}\n`);
		process.exit(1);
	});

	server.listen(port, "127.0.0.1", () => {
		// The extension waits for exactly this line. Nothing else may reach stdout.
		process.stdout.write(`pi-free-bridge relay listening on http://127.0.0.1:${port}/v1\n`);

		// The parent keeps this pipe open; its death closes it and takes the relay
		// with it, so a crashed Pi never leaves an orphan (S26).
		process.stdin.resume();
		process.stdin.on("end", () => process.exit(0));
		process.stdin.on("close", () => process.exit(0));
		process.stdin.on("error", () => process.exit(0));
	});
}

/** True when this file is the entry point, under both Node and Bun. */
function isDirectRun() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return pathToFileURL(entry).href === import.meta.url;
	}
}

if (isDirectRun()) {
	startServer().catch((err) => {
		process.stderr.write(
			`pi-free-bridge relay: ${err && err.message ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
}
