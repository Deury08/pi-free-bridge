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
// `session` row first, newest `storage/session_diff/ses_*.json` second.
// `bun:sqlite` is imported dynamically so importing this module under plain
// Node (the helper tests) never touches it.

const SESSION_ID = /^ses_/;

/** `~/.local/share/opencode`, the store the official client writes. */
function openCodeShareDir() {
	return join(homedir(), ".local", "share", "opencode");
}

async function readSessionFromDb(shareDir) {
	const dbPath = join(shareDir, "opencode.db");
	if (!existsSync(dbPath)) return undefined;

	try {
		const { Database } = await import("bun:sqlite");
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db.query("select id from session order by time_created desc limit 5").all();
			for (const row of rows) {
				const id = row && typeof row.id === "string" ? row.id : undefined;
				if (id && SESSION_ID.test(id)) return id;
			}
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
 *  Pi-harvested id, then the relay's local store. Exported for tests; takes
 *  the local store root as an argument so tests can inject a temp store. */
export async function resolveRelaySession({ shareDir } = {}) {
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
	return resolveSessionFromStore(shareDir ? { shareDir } : {});
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

function egressFetch(config, pathname, { body }, egress) {
	const opts = {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": config.userAgent,
			authorization: `Bearer ${config.apiKey}`,
			"x-opencode-session": config.session,
			"x-opencode-session-id": config.session,
		},
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

/** relay-warp-auto-recycle (user-approved): the opencode free gate counts
 *  quota per (session, egress IP) and per UTC day. A 429 observed via the warp
 *  egress means that exit IP burnt its day, and only the proxy can re-enroll
 *  it. The relay counts 429s OBSERVED on the warp egress (even when a local
 *  fallback delivered the response) and rotates on the FIRST one — the meter
 *  has a single correct value, so it is not configurable; only the cooldown
 *  (`RELAY_WARP_RECYCLE_COOLDOWN_MS`) remains as the burst-tolerance knob. If
 *  the proxy does not expose that endpoint yet, the relay degrades: one
 *  warning, requests keep flowing exactly as before. Pure helpers exported
 *  for tests. */
const RECYCLE_COOLDOWN_MS = (() => {
	const n = Number.parseInt(process.env.RELAY_WARP_RECYCLE_COOLDOWN_MS ?? "", 10);
	return Number.isInteger(n) && n >= 0 ? n : 5 * 60_000;
})();

/** A targeted swap costs one Cloudflare enrollment, so it gets its own, shorter
 *  cooldown: the recycle cooldown protects a whole tunnel from being torn down
 *  twice, while this one only has to stop a burst of 429s from re-enrolling the
 *  same exit over and over while the gate is already rate-limiting. */
const SWAP_COOLDOWN_MS = (() => {
	const n = Number.parseInt(process.env.RELAY_WARP_SWAP_COOLDOWN_MS ?? "", 10);
	return Number.isInteger(n) && n >= 0 ? n : 60_000;
})();

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
	return { recycling: body.recycling === true, exits };
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
	onCooldown = false,
	inFlight = false,
	shortWindowMs = SWAP_MIN_RETRY_AFTER_MS,
} = {}) {
	if (!enabled) return { swap: false, reason: "disabled" };
	if (!exitId) return { swap: false, reason: "no_attribution" };
	if (inFlight) return { swap: false, reason: "in_flight" };
	if (onCooldown) return { swap: false, reason: "cooldown" };
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

/** Pure: rotate on the first warp 429 of a burst, never while cooling down. */
export function needsWarpRecycle(streak, onCooldown = false) {
	return !onCooldown && streak > 0;
}

let warp429Streak = 0;
let warpRecycles = 0;
let warpResends = 0;
let warpRecycleNotBefore = 0;
let warpRecycleInFlight = false;
let warpRecycleUnavailableWarned = false;
let warpSwapNotBefore = 0;
let warpSwapInFlight = false;
let warpSwaps = 0;
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
	if (Date.now() < warpRecycleNotBefore) return "cooldown";
	if (!config.warpProxy) return "no_proxy";
	return "not_confirmed";
}

/** S3: the manual trigger runs the automatic path — same cooldown, same
 *  single-flight guard, same drain, same confirmation. Nothing here is a second
 *  implementation of the rotation, and that is the whole point: a hand-rolled
 *  `POST /recycle` straight to the proxy is exactly the bug this replaces. */
export async function manualWarpRecycle(config) {
	const inFlightBefore = warpRecycleInFlight;
	const rotated = await rotateWarpExit(config, undefined);
	const reason = refusalReason(config, inFlightBefore, rotated);
	const result = {
		ok: rotated,
		rotated,
		warpMode: config.warpMode,
		warpRecycles,
		warp429Streak,
		cooldownMs: Math.max(0, warpRecycleNotBefore - Date.now()),
		delivering: deliveringWarpStreams,
	};
	if (reason) result.reason = reason;
	logWarpEvent(rotated ? "manual_recycle" : "manual_recycle_refused", {
		warpRecycles,
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
	warpRecycleNotBefore = 0;
	warpRecycleInFlight = false;
	warpResends = 0;
	warpSwapNotBefore = 0;
	warpSwapInFlight = false;
	warpSwaps = 0;
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
		warpSwapNotBefore,
		warpSwapInFlight,
		tunnelExit,
		warpRecycleNotBefore,
		warpRecycleInFlight,
		warpPreferred,
		lastEgress,
		localParkedUntil,
		deliveringWarpStreams,
	};
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

async function maybeRecycleWarp(config) {
	// One recycle at a time: a burst of concurrent 429s must not stack POSTs.
	// The cooldown is only armed once the proxy actually accepted the rotation —
	// arming it up front burnt five minutes on a /recycle that never landed.
	if (warpRecycleInFlight) return;
	if (!needsWarpRecycle(warp429Streak, Date.now() < warpRecycleNotBefore)) return;
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
	if (!needsWarpRecycle(warp429Streak, Date.now() < warpRecycleNotBefore)) return;
	warp429Streak = 0;
	warpRecycleInFlight = true;
	try {
		const res = await fetch(`${config.warpProxy}/recycle`, {
			method: "POST",
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		await res.arrayBuffer();
		warpRecycleNotBefore = Date.now() + RECYCLE_COOLDOWN_MS;
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

/** GET the proxy's health and reduce it to what the rotation poll reads. Every
 *  failure (refused, timeout, non-2xx, unparseable body) is just "no report":
 *  the poll keeps waiting and eventually falls back to the original 429. */
async function readWarpHealth(config) {
	try {
		const res = await fetch(warpHealthUrl(config.warpProxy, config.warpHealthPath), {
			signal: AbortSignal.timeout(2_000),
		});
		if (!res.ok) return undefined;
		return warpHealthState(await res.json());
	} catch {
		return undefined;
	}
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
 *  true only then: an unconfirmed rotation must not buy a resend, because the
 *  resend would leave through the same burnt IP and burn the one attempt.
 *  Concurrency: a rotation already in flight belongs to another handler, and
 *  the correct degradation is today's behaviour (deliver the 429) rather than
 *  stacking POSTs on the proxy. */
export async function rotateWarpExit(config, client) {
	// A rotation already inside its cooldown belongs to another handler: a second
	// POST would rotate the exit out from under that handler's in-flight resend
	// and hand this request a stream nobody can serve. The original 429 is the
	// honest answer, exactly as when a rotation is already in flight.
	if (Date.now() < warpRecycleNotBefore) {
		process.stderr.write(
			`pi-free-bridge relay: warp rotation is already within its cooldown — delivering the original 429\n`,
		);
		logWarpEvent("rotate_skipped", {
			reason: "cooldown",
			cooldownMs: Math.max(0, warpRecycleNotBefore - Date.now()),
		});
		return false;
	}
	if (warpRecycleInFlight) {
		logWarpEvent("rotate_skipped", { reason: "in_flight" });
		return false;
	}
	if (!config.warpProxy) {
		logWarpEvent("rotate_skipped", { reason: "no_proxy" });
		return false;
	}

	if (!(await drainBeforeRotation(client))) {
		logWarpEvent("rotate_skipped", {
			reason: "drain_refused",
			delivering: deliveringWarpStreams,
		});
		return false;
	}
	// The wait is an await: a peer may have rotated while we held on.
	if (Date.now() < warpRecycleNotBefore) {
		process.stderr.write(
			`pi-free-bridge relay: a warp rotation completed during the drain wait — delivering the original 429\n`,
		);
		logWarpEvent("rotate_skipped", {
			reason: "peer_rotated",
			cooldownMs: Math.max(0, warpRecycleNotBefore - Date.now()),
		});
		return false;
	}
	if (warpRecycleInFlight) {
		logWarpEvent("rotate_skipped", { reason: "in_flight" });
		return false;
	}
	warpRecycleInFlight = true;
	// This rotation pays for the 429s that asked for it.
	logWarpEvent("rotate_start", { streak: warp429Streak, delivering: deliveringWarpStreams });
	warp429Streak = 0;
	try {
		// Snapshot BEFORE the POST: the exit list is the only observable proof
		// that an exit was actually replaced.
		const before = await readWarpHealth(config);
		const res = await fetch(`${config.warpProxy}/recycle`, {
			method: "POST",
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		await res.arrayBuffer();
		// S12: the cooldown is armed only once the proxy accepted the rotation.
		warpRecycleNotBefore = Date.now() + RECYCLE_COOLDOWN_MS;
		warpRecycles += 1;

		const deadline = Date.now() + rotationTimeoutMs;
		let seenRecycling = false;
		while (Date.now() < deadline) {
			if (client && client.gone) return false; // S13: nobody to answer
			const state = await readWarpHealth(config);
			if (state && state.recycling) seenRecycling = true;
			if (isRotationConfirmed(before, state, seenRecycling)) {
				logWarpEvent("rotate_ok", { recycles: warpRecycles });
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, rotationPollMs));
		}
		logWarpEvent("rotate_failed", { reason: "not_confirmed" });
		return false;
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp rotation failed — ${reason}\n`);
		logWarpEvent("rotate_failed", { reason });
		return false;
	} finally {
		warpRecycleInFlight = false;
	}
}

/** The richer `/health` read: the rotation poll only needs names, but
 *  attribution needs the counters. Kept separate so the tested rotation path
 *  keeps its exact semantics. */
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

/** S7: rotate ONE exit instead of the whole pool. The proxy stops handing work
 *  to the target, re-enrolls only that exit, and keeps serving through the
 *  other one — one enrollment instead of N, and the pool is never left empty.
 *
 *  The drain wait is reused on purpose: our own deliveries are multiplexed over
 *  the target too, so replacing it still kills the streams riding it. It is
 *  cheap in the case this exists for, because by the time a 429 is being
 *  diagnosed nothing of ours is still streaming.
 *
 *  A `202` is acceptance, not completion: the caller must not resend on the
 *  strength of it alone. `409` (no standby) and `404` (unknown exit) are real
 *  answers, and both mean "do not insist now" — with two exits a 409 says the
 *  other one is already down, so hammering would only burn enrollments while
 *  the gate is rate-limiting. */
export async function swapWarpExit(config, exitId, client) {
	const decision = decideWarpSwap({
		exitId,
		enabled: WARP_SWAP_ENABLED,
		onCooldown: Date.now() < warpSwapNotBefore,
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
		if (res.status === 202) {
			warpSwapNotBefore = Date.now() + SWAP_COOLDOWN_MS;
			warpSwaps += 1;
			logWarpEvent("swap_ok", { exit: exitId, target });
			return { swapped: true, target };
		}
		warpSwapNotBefore = Date.now() + SWAP_COOLDOWN_MS;
		const reason =
			res.status === 409 ? "no_standby" : res.status === 404 ? "unknown_exit" : `HTTP ${res.status}`;
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

/** S7: turn "accepted" into "the other exit answers now". A `202` only means the
 *  proxy took the work, so waiting for the target to stop accepting (it goes
 *  `draining`, or the id disappears and comes back new) is the evidence the
 *  resend needs. A timeout is not a failure — one resend is still worth it. */
async function waitForSwapAcceptance(config, target) {
	if (!target) return false;
	const deadline = Date.now() + Math.min(rotationTimeoutMs, 5_000);
	while (Date.now() < deadline) {
		const snapshot = await readWarpSnapshot(config);
		if (snapshot) {
			const exit = snapshot.exits.find((candidate) => candidate.id === target);
			if (!exit || exit.state === "draining" || exit.state === "cooldown") return true;
		}
		await new Promise((resolve) => setTimeout(resolve, rotationPollMs));
	}
	logWarpEvent("swap_unconfirmed", { target });
	return false;
}

/** S5/S7/S10: one resend, only after a confirmed rotation, and always on the
 *  warp egress — the fresh IP lives there whatever order the chain used. Never
 *  a loop: the attempt happens once and only a non-error answer is adopted.
 *  Every refused resend — the same 429, a 5xx, or a 4xx from the fresh exit —
 *  hands back the original 429 byte-exact with its real status on stderr, so a
 *  real rate limit is never hidden behind a different error. Returns what it
 *  delivered and the egress that delivered it; `egress` is undefined when the
 *  original comes back, because then the original's own egress still stands. */
export async function resendAfterRotation(config, pathname, body, original, client) {
	const rebuildOriginal = () => ({
		egress: undefined,
		response: new Response(original.body, {
			status: original.status,
			headers: original.contentType ? { "content-type": original.contentType } : {},
		}),
	});

	if (!(await rotateWarpExit(config, client))) {
		process.stderr.write(
			`pi-free-bridge relay: warp rotation not confirmed — delivering the original ${original.status}\n`,
		);
		logWarpEvent("resend_skipped", { reason: "rotation_not_confirmed" });
		return rebuildOriginal();
	}

	let attempt;
	try {
		attempt = await egressFetch(config, pathname, { body: JSON.stringify(body) }, "warp");
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp resend after rotation failed — ${reason}\n`);
		logWarpEvent("resend_failed", { reason });
		return rebuildOriginal();
	}

	if (attempt.status < 400) {
		warp429Streak = bumpWarp429Streak(warp429Streak, attempt.status, "warp");
		warpResends += 1;
		process.stderr.write(
			`pi-free-bridge relay: warp resend after rotation delivered ${attempt.status} on the fresh exit IP\n`,
		);
		logWarpEvent("resend_ok", { status: attempt.status, egress: "warp", resends: warpResends });
		return { egress: "warp", response: attempt };
	}

	await attempt.arrayBuffer(); // drain for connection reuse
	// A 429 from the fresh exit is exit evidence like any other warp 429, so the
	// same helper the loop uses must count it; otherwise a second burnt exit
	// under-reports the streak and the next burst rotates late.
	warp429Streak = bumpWarp429Streak(warp429Streak, attempt.status, "warp");
	process.stderr.write(
		`pi-free-bridge relay: warp resend after rotation got ${attempt.status} — delivering the original ${original.status}\n`,
	);
	logWarpEvent("resend_refused", { status: attempt.status, delivered: original.status });
	return rebuildOriginal();
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

/** S13: marks a client that went away before the response finished. `close`
 *  also fires after a normal finish, so the `writableEnded` guard matters. */
function trackClient(res) {
	const tracker = { gone: false };
	res.on("close", () => {
		if (!res.writableEnded) tracker.gone = true;
	});
	return tracker;
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
				candidate = await egressFetch(config, pathname, { body: JSON.stringify(body) }, egress);
				// relay-warp-auto-recycle: count OBSERVED warp responses, not only
				// the delivered one — a warp 429 that falls back to a local
				// success must still extend the streak.
				if (egress === "warp") {
					warp429Streak = bumpWarp429Streak(warp429Streak, candidate.status, "warp");
					if (candidate.status === 429) {
						logWarpEvent("warp_429", { streak: warp429Streak, delivering: deliveringWarpStreams });
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
			const resend = await resendAfterRotation(
				config,
				pathname,
				body,
				{
					status: response.status,
					contentType: response.headers.get("content-type"),
					body: Buffer.from(await response.arrayBuffer()),
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

async function handle(req, res, config) {
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
			warpRecycles: warpRecycles,
			warpResends: warpResends,
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
