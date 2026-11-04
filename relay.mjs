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
	existsSync,
	readFileSync,
	readdirSync,
	realpathSync,
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

/** Pure: the egress order for one request. */
export function egressOrder(mode, warpPreferred) {
	if (mode === "on") return ["warp"];
	if (mode === "auto") return warpPreferred ? ["warp", "local"] : ["local", "warp"];
	return ["local"];
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

/** Pure: S18's kill switch. Only an explicit `0` turns the resend off; unset,
 *  empty or garbage all mean "on", so a typo cannot silently disable it. */
export function warpResendEnabled(value) {
	return String(value ?? "").trim() !== "0";
}

const WARP_RESEND_ENABLED = warpResendEnabled(process.env.RELAY_WARP_RETRY_AFTER_RECYCLE);
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
	warpPreferred = false;
	lastEgress = undefined;
}

/** Test-only: the state `/health` reports, without standing a server up. */
export function warpStateForTests() {
	return {
		warp429Streak,
		warpRecycles,
		warpResends,
		warpRecycleNotBefore,
		warpRecycleInFlight,
		warpPreferred,
		lastEgress,
	};
}

/** Test-only: shrink the rotation window; a real rotation poll would cost the
 *  suite 10s per case. Called with no arguments it restores the production
 *  defaults (10_000ms timeout, 250ms poll), which are the contract. */
export function setWarpRotationTimingForTests(timeoutMs, pollMs) {
	rotationTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : ROTATION_TIMEOUT_MS;
	rotationPollMs = Number.isFinite(pollMs) ? pollMs : ROTATION_POLL_MS;
}

async function maybeRecycleWarp(config) {
	// One recycle at a time: a burst of concurrent 429s must not stack POSTs.
	// The cooldown is only armed once the proxy actually accepted the rotation —
	// arming it up front burnt five minutes on a /recycle that never landed.
	if (warpRecycleInFlight) return;
	if (!needsWarpRecycle(warp429Streak, Date.now() < warpRecycleNotBefore)) return;
	warp429Streak = 0;
	if (!config.warpProxy) return;
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
		return false;
	}
	if (warpRecycleInFlight) return false;
	if (!config.warpProxy) return false;
	warpRecycleInFlight = true;
	// This rotation pays for the 429s that asked for it.
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
			if (isRotationConfirmed(before, state, seenRecycling)) return true;
			await new Promise((resolve) => setTimeout(resolve, rotationPollMs));
		}
		return false;
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp rotation failed — ${reason}\n`);
		return false;
	} finally {
		warpRecycleInFlight = false;
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
		return rebuildOriginal();
	}

	let attempt;
	try {
		attempt = await egressFetch(config, pathname, { body: JSON.stringify(body) }, "warp");
	} catch (err) {
		const reason = err && err.message ? err.message : String(err);
		process.stderr.write(`pi-free-bridge relay: warp resend after rotation failed — ${reason}\n`);
		return rebuildOriginal();
	}

	if (attempt.status < 400) {
		warp429Streak = bumpWarp429Streak(warp429Streak, attempt.status, "warp");
		warpResends += 1;
		process.stderr.write(
			`pi-free-bridge relay: warp resend after rotation delivered ${attempt.status} on the fresh exit IP\n`,
		);
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
	return rebuildOriginal();
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

async function forward(req, res, pathname, config) {
	const client = trackClient(res);
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
		const order = egressOrder(config.warpMode, warpPreferred);
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
					// S10: the trigger is the whole request, not the last egress — in
					// either `auto` order, a 429 observed through warp is exit evidence
					// even when a local fallback delivered something else. Mode `off`
					// never reaches warp at all, so it keeps today's behavior by
					// construction (S9).
					if (candidate.status === 429) sawWarp429 = true;
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

		// S20: status and content-type pass through, the body is piped unparsed.
		const headers = {};
		const contentType = response.headers.get("content-type");
		if (contentType) headers["content-type"] = contentType;

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
	}
}

async function handle(req, res, config) {
	// Hot reload (relay-warp-hot-reload): one cheap config re-read per request
	// drives both /health and /v1.
	refreshWarpMode(config);

	const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");

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
