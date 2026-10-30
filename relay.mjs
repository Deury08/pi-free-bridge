// pi-free-bridge relay — Bun fallback for the OpenCode free tier.
// 
// PREFERRED PATH: bridge-go (native Go binary, no Bun dependency)
//   Pi (Node) -> http://127.0.0.1:<port>/v1/chat/completions -> bridge-go (Go) -> upstream
//   bridge-go uses uTLS to impersonate Bun's ClientHello (JA4 t13d1713h1) and passes the gate.
//   Install: `npm install pi-free-bridge` (postinstall downloads bridge-go for your platform).
//   Or build locally: `cd bridge-go && go build -o bridge-go ./cmd/bridge-go`
//
// FALLBACK PATH (this file): Bun relay — kept for compatibility and rescue.
//   Pi runs on Node, and the `/inference/v1` gate rejects every request whose
//   TLS ClientHello is not Bun's (GATE-DIAGNOSIS.md §3.1). Pi therefore points its
//   provider at this local server, which makes the upstream call from Bun, injects
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
//   the `<env>` block and the tools the gate requires, and pipes the response back
//   byte-for-byte.
// 
//   Pi (Node) -> http://127.0.0.1:<port>/v1/chat/completions -> relay (Bun) -> upstream
//
// The module exports its pure helpers so `test/relay.test.mjs` can run them
// under plain Node; the server only starts when this file is executed directly.
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
// Proxy failover helpers (odd/tasks/proxy-failover.md S3-S6, S9, S10)
//
// Evidence (probe 2026-11): Bun's fetch honors the `proxy` option for
// http/https (CONNECT tunnel, the TLS ClientHello stays Bun's) and rejects
// `socks5://` with UnsupportedProxyProtocol. Pools are therefore http-only.
// ---------------------------------------------------------------------------

/**
 * Parse a raw proxy list into a Bun-usable pool (S5, S6). One entry per line;
 * `#` comments and blanks are dropped. Explicit schemes: only http/https
 * survive, socks4/socks5 are dropped. A bare `host:port` line becomes http.
 * Duplicates keep first position; `cap` bounds the result in listed order.
 */
export function parseProxyPool(text, { cap = 5 } = {}) {
	const seen = new Set();
	const pool = [];
	for (const rawLine of String(text ?? "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;

		let entry;
		if (/^https:\/\//i.test(line) || /^http:\/\//i.test(line)) {
			entry = line.toLowerCase();
		} else if (/^socks[45]:\/\//i.test(line)) {
			// Bun fetch drops this scheme outright; a dead entry in the pool would
			// burn one failover hop every request.
			continue;
		} else if (/^[^\s/:]+:\d+$/.test(line)) {
			entry = `http://${line.toLowerCase()}`;
		} else {
			continue;
		}

		if (seen.has(entry)) continue;
		seen.add(entry);
		pool.push(entry);
		if (pool.length >= cap) break;
	}
	return pool;
}

const DIRECT = "direct";

/**
 * Egress planner for forward(): direct-first with stick-to-last-healthy (S2,
 * S3). A plan is either `[lastGood]` while it lives, or the preference order
 * `[direct, ...alive proxies]`. Proxies are discarded until `discardMs` after
 * an error (S4); direct is never excluded from a fresh plan (S2): each fresh
 * attempt re-tests it, and a new egress cycle always starts there.
 */
export function createEgressPlanner({ proxies = [], now = Date.now, force = false } = {}) {
	let pool = [...proxies];
	let lastGood = null;
	let forced = Boolean(force);
	const discardedUntil = new Map();

	const alive = () => pool.filter((entry) => (discardedUntil.get(entry) ?? 0) <= now());

	return {
		/**
		 * Preference order for the next attempt cycle (S2-S4, S12). `force` is a
		 * per-call override so a single request never mutates shared state.
		 */
		plan(force) {
			if (lastGood && alive().includes(lastGood)) return [lastGood];
			// S12: forced mode puts the pool first and keeps direct as the last resort,
			// so a dead pool degrades to today's behavior instead of failing outright.
			const alivePool = alive();
			const forcing = force === undefined ? forced : Boolean(force);
			if (forcing && alivePool.length > 0) return [...alivePool, DIRECT];
			return [DIRECT, ...alivePool];
		},
		/** S12: whether the pool is preferred over direct by configuration. */
		isForced() {
			return forced;
		},
		/** S12: the egress that served the last successful attempt, for verification. */
		lastEgress() {
			return lastGood;
		},
		/** S3: stick to the candidate that served a successful request. */
		markGood(candidate) {
			if (candidate && candidate !== DIRECT) lastGood = candidate;
		},
		/** S4: discard until the deadline; direct only fails for one attempt. */
		markError(candidate, discardMs) {
			if (candidate && candidate !== DIRECT) discardedUntil.set(candidate, now() + discardMs);
		},
		/** S10: a pool refresh resets discards and takes the new list. */
		setProxies(next) {
			pool = [...next];
			discardedUntil.clear();
			if (lastGood && !pool.includes(lastGood)) lastGood = null;
		},
		/** S11: the pool as configured, ignoring discards, for diagnostics. */
		configured() {
			return [...pool];
		},
	};
}

/**
 * Bound exactly the time until upstream HEADERS arrive (S9): the caller settles
 * the deadline when fetch resolves, and the SSE stream after that runs
 * unbounded. `schedule`/`clear` stay injectable so the tests drive the clock.
 */
export function attemptDeadline(timeoutMs, { schedule = setTimeout, clear = clearTimeout } = {}) {
	const controller = new AbortController();
	const id = schedule(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		settle() {
			clear(id);
		},
	};
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

/** S31 precedence: an explicit override wins over the harvested id. */
async function resolveRelaySession() {
	const override = process.env.RELAY_SESSION?.trim();
	if (override) {
		const declared = process.env.RELAY_SESSION_SOURCE;
		return { sessionId: override, source: declared === "config" ? "config" : "env" };
	}
	return resolveSessionFromStore();
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

/**
 * One upstream attempt through `candidate` (S4, S9). Network errors and 429 are
 * retryable egress failures; everything else is returned to the caller as-is.
 * The attempt timeout bounds only the time until headers arrive; once fetch
 * resolves the deadline is settled and the stream runs unbounded.
 */
const RETRYABLE_STATUS = new Set([429, 407]);

async function attemptUpstream(candidate, upstreamUrl, config, forwardInit) {
	const proxyInit = candidate === DIRECT ? {} : { proxy: candidate };
	const deadline = attemptDeadline(config.attemptTimeoutMs);
	let upstream;
	try {
		upstream = await fetch(upstreamUrl, {
			...forwardInit,
			...proxyInit,
			signal: deadline.signal,
		});
	} catch (err) {
		deadline.settle();
		throw err;
	}
	deadline.settle();

	if (RETRYABLE_STATUS.has(upstream.status)) {
		try {
			await upstream.body?.cancel();
		} catch {
			// Releasing the discarded attempt is best-effort only.
		}
		throw new Error(`upstream ${upstream.status} via ${candidate}`);
	}
	return upstream;
}

/**
 * Direct-first failover loop (S2-S4): walk the planner's preference order and
 * return the first attempt that yields usable headers. Every failure is bound
 * to the pool refresh window and retried before anything reaches the client
 * socket (S8), so the client never sees a half-sent retry. Exhausting every
 * candidate surfaces the last underlying error as today's 502.
 */
async function fetchUpstream(config, forwardInit, pathname, force) {
	const upstreamUrl = toUpstreamUrl(config.upstream, pathname);
	const discardMs = config.discardMs;
	let lastError;
	for (const candidate of config.planner.plan(force)) {
		try {
			const upstream = await attemptUpstream(candidate, upstreamUrl, config, forwardInit);
			config.planner.markGood(candidate);
			return upstream;
		} catch (err) {
			lastError = err;
			config.planner.markError(candidate, discardMs);
		}
	}
	throw lastError ?? new Error("no egress candidate available");
}

// ---------------------------------------------------------------------------
// Proxy diagnostics (S11: a test mode for the pool)
// ---------------------------------------------------------------------------

/**
 * Probe one candidate by asking for the models surface through it. Any HTTP
 * response — even 404 — proves the tunnel works, so the check separates
 * "proxy is dead" from "upstream dislikes the request". `direct` is probed
 * with no proxy so the caller can compare. Never throws.
 */
async function probeCandidate(candidate, upstreamUrl, timeoutMs) {
	const startedAt = Date.now();
	const deadline = attemptDeadline(timeoutMs);
	try {
		const response = await fetch(`${upstreamUrl.replace(/\/+$/, "")}/models`, {
			method: "GET",
			...(candidate === DIRECT ? {} : { proxy: candidate }),
			signal: deadline.signal,
		});
		deadline.settle();
		try {
			await response.body?.cancel();
		} catch {
			// Draining the probe response is best-effort.
		}
		return { candidate, ok: true, status: response.status, latencyMs: Date.now() - startedAt };
	} catch (err) {
		deadline.settle();
		return {
			candidate,
			ok: false,
			error: err && err.message ? err.message : String(err),
			latencyMs: Date.now() - startedAt,
		};
	}
}

/**
 * S11 test mode: probe every configured candidate concurrently and report the
 * pool, the effective preference order and per-proxy reachability. Ordered
 * `direct` first, then the pool as configured, so the output mirrors the real
 * failover preference.
 */
async function probeEgress(config) {
	const upstreamUrl = String(config.upstream ?? "");
	const candidates = [DIRECT, ...config.planner.configured()];
	const results = await Promise.all(
		candidates.map((candidate) => probeCandidate(candidate, upstreamUrl, config.attemptTimeoutMs)),
	);
	return {
		service: SERVICE,
		upstream: upstreamUrl,
		forced: config.planner.isForced(),
		lastEgress: config.planner.lastEgress(),
		preference: config.planner.plan(),
		candidates: results,
	};
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

		// S12: `x-free-bridge-force-proxy: 1` prefers the pool for THIS request only,
		// so e2e can exercise the proxy path without burning the direct quota. An
		// absent header must stay `undefined`, otherwise it would override the
		// configured force flag with false.
		const forceHeader = String(req.headers["x-free-bridge-force-proxy"] ?? "").trim();
		const force =
			forceHeader === "" ? undefined : forceHeader === "1" || forceHeader.toLowerCase() === "true";

		const forwardInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": config.userAgent,
				authorization: `Bearer ${config.apiKey}`,
				"x-opencode-session": config.session,
				"x-opencode-session-id": config.session,
			},
			body: JSON.stringify(body),
		};

		const upstream = await fetchUpstream(config, forwardInit, pathname, force);

		// S20: status and content-type pass through, the body is piped unparsed.
		const headers = {};
		const contentType = upstream.headers.get("content-type");
		if (contentType) headers["content-type"] = contentType;
		res.writeHead(upstream.status, headers);

		if (!upstream.body) {
			res.end();
			return;
		}

		const reader = upstream.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(Buffer.from(value));
		}
		res.end();
	} catch (err) {
		process.stderr.write(`pi-free-bridge relay: forward error — ${err && err.message ? err.message : String(err)}
`);
		sendJson(res, 502, { error: { message: err && err.message ? err.message : String(err) } });
	}
}

async function handle(req, res, config) {
	const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");

	if (req.method === "GET" && pathname === "/health") {
		// S33: the marker stays `service` + `ok`; the extra fields let the
		// extension report which id is actually on the wire.
		sendJson(res, 200, {
			service: SERVICE,
			ok: true,
			sessionId: config.session,
			sessionSource: config.sessionSource,
			proxyForced: config.planner.isForced(),
			lastEgress: config.planner.lastEgress(),
		});
		return;
	}

	if (req.method === "GET" && pathname === "/proxies") {
		// S11: the test mode — reachability of every configured egress.
		await probeEgress(config).then(
			(payload) => sendJson(res, 200, payload),
			(err) => sendJson(res, 502, { error: { message: err && err.message ? err.message : String(err) } }),
		);
		return;
	}

	if (req.method === "POST" && pathname.startsWith("/v1/")) {
		await forward(req, res, pathname, config);
		return;
	}

	sendJson(res, 404, { error: { message: `no route for ${req.method} ${pathname}` } });
}

// ---------------------------------------------------------------------------
// Proxy pool bootstrapping (S5, S6, S10)
// ---------------------------------------------------------------------------

const DEFAULT_PROXY_MAX = 5;
const DEFAULT_REFRESH_MINUTES = 30;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;

function intEnv(name, fallback) {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function commaListEnv(name) {
	return (process.env[name] ?? "").split(",").filter(Boolean).join("\n");
}

/**
 * Refresh the planner pool from RELAY_PROXY_SOURCE (S10). Every failure keeps
 * the previous list and only complains on stderr; stdout is reserved for the
 * single startup line.
 */
async function refreshProxyPool(config, planner) {
	try {
		const deadline = attemptDeadline(10_000);
		const response = await fetch(config.proxySource, { signal: deadline.signal });
		deadline.settle();
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const text = await response.text();
		const next = parseProxyPool(text, { cap: config.proxyMax });
		if (next.length === 0) throw new Error("source yielded no usable http proxy");
		planner.setProxies(next);
		process.stderr.write(
			`pi-free-bridge relay: proxy pool refreshed (${next.length} candidates)\n`,
		);
	} catch (err) {
		process.stderr.write(
			`pi-free-bridge relay: proxy pool refresh failed, keeping previous pool — ${
				err && err.message ? err.message : String(err)
			}\n`,
		);
	}
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

	const refreshMs = intEnv("RELAY_PROXY_REFRESH_MINUTES", DEFAULT_REFRESH_MINUTES) * 60_000;
	const config = {
		upstream: process.env.RELAY_UPSTREAM || DEFAULT_UPSTREAM,
		session: session.sessionId,
		sessionSource: session.source,
		cwd: process.env.RELAY_CWD || process.cwd(),
		userAgent: process.env.RELAY_USER_AGENT || DEFAULT_USER_AGENT,
		apiKey: process.env.RELAY_API_KEY || "public",
		attemptTimeoutMs: intEnv("RELAY_PROXY_TIMEOUT_MS", DEFAULT_ATTEMPT_TIMEOUT_MS),
		proxyMax: intEnv("RELAY_PROXY_MAX", DEFAULT_PROXY_MAX),
		proxySource: process.env.RELAY_PROXY_SOURCE?.trim() || null,
		discardMs: refreshMs,
	};

	// S2: with no proxy configured the planner degenerates to direct-only and
	// forward() takes the exact pre-failover code path.
	const staticPool = parseProxyPool(commaListEnv("RELAY_PROXY_STATIC"), { cap: config.proxyMax });
	const forced = /^(1|true|yes)$/i.test((process.env.RELAY_PROXY_FORCE ?? "").trim());
	const planner = createEgressPlanner({ proxies: staticPool, force: forced });
	config.planner = planner;

	if (config.proxySource) {
		const refresh = () => void refreshProxyPool(config, planner);
		refresh();
		const timer = setInterval(refresh, refreshMs);
		// A dead timer must not keep Bun (and Pi's child) alive on its own.
		timer.unref?.();
	}

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
