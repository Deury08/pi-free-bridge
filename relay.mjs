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
 *  `used` names the egress that produced the final response, `ok` says whether
 *  it was not a rate limit. */
export function updateWarpPreference(mode, used, ok) {
	if (mode !== "auto") return false;
	if (!ok) return false;
	return used === "warp";
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
		const parsed = JSON.parse(readFileSync(path, "utf8"));
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

async function forward(req, res, pathname, config) {
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
		for (const egress of order) {
			lastEgress = egress;
			let candidate;
			try {
				candidate = await egressFetch(config, pathname, { body: JSON.stringify(body) }, egress);
			} catch (err) {
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
		warpPreferred = updateWarpPreference(config.warpMode, lastEgress, true);

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
				`pi-free-bridge relay: upstream ${response.status} via ${lastEgress} ${toUpstreamUrl(config.upstream, pathname)}
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

		res.writeHead(response.status, { ...headers, "x-egress-used": lastEgress });

		if (!response.body) {
			res.end();
			return;
		}

		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
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
