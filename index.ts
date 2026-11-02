import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider id is load-bearing: settings.json, gentle-ai profiles and subagents
 *  all reference `oc-sdk-zen/<model>`. Do not rename it (HANDOFF D2). */
const PROVIDER = "oc-sdk-zen";

/** The free tier moved here from the retired Zen surface, which is now hard-403
 *  for every client outside the official CLI (HANDOFF §4.1).
 *
 *  This is the upstream the relay calls, not the URL Pi talks to: the gate now
 *  rejects every Node TLS client, so Pi points at the local Bun relay instead
 *  (GATE-DIAGNOSIS.md §3.1, §5). */
const UPSTREAM_URL = "https://opencode.ai/inference/v1";
const API = "openai-completions" as const;

/** The free tier needs no API key: any bearer value passes, and the literal
 *  "public" keeps credentials out of the repo and out of auth.json. */
const API_KEY = "public";

/** User-agent must contain "opencode/" or the gate answers 403 (HANDOFF §4.2).
 *  The Pi path uses the relay's copy; this one stays for the registry refresh. */
const USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

const REGISTRY_PATHS = [
	join(homedir(), ".cache", "opencode", "models.json"),
	join(homedir(), ".config", "opencode", "models.json"),
];

/** Optional user config: `{ "sessionId": "ses_…", "liveIds": ["…"] }`. */
export const BRIDGE_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge.json");

/** Pi's global settings. Pi scopes the model picker to `enabledModels`, so a
 *  non-empty list means "show ONLY these" — see ensureEnabledPattern. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** The scope entry the bridge needs. A glob, not literal ids: the bridge
 *  registers its models at runtime, so literal ids hide anything new. */
const SCOPE_PATTERN = `${PROVIDER}/*`;

/** Free ids the surface actually advertised on 2026-10-25.
 *
 *  Registration stays offline and deterministic: intersecting the registry with
 *  `GET /inference/v1/models` on every launch would put a network round-trip on
 *  the startup path. Refresh the snapshot with `/free-bridge-refresh`, which
 *  fetches the live list and persists it to BRIDGE_CONFIG_PATH.
 *
 *  This list is what a **fresh install** registers before the user runs
 *  `/free-bridge-refresh`, so a stale entry here is a permanently broken model
 *  in someone else's picker. `longcat-2.5-preview-free` and
 *  `minimax-m3.1-flash-free` were dropped on 2026-10-25 because the surface no
 *  longer advertises them; `flint-40b-free` was added. */
const SNAPSHOT_LIVE_FREE_IDS = [
	"beam-free",
	"big-pickle",
	"deepseek-v4.1-flash-free",
	"flint-40b-free",
	"glm-5.3-flash-free",
	"mimo-v2.6-flash-free",
	"nemotron-3.5-lightning-free",
	"nemotron-3.5-super-vl-free",
];

/** Models the surface advertises but cannot serve over chat/completions:
 *  400 ModelProtocolUnsupported on /inference/v1, 403 on /messages (HANDOFF D5). */
const EXCLUDED_MODELS = new Set([
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free",
	"jev-1.13-free",
]);

const REG_KEY = Symbol.for("pi-free-bridge:registered");

// ---------------------------------------------------------------------------
// Picker scope (enabledModels)
// ---------------------------------------------------------------------------

/** Pi does not show every registered model. It scopes the picker to
 *  `enabledModels` in its global settings: an empty/absent list is unscoped
 *  (everything shows), a non-empty list shows ONLY those entries. The bridge
 *  registers `oc-sdk-zen/*` at runtime, so a list that omits it hides every free
 *  model — while `pi --list-models` still reports all of them, because the CLI
 *  reads a different source (getAvailable) than the picker (scopedModels).
 *
 *  The repair below is append-only and idempotent: it never removes, reorders
 *  or rewrites an existing entry, and never touches any other settings key. */
export type EnabledPatternResult =
	| { status: "unchanged" }
	| { status: "added"; text: string; previousCount: number }
	| { status: "malformed"; reason: string };

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Locate the `enabledModels` array literal in the raw text.
 *
 *  Returns the offsets of `[` and `]`, or null. Only meaningful once JSON.parse
 *  has already confirmed the value is a non-empty array of strings, which is
 *  what makes the string-aware scan below safe. */
function findEnabledModelsArray(text: string): { open: number; close: number } | null {
	const key = text.indexOf('"enabledModels"');
	if (key === -1) return null;

	let i = key + '"enabledModels"'.length;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (text[i] !== ":") return null;
	i++;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (text[i] !== "[") return null;

	const open = i;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (i = open; i < text.length; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) return { open, close: i };
		}
	}
	return null;
}

/** Byte offset just past the last complete string entry of an array of strings.
 *  Scans forward so escapes inside entries cannot fool it. */
function lastEntryEnd(text: string, open: number, close: number): number | null {
	let i = open + 1;
	let inStr = false;
	let esc = false;
	let end = -1;
	for (; i < close; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') {
				inStr = false;
				end = i + 1;
			}
			continue;
		}
		if (ch === '"') inStr = true;
	}
	return end === -1 ? null : end;
}

/** The line ending this file already uses, taken from its first line break. */
function detectEol(text: string): string {
	const lf = text.indexOf("\n");
	if (lf === -1) return "\n";
	return text[lf - 1] === "\r" ? "\r\n" : "\n";
}

/** Leading whitespace of the line containing `pos`, or "" if it is not the
 *  first thing on its line. */
function lineIndent(text: string, pos: number): string {
	const start = text.lastIndexOf("\n", pos - 1) + 1;
	let i = start;
	while (i < pos && (text[i] === " " || text[i] === "\t")) i++;
	return i === pos ? "" : text.slice(start, i);
}

export function ensureEnabledPattern(rawText: string, pattern: string): EnabledPatternResult {
	if (typeof rawText !== "string" || rawText.trim() === "") {
		return { status: "malformed", reason: "settings.json is empty or unreadable" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(rawText));
	} catch (err) {
		return { status: "malformed", reason: `invalid JSON: ${(err as Error).message}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { status: "malformed", reason: "settings.json is not a JSON object" };
	}

	const settings = parsed as Record<string, unknown>;
	const enabled = settings.enabledModels;

	if (enabled === undefined) {
		// Absent leaves the picker unscoped — every model already shows. Appending
		// the glob there would *narrow* the picker, so there is nothing to repair.
		return { status: "unchanged" };
	}
	if (!Array.isArray(enabled)) {
		return { status: "malformed", reason: "enabledModels is not an array" };
	}
	if (enabled.length === 0) {
		// Same as absent: an empty list leaves the picker unscoped.
		return { status: "unchanged" };
	}
	if (!enabled.every((v) => typeof v === "string")) {
		return { status: "malformed", reason: "enabledModels contains a non-string entry" };
	}
	if (enabled.includes(pattern)) {
		return { status: "unchanged" };
	}

	// Splice the new entry into the raw text rather than re-serializing the whole
	// document. JSON.parse -> JSON.stringify round-trips would rewrite every byte
	// outside this array: it normalises CRLF to LF, collapses duplicate keys, and
	// silently rounds integers above 2^53. This file belongs to Pi and to the
	// user's editor, so the repair has to leave every other byte exactly as it
	// found it.
	const body = stripBom(rawText);
	const span = findEnabledModelsArray(body);
	if (!span) return { status: "malformed", reason: "could not locate the enabledModels array" };

	const anchor = lastEntryEnd(body, span.open, span.close);
	if (anchor === null) {
		return { status: "malformed", reason: "enabledModels array could not be scanned" };
	}

	const head = body.slice(span.open + 1, anchor);
	// A single-line array keeps the new entry on that line; a multi-line one
	// matches the indentation and line ending the file already uses.
	const inline = !head.includes("\n");
	const insertion = inline
		? `, ${JSON.stringify(pattern)}`
		: `,${detectEol(body)}${lineIndent(body, anchor)}${JSON.stringify(pattern)}`;

	const text = body.slice(0, anchor) + insertion + body.slice(anchor);

	// Belt and braces: never emit a write we have not proven changes exactly one
	// field and keeps the array contents.
	try {
		const reparsed = JSON.parse(text) as Record<string, unknown>;
		const expected = { ...settings, enabledModels: [...enabled, pattern] };
		if (JSON.stringify(reparsed) !== JSON.stringify(expected)) {
			return { status: "malformed", reason: "repaired settings.json did not round-trip" };
		}
	} catch (err) {
		return { status: "malformed", reason: `repaired settings.json is invalid: ${(err as Error).message}` };
	}

	return { status: "added", text, previousCount: enabled.length };
}

/** Append `oc-sdk-zen/*` to the given settings file if it is missing.
 *
 *  `PI_FREE_BRIDGE_SELF_REPAIR=0` disables the write here, not at the call site,
 *  so no caller — including /free-bridge-doctor — can bypass it. */
export function repairEnabledModels(settingsPath: string = SETTINGS_PATH): EnabledPatternResult {
	if (process.env.PI_FREE_BRIDGE_SELF_REPAIR === "0") {
		return { status: "unchanged" };
	}

	let raw: string;
	try {
		raw = readFileSync(settingsPath, "utf-8");
	} catch (err) {
		return { status: "malformed", reason: `could not read ${settingsPath}: ${(err as Error).message}` };
	}

	const result = ensureEnabledPattern(raw, SCOPE_PATTERN);
	if (result.status !== "added") return result;

	try {
		writeFileSync(settingsPath, result.text, "utf-8");
	} catch (err) {
		return { status: "malformed", reason: `could not write ${settingsPath}: ${(err as Error).message}` };
	}
	return result;
}

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

type BridgeConfig = {
	sessionId?: string;
	liveIds?: string[];
	relayPort?: number;
	/** "off" | "auto" | "on" (bun-upgrades S5); anything else reads as off. */
	warpEnabled?: string;
	/** Path to the warp-minimal binary for supervised spawning. */
	warpBin?: string;
};

function readBridgeConfig(): BridgeConfig {
	if (!existsSync(BRIDGE_CONFIG_PATH)) return {};
	try {
		const raw = readFileSync(BRIDGE_CONFIG_PATH, "utf-8");
		// Windows editors leave a UTF-8 BOM; JSON.parse rejects it.
		const cfg = JSON.parse(raw.startsWith("﻿") ? raw.slice(1) : raw);
		return cfg && typeof cfg === "object" ? (cfg as BridgeConfig) : {};
	} catch {
		// malformed config falls back to the built-in defaults
		return {};
	}
}

function writeBridgeConfig(patch: BridgeConfig): void {
	const merged = { ...readBridgeConfig(), ...patch };
	try {
		writeFileSync(BRIDGE_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		return true;
	} catch (err) {
		console.error(`pi-free-bridge: could not write ${BRIDGE_CONFIG_PATH}: ${(err as Error).message}`);
		return false;
	}
}

/** `~/.local/share/opencode`, the store the official client writes. */
const OPENCODE_SHARE_DIR = join(homedir(), ".local", "share", "opencode");

/** Newest `storage/session_diff/ses_*.json` file name, by mtime (fs only). */
function harvestSessionFromDiff(shareDir: string = OPENCODE_SHARE_DIR): string | undefined {
	const diffDir = join(shareDir, "storage", "session_diff");
	let entries: string[];
	try {
		entries = readdirSync(diffDir);
	} catch {
		return undefined;
	}
	let newest: { id: string; mtimeMs: number } | undefined;
	for (const name of entries) {
		if (!name.startsWith("ses_") || !name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		if (!/^ses_/.test(id)) continue;
		try {
			const stats = statSync(join(diffDir, name));
			if (!stats.isFile()) continue;
			if (!newest || stats.mtimeMs > newest.mtimeMs) newest = { id, mtimeMs: stats.mtimeMs };
		} catch {
			continue;
		}
	}
	return newest?.id;
}

/** Newest `session` row from `opencode.db` via `node:sqlite` when available.
 *  Synchronous best-effort: a missing module, table or permission returns
 *  undefined and lets the caller fall through to the diff harvest. */
function harvestSessionFromDb(shareDir: string = OPENCODE_SHARE_DIR): string | undefined {
	const dbPath = join(shareDir, "opencode.db");
	if (!existsSync(dbPath)) return undefined;
	try {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as { DatabaseSync?: unknown };
		if (typeof DatabaseSync !== "function") return undefined;
		const db = new (DatabaseSync as new (path: string, opts?: object) => {
			query(sql: string): { all(): { id?: unknown }[] };
			close(): void;
		})(dbPath, { readOnly: true });
		try {
			const rows = db.query("select id from session order by time_created desc limit 5").all();
			for (const row of rows) {
				if (row && typeof row.id === "string" && row.id.startsWith("ses_")) return row.id;
			}
		} finally {
			db.close();
		}
	} catch {
		// Node without node:sqlite, missing table, locked db: fall through.
	}
	return undefined;
}

/** bun-upgrades S2: the extension harvests the same store the relay targets,
 *  so Pi can run on a machine without OpenCode while the relay runs elsewhere
 *  (or vice versa). db first, diff fallback, `undefined` when neither yields. */
function harvestSessionId(): { sessionId: string; source: "harvest:opencode.db" | "harvest:session-diff" } | undefined {
	const fromDb = harvestSessionFromDb();
	if (fromDb) return { sessionId: fromDb, source: "harvest:opencode.db" };
	const fromDiff = harvestSessionFromDiff();
	if (fromDiff) return { sessionId: fromDiff, source: "harvest:session-diff" };
	return undefined;
}

/** bun-upgrades S2 precedence: user override, then the extension's own
 *  harvest; an absent/failed harvest lets the relay fall back to its local
 *  store (unchanged S31 path, still no synthetic id is ever minted). */
function resolveSessionId(): { sessionId?: string; source: string } {
	const fromEnv = process.env.PI_FREE_BRIDGE_SESSION_ID?.trim();
	if (fromEnv) return { sessionId: fromEnv, source: "env" };

	const fromConfig = readBridgeConfig().sessionId?.trim();
	if (fromConfig) return { sessionId: fromConfig, source: "config" };

	const harvested = harvestSessionId();
	if (harvested) return harvested;

	return { source: "none" };
}

function resolveLiveIds(): { liveIds: Set<string>; source: string } {
	const fromConfig = readBridgeConfig().liveIds;
	if (Array.isArray(fromConfig) && fromConfig.length > 0) {
		return { liveIds: new Set(fromConfig), source: BRIDGE_CONFIG_PATH };
	}
	return { liveIds: new Set(SNAPSHOT_LIVE_FREE_IDS), source: "built-in snapshot (2026-10-14)" };
}

/** WARP egress modes (bun-upgrades S5). */
const WARP_MODES: readonly string[] = ["off", "auto", "on"];

function normalizeWarpMode(value: unknown): string | undefined {
	const mode = String(value ?? "").trim().toLowerCase();
	return WARP_MODES.includes(mode) ? mode : undefined;
}

/** S5 precedence: env override, persisted config, default off. */
function resolveWarpMode(): string {
	return (
		normalizeWarpMode(process.env.PI_FREE_BRIDGE_WARP_MODE) ??
		normalizeWarpMode(readBridgeConfig().warpEnabled) ??
		"off"
	);
}

// ---------------------------------------------------------------------------
// Relay supervisor
// ---------------------------------------------------------------------------
//
// Pi runs on Node, and the `/inference/v1` gate now only accepts a Bun TLS
// client (GATE-DIAGNOSIS.md §3.1). The extension therefore points the provider
// at a loopback relay executed by Bun; the relay owns the gate headers, the
// `<env>` block, the tools gate and the raw response pipe.

const RELAY_DEFAULT_PORT = 8788;
const RELAY_HOST = "127.0.0.1";
const RELAY_SERVICE = "pi-free-bridge-relay";

/** The relay ships next to this file (see `package.json → files`). */
const RELAY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "relay.mjs");

/** How long the relay may take to print its listening line. */
const RELAY_START_TIMEOUT_MS = 5000;

type RelayMode = "spawned" | "reused";

type RelayOptions = {
	port: number;
	/** Only an explicit user override; when absent the relay harvests one. */
	sessionId?: string;
	sessionSource?: string;
	upstream: string;
	/** off | auto | on (bun-upgrades S5); resolved by ensureRelay when absent. */
	warpMode?: string;
	cwd: string;
};

type RelayResult = {
	url: string;
	mode: RelayMode;
};

type RelayState = RelayResult & {
	key: string;
	child?: ChildProcess;
};

let relayState: RelayState | undefined;
let relayPending: { key: string; promise: Promise<RelayResult> } | undefined;

function parsePort(value: unknown): number | undefined {
	const port = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** S26: env override, then the persisted config key, then the default. */
function resolveRelayPort(): number {
	return (
		parsePort(process.env.PI_FREE_BRIDGE_RELAY_PORT) ??
		parsePort(readBridgeConfig().relayPort) ??
		RELAY_DEFAULT_PORT
	);
}

function relayUrl(port: number): string {
	return `http://${RELAY_HOST}:${port}/v1`;
}

function relayHealthUrl(port: number): string {
	return `http://${RELAY_HOST}:${port}/health`;
}

/** S27: `PI_FREE_BRIDGE_BUN`, then `bun` on PATH, then `~/.bun/bin/bun.exe`.
 *  PATH is split by hand instead of shelled out, so this stays synchronous and
 *  side-effect free. */
function resolveBunPath(): string | undefined {
	const override = process.env.PI_FREE_BRIDGE_BUN?.trim();
	if (override && existsSync(override)) return override;

	const binary = process.platform === "win32" ? "bun.exe" : "bun";
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const directory = entry.replace(/^"|"$/g, "");
		if (!directory) continue;
		const candidate = join(directory, binary);
		if (existsSync(candidate)) return candidate;
	}

	const fallback = join(homedir(), ".bun", "bin", binary);
	return existsSync(fallback) ? fallback : undefined;
}

/** Probe a port for our own relay. `absent` means nothing is listening there. */
async function probeRelay(port: number): Promise<"healthy" | "foreign" | "absent"> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 750);
	try {
		const res = await fetch(relayHealthUrl(port), { signal: controller.signal });
		if (!res.ok) return "foreign";
		const payload = (await res.json()) as { service?: unknown };
		return payload?.service === RELAY_SERVICE ? "healthy" : "foreign";
	} catch {
		return "absent";
	} finally {
		clearTimeout(timer);
	}
}

function waitForListening(child: ChildProcess, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const expected = `pi-free-bridge relay listening on http://${RELAY_HOST}:${port}/v1`;
		let stdout = "";
		let stderr = "";

		const cleanup = () => {
			clearTimeout(timer);
			child.stdout?.off("data", onStdout);
			child.stderr?.off("data", onStderr);
			child.off("exit", onExit);
			child.off("error", onError);
		};
		const fail = (message: string) => {
			cleanup();
			reject(new Error(message));
		};

		const timer = setTimeout(() => {
			child.kill();
			fail(
				`pi-free-bridge: the relay did not start within ${RELAY_START_TIMEOUT_MS / 1000}s` +
					(stderr.trim() ? ` — ${stderr.trim()}` : ""),
			);
		}, RELAY_START_TIMEOUT_MS);

		const onStdout = (chunk: Buffer | string) => {
			stdout += String(chunk);
			if (!stdout.includes(expected)) return;
			cleanup();
			resolve();
		};
		const onStderr = (chunk: Buffer | string) => {
			stderr += String(chunk);
		};
		const onExit = (code: number | null) => {
			fail(
				`pi-free-bridge: the relay exited before listening (code ${code})` +
					(stderr.trim() ? ` — ${stderr.trim()}` : ""),
			);
		};
		const onError = (err: Error) => {
			fail(`pi-free-bridge: could not start bun — ${err.message}`);
		};

		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.on("exit", onExit);
		child.on("error", onError);
	});
}

/** Kill the child when Pi exits. Signals are handled only when no one else owns
 *  them, so Pi's own Ctrl+C handling keeps working. */
function installRelayExitHooks(child: ChildProcess): void {
	const kill = () => {
		if (!child.killed) child.kill();
	};

	process.once("exit", kill);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			kill();
			// `once` removes this listener before invoking it, so a non-zero count
			// here means the host (Pi) has its own handler and owns the decision.
			if (process.listenerCount(signal) === 0) {
				process.exit(signal === "SIGINT" ? 130 : 143);
			}
		});
	}
}

/** A piped child keeps the parent's event loop alive. The relay is a helper, not
 *  a reason for Pi to stay running, so its handles are detached once it is up;
 *  the exit hooks above still take it down. */
function detachRelayHandles(child: ChildProcess): void {
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		(stream as unknown as { unref?: () => void } | null)?.unref?.();
	}
	child.unref();
}

/** Child environment. RELAY_SESSION is only set for an explicit override;
 *  RELAY_SESSION_PI carries the id the extension harvested from Pi's machine
 *  (bun-upgrades S2, remote OpenCode); when neither exists the relay harvests
 *  from its own local store (S31). */
export function relayEnv(options: RelayOptions): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PORT: String(options.port),
		RELAY_UPSTREAM: options.upstream,
		RELAY_CWD: options.cwd,
		// relay-warp-hot-reload: the relay resolves the warp mode per request from
		// this file; RELAY_WARP_MODE is only injected when PI_FREE_BRIDGE_WARP_MODE
		// is a real env override (absolute precedence preserved, by design).
		RELAY_CONFIG_PATH: BRIDGE_CONFIG_PATH,
	};

	const envWarpOverride = normalizeWarpMode(process.env.PI_FREE_BRIDGE_WARP_MODE);
	delete env.RELAY_WARP_MODE;
	if (envWarpOverride) env.RELAY_WARP_MODE = envWarpOverride;

	if (options.sessionId) {
		const source = options.sessionSource ?? "env";
		if (source === "env" || source === "config") {
			env.RELAY_SESSION = options.sessionId;
			env.RELAY_SESSION_SOURCE = source;
		} else {
			// The extension's own harvest: a different channel, lower
			// precedence than any explicit override.
			env.RELAY_SESSION_PI = options.sessionId;
		}
	}
	// Never leak an id from a previous scope into a relay that must resolve
	// its own.
	delete env.PI_FREE_BRIDGE_SESSION_ID;
	if (env.RELAY_SESSION !== options.sessionId) {
		delete env.RELAY_SESSION;
		delete env.RELAY_SESSION_SOURCE;
	}
	if (env.RELAY_SESSION_PI !== options.sessionId) delete env.RELAY_SESSION_PI;
	return env;
}

async function startRelay(options: RelayOptions, key: string): Promise<RelayState> {
	const url = relayUrl(options.port);
	const probe = await probeRelay(options.port);

	if (probe === "healthy") {
		return { key, url, mode: "reused" };
	}
	if (probe === "foreign") {
		// S26: a foreign service on the port is a hard error with actionable text.
		throw new Error(
			`pi-free-bridge: port ${options.port} is already used by another service; ` +
				`set PI_FREE_BRIDGE_RELAY_PORT (or "relayPort" in ${BRIDGE_CONFIG_PATH}) to a free port.`,
		);
	}

	const bun = resolveBunPath();
	if (!bun) {
		// S27: never degrade into a silent 429.
		throw new Error(
			"pi-free-bridge: bun is required for the free-tier relay but was not found. " +
				"Install Bun (https://bun.sh) or set PI_FREE_BRIDGE_BUN to the bun executable.",
		);
	}

	const child = spawn(bun, [RELAY_SCRIPT], {
		stdio: ["pipe", "pipe", "pipe"],
		env: relayEnv(options),
	});

	try {
		await waitForListening(child, options.port);
		// Keep draining both pipes; the relay never writes again, but a blocked
		// pipe would still stall it.
		child.stdout?.resume();
		child.stderr?.resume();

		if ((await probeRelay(options.port)) !== "healthy") {
			throw new Error(`pi-free-bridge: the relay started but did not answer /health on ${url}`);
		}
	} catch (err) {
		if (!child.killed) child.kill();
		throw err;
	}

	// Keep the child's stdin open: closing it is the relay's shutdown signal.
	// Detach its handles so the relay never keeps Pi's event loop alive.
	installRelayExitHooks(child);
	detachRelayHandles(child);

	// A relay that dies on its own must not leave a stale "ready" state behind.
	child.once("exit", () => {
		if (relayState?.child === child) relayState = undefined;
	});

	return { key, url, mode: "spawned", child };
}

/** Ensure a healthy relay for this port + session id, spawning one if needed. */
/** bun-upgrades L8: a relay left by an older Pi session may carry a different
 *  egress mode than the config now asks for; reusing it silently would ignore
 *  the user's switch. Reuse only when the running relay reports the wanted
 *  mode; otherwise kill the stale one (identity-guarded: only a process
 *  whose /health reports THIS service and a numeric pid) and spawn fresh.
 *  Old builds report no pid — those are never killed, the caller surfaces
 *  them with an actionable message. */
export async function adoptOrReleaseStaleRelay(port: number, warpMode: string): Promise<"match" | "released" | "unkillable" | "absent"> {
	const health = await fetchRelayHealth(port);
	if (!health) return "absent";
	if (health.warpMode === warpMode) return "match";
	if (typeof health.pid !== "number") return "unkillable";
	try {
		process.kill(health.pid, "SIGKILL");
	} catch {
		// already gone or owned by another user — treat both as resolved
		return (await fetchRelayHealth(port)) ? "unkillable" : "released";
	}
	// Wait for the port to be released before respawning.
	for (let i = 0; i < 10; i++) {
		if (!(await fetchRelayHealth(port))) return "released";
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return (await fetchRelayHealth(port)) ? "unkillable" : "released";
}

const RELAY_LISTENING_LINE = `pi-free-bridge relay listening on http://${RELAY_HOST}:`;

/** Resolve the PID that owns the listening port by OS means, and only then
 *  kill it when its command line identifies it as OUR relay (never a blind
 *  kill). Windows: netstat -ano + PowerShell CommandLine. POSIX: lsof + ps. */
export async function identifyAndKillPortOwner(port: number): Promise<"killed" | "unidentified"> {
	const { execFileSync } = await import("node:child_process");
	let pid: number | undefined;
	let commandLine = "";
	try {
		if (process.platform === "win32") {
			const lines = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
			const match = lines
				.split(/\r?\n/)
				.find((l) => l.includes(`127.0.0.1:${port}`) && l.toUpperCase().includes("LISTENING"));
			pid = match && Number.parseInt(match.trim().split(/\s+/).pop() ?? "", 10);
			if (pid && Number.isInteger(pid)) {
				const owners = execFileSync(
					"powershell",
					[
						"-NoProfile", "-Command",
						`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
					],
					{ encoding: "utf8", timeout: 15000 },
				);
				commandLine = owners.trim();
			}
		} else {
			const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
			pid = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
			if (pid && Number.isInteger(pid)) {
				commandLine = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
			}
		}
	} catch {
		return "unidentified";
	}
	if (!pid || Number.isInteger(pid) === false) return "unidentified";
	// Identity guard: our relay prints exactly this line at startup — an
	// older build still matches (bun + relay.mjs in its command line).
	const identified =
		commandLine.includes(RELAY_LISTENING_LINE) ||
		(commandLine.includes("relay.mjs") && commandLine.includes("bun"));
	if (!identified) return "unidentified";
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
	// Confirm the port is free before respawning.
	for (let i = 0; i < 10; i++) {
		if (!(await fetchRelayHealth(port))) return "killed";
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return "unidentified";
}

/** relay-warp-hot-reload: the relay cache key drops warpMode — a mode change
 *  must NOT churn the relay; the relay hot-reloads the mode from the config
 *  file. Exported for tests. */
export function relayKey(port: number, sessionId?: string): string {
	return `${port}\u0000${sessionId ?? ""}`;
}

async function ensureRelay(options: RelayOptions): Promise<RelayResult> {
	const warpMode = normalizeWarpMode(options.warpMode) ?? resolveWarpMode();
	const key = relayKey(options.port, options.sessionId);

	// A non-off mode needs the WARP proxy alive; never fatal — auto degrades
	// to local, `on` surfaces the 502 with its egress diagnostic. No console
	// warning here: the download prompt is presented only when the user enters
	// the WARP activation menu (/free-bridge-warp) and no binary is present.
	if (warpMode !== "off" && !(await ensureWarp())) {
		// intentionally silent — prompt lives in the warp menu
	}

	if (relayState?.key === key) {
		// A relay we spawned is trusted; one we only reused must match the
		// requested egress mode too (L8) and is re-checked for liveness.
		if (relayState.mode === "spawned") {
			return { url: relayState.url, mode: relayState.mode };
		}
		const health = await fetchRelayHealth(options.port);
		if (health) {
			if (health.warpMode === warpMode) {
				return { url: relayState.url, mode: relayState.mode };
			}
			relayState = undefined;
		} else {
			relayState = undefined;
		}
	}
	if (relayPending?.key === key) return relayPending.promise;

	// Stale-relay gate: before spawning, a healthy foreign relay with a
	// different warp mode is released, not reused (L8).
	const stale = await adoptOrReleaseStaleRelay(options.port, warpMode);
	if (stale === "match" && relayState?.key === key) {
		return { url: relayUrl(options.port), mode: "reused" };
	}
	if (stale === "unkillable") {
		// Second chance: resolve the port owner by OS means (netstat/lsof +
		// command line) and kill it only when it identifies as OUR relay.
		const released = await identifyAndKillPortOwner(options.port);
		if (released !== "killed" || (await fetchRelayHealth(options.port))) {
			throw new Error(
				`pi-free-bridge: a relay from an older Pi session is running on port ${options.port} ` +
					`with a different WARP mode and could not be released safely — kill it manually ` +
					`or set PI_FREE_BRIDGE_RELAY_PORT.`,
			);
		}
	}
	// mode !== "off" already warned about WARP above; the spawn must still go
	// through so the relay's own chain reports the truth on the wire.

	const promise = startRelay(options, key)
		.then((state) => {
			relayState = state;
			return { url: state.url, mode: state.mode };
		})
		.finally(() => {
			if (relayPending?.promise === promise) relayPending = undefined;
		});

	relayPending = { key, promise };
	return promise;
}

/** Stop the relay this process spawned, and wait for the port to be released.
 *  A relay that was only reused belongs to another Pi instance and is left alone. */
async function stopRelay(): Promise<void> {
	const state = relayState;
	relayState = undefined;
	relayPending = undefined;

	const child = state?.child;
	if (!child || child.exitCode !== null || child.killed) return;

	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 2000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill();
	});
}

const RELAY_PORT = resolveRelayPort();
const RELAY_URL = relayUrl(RELAY_PORT);

/** S29: one line for `/free-bridge-doctor`. */
function describeRelay(): string {
	if (!relayState) return "not started";
	return relayState.mode === "spawned"
		? `running on ${relayState.url} (spawned)`
		: `reused on ${relayState.url}`;
}

type RelayHealth = {
	sessionId?: string;
	sessionSource?: string;
	warpMode?: string;
	/** relay-warp-hot-reload: who set the reported mode. */
	warpModeSource?: "env" | "config";
	lastEgress?: string;
	pid?: number;
};

/** The relay's `/health` payload, or undefined when it is not answering. */
export async function fetchRelayHealth(port: number): Promise<RelayHealth | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 750);
	try {
		const res = await fetch(relayHealthUrl(port), { signal: controller.signal });
		if (!res.ok) return undefined;
		const payload = (await res.json()) as {
			service?: unknown;
			ok?: unknown;
			sessionId?: unknown;
			sessionSource?: unknown;
			warpMode?: unknown;
			warpModeSource?: unknown;
			lastEgress?: unknown;
		};
		if (payload?.service !== RELAY_SERVICE || payload.ok !== true) return undefined;
		return {
			sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
			sessionSource: typeof payload.sessionSource === "string" ? payload.sessionSource : undefined,
			warpMode: normalizeWarpMode(payload.warpMode),
			warpModeSource:
				typeof payload.warpModeSource === "string" &&
				["env", "config"].includes(payload.warpModeSource)
					? (payload.warpModeSource as "env" | "config")
					: undefined,
			pid: typeof payload.pid === "number" ? payload.pid : undefined,
			lastEgress: typeof payload.lastEgress === "string" && ["local", "warp"].includes(payload.lastEgress)
				? payload.lastEgress
				: undefined,
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

type RegistryModel = {
	id: string;
	name: string;
	meta: Record<string, unknown>;
};

function resolveRegistryPath(): string | undefined {
	return REGISTRY_PATHS.find((p) => existsSync(p));
}

/** A model is free when every cost field it actually declares is zero.
 *
 *  The registry omits `cache_write` on most free models, so testing all four
 *  fields with `=== 0` classifies 36 of 39 free models as paid (HANDOFF §4.4). */
function isFree(meta: Record<string, unknown>): boolean {
	const cost = (meta.cost ?? {}) as Record<string, unknown>;
	const declared = Object.values(cost).filter(
		(v): v is number => typeof v === "number" && Number.isFinite(v),
	);
	return declared.length > 0 && declared.every((v) => v === 0);
}

function discoverFreeModels(liveIds: Set<string>): { models: RegistryModel[]; source: string; skipped: string[] } {
	const path = resolveRegistryPath();
	if (!path) return { models: [], source: "registry not found", skipped: [] };

	let data: Record<string, any>;
	try {
		data = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return { models: [], source: `registry unreadable: ${(err as Error).message}`, skipped: [] };
	}

	const registryModels = data?.opencode?.models;
	if (!registryModels || typeof registryModels !== "object") {
		return { models: [], source: `registry has no "opencode.models": ${path}`, skipped: [] };
	}

	const models: RegistryModel[] = [];
	const skipped: string[] = [];
	for (const [id, meta] of Object.entries<Record<string, unknown>>(registryModels)) {
		if (!meta || typeof meta !== "object") continue;
		if (EXCLUDED_MODELS.has(id)) {
			skipped.push(id);
			continue;
		}
		if (!isFree(meta)) continue;
		// Free in the registry but not advertised by the surface: registering it
		// would put a permanently broken entry in the picker.
		if (!liveIds.has(id)) {
			skipped.push(id);
			continue;
		}
		models.push({ id, name: (meta.name as string) || id, meta });
	}

	models.sort((a, b) => a.id.localeCompare(b.id));
	return { models, source: path, skipped };
}

/** Ask the surface which models it advertises, then keep the free ones. */
async function fetchLiveFreeIds(registryFree: Set<string>): Promise<string[]> {
	const res = await fetch(`${UPSTREAM_URL}/models`, {
		headers: { "user-agent": USER_AGENT, authorization: `Bearer ${API_KEY}` },
	});
	if (!res.ok) throw new Error(`${UPSTREAM_URL}/models -> ${res.status}`);
	const payload = (await res.json()) as { data?: { id?: string }[] } | { models?: { id?: string }[] };
	const listed = payload.data ?? payload.models ?? [];
	return listed
		.map((m) => (typeof m === "string" ? m : m?.id))
		.filter((id): id is string => typeof id === "string" && registryFree.has(id));
}

function buildPiModels(raw: RegistryModel[]) {
	return raw.map((m) => {
		const limit = (m.meta.limit ?? {}) as Record<string, number>;
		const cost = (m.meta.cost ?? {}) as Record<string, number>;
		const modalities = (m.meta.modalities ?? {}) as Record<string, string[]>;
		const family = (m.meta.family as string) || "";

		// Pi accepts only "text" | "image" inputs; the registry also lists
		// video/pdf/audio.
		const declaredInput = (modalities.input ?? ["text"]).filter(
			(x) => x === "text" || x === "image",
		);

		const model: Record<string, unknown> = {
			id: m.id,
			name: m.name,
			api: API,
			provider: PROVIDER,
			baseUrl: RELAY_URL,
			contextWindow: limit.context ?? 200000,
			maxTokens: limit.output ?? 32000,
			reasoning: (m.meta.reasoning as boolean) ?? false,
			cost: {
				input: cost.input ?? 0,
				output: cost.output ?? 0,
				cacheRead: cost.cache_read ?? 0,
				cacheWrite: cost.cache_write ?? 0,
			},
			input: declaredInput.length > 0 ? declaredInput : ["text"],
		};

		// DeepSeek and Kimi need reasoning_content replayed on tool-call turns.
		if (family.includes("deepseek")) {
			model.compat = { allowsSyntheticReasoningContentForToolCalls: false };
		} else if (family.includes("kimi")) {
			model.compat = {
				requiresReasoningContentForToolCalls: true,
				thinkingFormat: "zai",
			};
		}

		return model;
	});
}

// ---------------------------------------------------------------------------
// Free-tier gate: tools-less requests
// ---------------------------------------------------------------------------
//
// The Pi path no longer uses this module: `gateStreamSimple` forwards the
// context untouched and `relay.mjs` injects the tool names on the wire (S22).
// `gateRequestContext` is kept as the context-level reference implementation
// that `test/gate-tools.mjs` exercises, so a future relay change cannot quietly
// break the transcript-level contract.

/** The gate rejects any request whose `tools` array does not carry BOTH `read`
 *  and `bash` (HANDOFF §4.2). Pi's one-off calls — the auto-compaction,
 *  `/compact` and the branch summarization — build their request context from a
 *  system prompt plus a user message with NO tools at all
 *  (pi-coding-agent dist/core/compaction/compaction.js:498 and
 *  dist/core/compaction/branch-summarization.js:224), and pi-ai only sets
 *  `params.tools` when the resolved transcript has tools
 *  (pi-ai dist/api/openai-completions.js:600), so those requests answered
 *  `403 FreeTierError`. */
const GATE_TOOL_NAMES = ["read", "bash"];

/** Minimal tool declarations. The gate only inspects the names; `toolChoice:
 *  "none"` keeps the model from calling them. */
type GateTool = {
	name: string;
	description: string;
	parameters: { type: "object"; properties: Record<string, never> };
};

/** The subset of Pi's message shape this module needs. Deliberately loose: the
 *  real messages come from pi-ai, which this package does not depend on. */
type GateMessage = {
	role: string;
	content?: unknown;
	timestamp?: number;
	toolsAdded?: { name: string }[];
	toolsRemoved?: { name: string }[];
};

export type GateContext = {
	systemPrompt?: string;
	messages: GateMessage[];
	tools?: unknown[];
};

export type GateRequestContext = {
	messages: GateMessage[];
	/** Present only when the gate tools had to be injected. */
	toolChoice?: "none";
};

/** Resolve the tool set Pi would send for this transcript.
 *
 *  Pi resolves it by replaying every system message's `toolsAdded` /
 *  `toolsRemoved` deltas in order (`getCurrentTools`, pi-ai
 *  dist/utils/transcript.js:41). The replay is replicated here on purpose:
 *  `@earendil-works/pi-ai` is supplied by the host and is NOT resolvable from
 *  this package's folder — `import("@earendil-works/pi-ai")` fails with
 *  ERR_MODULE_NOT_FOUND here — and the tests run the extension under plain
 *  node. Importing it would add a runtime dependency the bridge does not need. */
function resolveToolNames(messages: GateMessage[]): Set<string> {
	const tools = new Map<string, { name: string }>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
	}
	return new Set(tools.keys());
}

/** Make a request context acceptable to the free-tier gate.
 *
 *  A context that already resolves both gate tools is returned untouched: the
 *  normal conversation path must not change. Otherwise the missing names are
 *  injected as a TRAILING system message and `toolChoice` is pinned to `none`.
 *
 *  The injection is appended, not patched into the leading system message,
 *  because Pi resolves every delta: an earlier `toolsRemoved` would otherwise
 *  drop the injected tool again (pi-ai
 *  dist/utils/transcript.js:41-51). Only the names that are actually missing
 *  are added, so a partial tool set is unioned instead of duplicated. */
export function gateRequestContext(context: GateContext): GateRequestContext {
	const present = resolveToolNames(context.messages);
	const missing = GATE_TOOL_NAMES.filter((name) => !present.has(name));
	if (missing.length === 0) {
		return { messages: context.messages };
	}

	const injectedTools: GateTool[] = missing.map((name) => ({
		name,
		description: `${name} (injected by pi-free-bridge for the OpenCode free-tier gate)`,
		parameters: { type: "object", properties: {} },
	}));

	const injected: GateMessage = {
		role: "system",
		content: "",
		toolsAdded: injectedTools,
		timestamp: Date.now(),
	};

	return { messages: [...context.messages, injected], toolChoice: "none" };
}

/** Pi hands extensions its own copy of pi-ai — as a virtual module
 *  (pi-coding-agent dist/core/extensions/virtual-modules.js) and as a jiti
 *  alias — so the module is importable at runtime. It is not resolvable from
 *  this package's own folder, so it is imported lazily on the first request
 *  instead of statically at module load. */
const COMPAT_MODULE = "@earendil-works/pi-ai/compat";

type CompatModule = {
	streamSimple: (
		model: unknown,
		context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
		options?: Record<string, unknown>,
	) => unknown;
};

let compatModule: Promise<CompatModule | undefined> | undefined;

function loadCompat(): Promise<CompatModule | undefined> {
	compatModule ??= import(COMPAT_MODULE).then(
		(mod) => mod as unknown as CompatModule,
		() => undefined,
	);
	return compatModule;
}

/** Stream handler for the provider.
 *
 *  Pi routes every request for this provider — the normal conversation turn as
 *  well as the one-off calls — through the provider's `streamSimple`
 *  (pi-coding-agent dist/core/provider-composer.js:374). Its only job now is to
 *  make sure the Bun relay is listening before the host opens the request; the
 *  relay owns every mutation the gate requires (headers, session, `<env>`,
 *  tools) and the context is passed through untouched.
 *
 *  Pi's provider composer runs this handler behind `lazyStream`
 *  (dist/core/provider-composer.js:428), which awaits the result before
 *  forwarding events, so starting the relay asynchronously is safe; the cast
 *  keeps the provider config assignable to Pi's synchronous type. */
const gateStreamSimple = (async (
	model: unknown,
	context: GateContext,
	options?: Record<string, unknown>,
) => {
	const session = resolveSessionId();
	await ensureRelay({
		port: RELAY_PORT,
		sessionId: session.sessionId,
		sessionSource: session.source,
		upstream: UPSTREAM_URL,
		cwd: process.cwd(),
	});

	const compat = await loadCompat();
	if (!compat) {
		throw new Error(
			`pi-free-bridge: cannot load ${COMPAT_MODULE}; the free-tier gate cannot be satisfied.`,
		);
	}

	return compat.streamSimple(model, context, options);
}) as unknown as ProviderConfig["streamSimple"];

// ---------------------------------------------------------------------------
// warp-minimal supervisor (bun-upgrades S4)
// ---------------------------------------------------------------------------
//
// warp-minimal is the alternate egress proxy of S5 (127.0.0.1:8789, /health).
// It ships separately (its own repo, e.g. PI_FREE_BRIDGE_WARP_BIN); when the
// configured mode needs it and it is not answering, the extension spawns the
// binary if one is known. Without a path it never spawns anything — it just
// warns, and the relay's own egress chain degrades exactly per the mode.

const WARP_DEFAULT_PORT = 8789;
const WARP_START_TIMEOUT_MS = 5000;

function warpHealthUrl(port: number): string {
	return `http://${RELAY_HOST}:${port}/health`;
}

async function probeWarp(port: number, attempts: number): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(warpHealthUrl(port), { signal: AbortSignal.timeout(750) });
			if (res.ok) return true;
		} catch {
			// not up yet
		}
		if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

let warpWarned = false;

/** OS-adapted canonical install path used by the WARP menu. */
function warpInstallPath(): string {
	return join(WARP_INSTALL_DIR, process.platform === "win32" ? "warp-minimal.exe" : "warp-minimal");
}

/** Resolve the warp-minimal binary. Precedence: explicit env override, then the
 *  persisted config entry, then the canonical install folder. Every candidate is
 *  validated with existsSync so a stale configured path cannot hide the fact that
 *  no runnable binary exists. Never downloads anything. */
function resolveWarpBin(): string | undefined {
	const candidates = [
		process.env.PI_FREE_BRIDGE_WARP_BIN?.trim(),
		readBridgeConfig().warpBin?.trim(),
		warpInstallPath(),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Best-effort: never throws; returns whether WARP answered /health. */
export async function ensureWarp(): Promise<boolean> {
	// (a) Probe /health — if WARP answers, we are done.
	const ok = await probeWarp(WARP_DEFAULT_PORT, 2);
	if (ok) return true;

	// (b) No health response: try to find a binary. If none exists, stay
	//     completely silent (startup must not warn or download).
	const bin = resolveWarpBin();
	if (!bin) return false;

	// (c) Spawn the binary. Only pass -config when the binary is the
	//     canonical install path and config.json sits next to it.
	try {
		const installPath = warpInstallPath();
		const installConfig = join(WARP_INSTALL_DIR, "config.json");
		const args = bin === installPath && existsSync(installConfig) ? ["-config", installConfig] : [];
		const child = spawn(bin, args, {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", () => undefined); // surface via probe failure
		child.unref();

		// (d) Probe again up to 6 attempts.
		return await probeWarp(WARP_DEFAULT_PORT, 6);
	} catch (err) {
		// (e) Log once via warpWarned.
		if (!warpWarned) {
			console.error(`pi-free-bridge: could not start warp-minimal — ${(err as Error).message}`);
			warpWarned = true;
		}
		return false;
	}
}

// ---------------------------------------------------------------------------
// warp-minimal install (bun-upgrades S4, in-Pi with explicit consent)
// ---------------------------------------------------------------------------
//
// When a non-off mode needs WARP and no binary is known, the extension can
// download the latest warp-minimal release from github.com/Deury08/warp-minimal
// — but ONLY after ctx.ui.confirm answers yes, and with a checksum check from
// the release's own checksums.txt.

const WARP_RELEASE_API = "https://api.github.com/repos/Deury08/warp-minimal/releases/latest";
const WARP_INSTALL_DIR = join(homedir(), ".pi", "agent", "pi-free-bridge", "warp");

function warpAssetKey(): string | undefined {
	const os =
		process.platform === "win32"
			? "windows"
			: process.platform === "darwin"
				? "darwin"
				: process.platform === "linux"
					? "linux"
					: undefined;
	if (!os) return undefined;
	const arch = process.arch === "arm64" ? "arm64" : "amd64";
	return `${os}_${arch}`;
}

/** Latest platform asset from the release API. */
async function findWarpAsset(): Promise<{ tag: string; url: string; name: string; size: number } | undefined> {
	try {
		const res = await fetch(WARP_RELEASE_API, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return undefined;
		const release = (await res.json()) as {
			tag_name?: unknown;
			assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown }[];
		};
		const key = warpAssetKey();
		if (!key) return undefined;
		const asset = (release.assets ?? []).find(
			(a) =>
				typeof a.name === "string" &&
				typeof a.browser_download_url === "string" &&
				a.name.includes(key) &&
				(a.name.endsWith(".zip") || a.name.endsWith(".tar.gz")),
		);
		if (!asset) return undefined;
		return {
			tag: typeof release.tag_name === "string" ? release.tag_name : "latest",
			url: asset.browser_download_url as string,
			name: asset.name as string,
			size: typeof asset.size === "number" ? asset.size : 0,
		};
	} catch {
		return undefined;
	}
}

/** Download + extract the release, verify its sha256 against checksums.txt,
 *  install the binary under WARP_INSTALL_DIR and return its path, or
 *  undefined with the failure logged. `status` reports each stage to Pi's
 *  notifications (ctx.ui.notify). Extraction uses the system `tar`
 *  (bsdtar), which ships with Windows 10+, macOS and Linux and handles the
 *  zip archives too. */
async function installWarpBinary(
	asset: { tag: string; url: string; name: string; size: number },
	status?: (message: string) => void,
): Promise<string | undefined> {
	const tmpDir = mkdtempSync(join(tmpdir(), "pfb-warp-"));
	try {
		const archivePath = join(tmpDir, asset.name);
		status?.(`Downloading warp-minimal ${asset.tag}…`);
		const res = await fetch(asset.url, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(60000),
		});
		if (!res.ok) {
			console.error(`pi-free-bridge: warp-minimal download failed — HTTP ${res.status}`);
			return undefined;
		}
		writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

		const csUrl = asset.url.slice(0, asset.url.length - asset.name.length) + "checksums.txt";
		const csRes = await fetch(csUrl, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(15000),
		});
		if (!csRes.ok) {
			console.error(`pi-free-bridge: warp-minimal checksums.txt unreachable — HTTP ${csRes.status}`);
			return undefined;
		}
		status?.("Verifying the release sha256 checksum…");
		const checksums = await csRes.text();
		const expected = checksums
			.split(/\r?\n/)
			.find((line) => line.trimEnd().endsWith(asset.name))
			?.split(/\s+/)[0];
		const got = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
		if (!expected) {
			console.error("pi-free-bridge: no checksum listed for", asset.name);
			return undefined;
		}
		if (expected.toLowerCase() !== got) {
			console.error(`pi-free-bridge: warp-minimal checksum mismatch (expected ${expected}, got ${got})`);
			return undefined;
		}

		status?.(`Installing to ${WARP_INSTALL_DIR}…`);
		mkdirSync(WARP_INSTALL_DIR, { recursive: true });
		const { execFileSync } = await import("node:child_process");
		// bsdtar handles the zip archives; GNU tar in a Git-Bash PATH does not.
		// Windows 10+ ships bsdtar at System32; macOS/Linux default to it.
		const tarBin =
			process.platform === "win32"
				? join(process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe")
				: "tar";
		execFileSync(tarBin, ["-xf", archivePath, "-C", tmpDir], {
			stdio: "ignore",
			timeout: 30000,
		});
		const exeName = process.platform === "win32" ? "warp-minimal.exe" : "warp-minimal";
		// The archive may keep the binary at its root or inside a single folder.
		let extracted: string | undefined = join(tmpDir, exeName);
		if (!existsSync(extracted)) {
			for (const entry of readdirSync(tmpDir)) {
				const candidate = join(tmpDir, entry, exeName);
				if (existsSync(candidate)) {
					extracted = candidate;
					break;
				}
			}
		}
		if (!extracted || !existsSync(extracted)) {
			console.error(`pi-free-bridge: did not find ${exeName} inside ${asset.name}`);
			return undefined;
		}
		const target = join(WARP_INSTALL_DIR, exeName);
		copyFileSync(extracted, target);
		if (process.platform !== "win32") chmodSync(target, 0o755);
		writeBridgeConfig({ warpBin: target });
		return target;
	} catch (err) {
		const message = `warp-minimal install failed: ${(err as Error).message}`;
		console.error(`pi-free-bridge: ${message}`);
		status?.(message);
		return undefined;
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

/** Minimal structural view of Pi's command ctx used by the WARP prompts. */
type WarpPromptContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string): Promise<boolean>;
	};
};

/** Bring WARP up, offering the guided download only when no binary exists.
 *  Returns whether WARP ended up answering /health. Never downloads without an
 *  explicit yes from ctx.ui.confirm. */
async function ensureWarpWithPrompt(ctx: WarpPromptContext): Promise<boolean> {
	if (await ensureWarp()) return true;

	const bin = resolveWarpBin();
	if (bin) {
		ctx.ui.notify(
			`warp-minimal is present at ${bin} but did not answer /health on 127.0.0.1:${WARP_DEFAULT_PORT}.`,
			"warning",
		);
		return false;
	}
	if (!ctx.hasUI) return false;

	const asset = await findWarpAsset();
	const sizeMb = asset && asset.size > 0 ? ` (${(asset.size / 1048576).toFixed(1)} MB)` : "";
	const consent = await ctx.ui.confirm(
		"pi-free-bridge",
		asset
			? `WARP is not running and no warp-minimal binary is installed.\n\n` +
				`Download warp-minimal ${asset.tag}${sizeMb} from\n` +
				`github.com/Deury08/warp-minimal, verify its checksum,\n` +
				`and install it to ${WARP_INSTALL_DIR}?`
			: `WARP is not running and no warp-minimal binary is installed.\n\n` +
				`No release asset is reachable right now.\n\n` +
				`Configure the path manually with: /free-bridge-warp bin <path>\n` +
				`or set PI_FREE_BRIDGE_WARP_BIN.`,
	);
	if (!consent) return false;
	if (!asset) {
		ctx.ui.notify(
			`No release asset is reachable right now. Configure the path with\n/free-bridge-warp bin <path>`,
			"warning",
		);
		return false;
	}

	ctx.ui.notify(`Downloading warp-minimal ${asset.tag}…`, "info");
	const installed = await installWarpBinary(asset, (message) => ctx.ui.notify(message, "info"));
	if (!installed) {
		ctx.ui.notify(
			`warp-minimal install failed — see the Pi error log.\n` +
				`You can still configure the path manually:\n/free-bridge-warp bin <path>`,
			"warning",
		);
		return false;
	}
	ctx.ui.notify(`warp-minimal installed to ${installed}`, "info");
	if (!(await ensureWarp())) {
		ctx.ui.notify(
			`warp-minimal was installed but did not answer /health on 127.0.0.1:${WARP_DEFAULT_PORT}`,
			"warning",
		);
		return false;
	}
	return true;
}


// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function printDryRun(
	discovered: { models: RegistryModel[]; source: string; skipped: string[] },
	session: { sessionId?: string; source: string },
	live: { liveIds: Set<string>; source: string },
): void {
	const lines = [
		"pi-free-bridge dry run",
		`  registry:    ${discovered.source}`,
		`  upstream:    ${UPSTREAM_URL}`,
		`  relay:       ${RELAY_URL} (port ${RELAY_PORT})`,
		`  bun:         ${resolveBunPath() ?? "MISSING"}`,
		`  api:         ${API}   apiKey: ${API_KEY}`,
		`  session id:  ${
			session.sessionId
				? `${session.sessionId} (from ${session.source})`
				: "harvested by the relay from the OpenCode store"
		}`,
		`  live ids:    ${live.source}`,
		`  excluded:    ${[...EXCLUDED_MODELS].join(", ")}`,
		`  models (${discovered.models.length}):`,
		...discovered.models.map((m) => `    - ${m.id}`),
		`  skipped (${discovered.skipped.length}):`,
		...discovered.skipped.map((m) => `    - ${m}`),
	];
	console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const g = globalThis as Record<symbol, unknown>;
	if (g[REG_KEY]) return;

	const session = resolveSessionId();
	const live = resolveLiveIds();
	const discovered = discoverFreeModels(live.liveIds);

	if (process.env.PI_FREE_BRIDGE_DRY_RUN === "1") {
		printDryRun(discovered, session, live);
	}

	if (discovered.models.length === 0) {
		// Fail closed: registering an empty model list would silently blank the
		// provider instead of surfacing a readable diagnostic.
		console.error(
			`pi-free-bridge: no free models discovered (${discovered.source}); ` +
				"provider not registered.",
		);
		return;
	}

	pi.registerProvider(PROVIDER, {
		apiKey: API_KEY,
		api: API,
		baseUrl: RELAY_URL,
		authHeader: true,
		models: buildPiModels(discovered.models),
		streamSimple: gateStreamSimple,
	});

	g[REG_KEY] = true;

	// Start the relay early so the first request does not pay the spawn cost.
	// A failure is reported once and retried by gateStreamSimple on the first
	// real request; it must never take Pi down at startup.
	if (process.env.PI_FREE_BRIDGE_DRY_RUN !== "1") {
		void ensureRelay({
			port: RELAY_PORT,
			sessionId: session.sessionId,
			sessionSource: session.source,
			upstream: UPSTREAM_URL,
			cwd: process.cwd(),
		}).catch((err) => {
			console.error(`pi-free-bridge: relay not ready — ${(err as Error).message}`);
		});
	}

	// Keep the picker able to see the models this bridge just registered. Silent
	// when the scope is already healthy; this is a repair, not a notification.
	// See ensureEnabledPattern for why this cannot fix the running session.
	// The kill switch lives inside repairEnabledModels, not here, so every caller
	// is covered.
	const scope = repairEnabledModels();
	if (scope.status === "added") {
		console.error(
			`pi-free-bridge: added "${SCOPE_PATTERN}" to enabledModels in ${SETTINGS_PATH} ` +
				`(${scope.previousCount} -> ${scope.previousCount + 1} entries). ` +
				"Restart Pi for the model picker to pick it up.",
		);
	} else if (scope.status === "malformed") {
		console.error(
			`pi-free-bridge: could not verify the model-picker scope — ${scope.reason}. ` +
				`Run /free-bridge-doctor for details.`,
		);
	}

	pi.registerCommand("free-bridge-session", {
		description: "Show or set the OpenCode session id used by the free-tier gate",
		handler: async (args: string, ctx) => {
			const next = args.trim();
			if (!next) {
				// S34: report the id actually on the wire, which may have been
				// harvested by the relay rather than set here.
				const health = await fetchRelayHealth(RELAY_PORT);
				ctx.ui.notify(
					health?.sessionId
						? `pi-free-bridge session: ${health.sessionId} (from ${health.sessionSource})`
						: "pi-free-bridge session: resolved at the first request by the relay — " +
								"run OpenCode once, or set PI_FREE_BRIDGE_SESSION_ID",
					"info",
				);
				return;
			}
			if (!/^ses_/.test(next)) {
				ctx.ui.notify("Session id must start with ses_", "warning");
				return;
			}
			const persisted = writeBridgeConfig({ sessionId: next });

			// S25: restart the relay so no request can carry the previous id.
			await stopRelay();
			let relayNote = "";
			try {
				await ensureRelay({
					port: RELAY_PORT,
					sessionId: next,
					sessionSource: persisted ? "config" : "env",
					upstream: UPSTREAM_URL,
					cwd: process.cwd(),
				});
			} catch (err) {
				relayNote = ` Relay restart failed: ${(err as Error).message}`;
			}

			pi.registerProvider(PROVIDER, {
				apiKey: API_KEY,
				api: API,
				baseUrl: RELAY_URL,
				authHeader: true,
				models: buildPiModels(discovered.models),
				streamSimple: gateStreamSimple,
			});
			ctx.ui.notify(
				`${persisted
					? `Session id set to ${next} and saved to ${BRIDGE_CONFIG_PATH}`
					: `Session id set to ${next} for this session only (could not write ${BRIDGE_CONFIG_PATH})`}.${relayNote}`,
				relayNote ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("free-bridge-refresh", {
		description: "Re-fetch the live free-model list from OpenCode and re-register the provider",
		handler: async (_args: string, ctx) => {
			ctx.ui.notify("Refreshing the live free-model list…", "info");
			try {
				const registryFree = new Set<string>();
				for (const [id, meta] of Object.entries<Record<string, unknown>>(
					JSON.parse(readFileSync(resolveRegistryPath()!, "utf-8"))?.opencode?.models ?? {},
				)) {
					if (isFree(meta) && !EXCLUDED_MODELS.has(id)) registryFree.add(id);
				}
				const liveIds = await fetchLiveFreeIds(registryFree);
				if (liveIds.length === 0) {
					ctx.ui.notify("The surface advertised no free models; keeping the current list", "warning");
					return;
				}
				writeBridgeConfig({ liveIds });
				const refreshed = discoverFreeModels(new Set(liveIds));
				pi.registerProvider(PROVIDER, {
					apiKey: API_KEY,
					api: API,
					baseUrl: RELAY_URL,
					authHeader: true,
					models: buildPiModels(refreshed.models),
					streamSimple: gateStreamSimple,
				});
				ctx.ui.notify(
					`${PROVIDER} now registers ${refreshed.models.length} free models: ${refreshed.models.map((m) => m.id).join(", ")}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Could not refresh: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("free-bridge-models", {
		description: "List the free OpenCode models registered by pi-free-bridge",
		handler: async (_args: string, ctx) => {
			const lines = [
				`pi-free-bridge: ${discovered.models.length} free models from ${discovered.source}`,
				...discovered.models.map((m) => `  ${PROVIDER}/${m.id}`),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("free-bridge-warp", {
		description: "Show or set the WARP egress mode: off | auto | on; bin <path> configures the binary",
		handler: async (args: string, ctx) => {
			const binArgs = args.trim().match(/^bin\s+(.+)/i);
			if (binArgs) {
				const binPath = binArgs[1].trim();
				if (!existsSync(binPath)) {
					ctx.ui.notify(`File not found: ${binPath} — nothing was changed`, "warning");
				} else {
					writeBridgeConfig({ warpBin: binPath });
					ctx.ui.notify(`pi-free-bridge: warpBin set to ${binPath} in ${BRIDGE_CONFIG_PATH}`, "info");
				}
				return;
			}
			const next = normalizeWarpMode(args);
			if (!next) {
				const envOverride = normalizeWarpMode(process.env.PI_FREE_BRIDGE_WARP_MODE);
				const health = await fetchRelayHealth(RELAY_PORT);
				const onWire = health?.warpMode ? `relay reports ${health.warpMode}${health.lastEgress ? `, last egress ${health.lastEgress}` : ""}` : "relay not running";
				const current = resolveWarpMode();
				ctx.ui.notify(
					[
						`pi-free-bridge warp: ${current} (config)${envOverride ? ` — env override wins: ${envOverride}` : ""}`,
						onWire,
						"off: direct only; auto: direct first, WARP on rate limit; on: always WARP.",
					].join("\n"),
					"info",
				);

				// Entering the menu: is WARP answering? If not, launch the
				// installed binary; only when no binary exists is the download
				// offered (yes/no). Nothing is downloaded at Pi startup.
				await ensureWarpWithPrompt(ctx);

				// Menú rápido: cambiar el modo sin tener que escribirlo completo.
				// Usa ctx.ui.select (opciones seleccionables) cuando Pi lo expone,
				// igual que /gentle:yolo; si no, cae a confirmaciones encadenadas.
				const modes = ["on", "auto", "off"] as const;
				const modeLabel: Record<string, string> = {
					on: "siempre WARP",
					auto: "directo primero, WARP ante rate limit",
					off: "solo directo",
				};
				let chosen: string | undefined;

				if (ctx.hasUI && typeof ctx.ui.select === "function") {
					const selected = await ctx.ui.select(
						`🚀 Gentle WARP 🔥 — modo actual: ${current}`,
						modes.map((m) => `${m} — ${modeLabel[m]}`),
					);
					// ctx.ui.select devuelve el string completo de la opción
					// (p. ej. "on — siempre WARP"); extraer solo el modo puro.
					chosen = selected ? String(selected).split(" ")[0] : undefined;
					if (!WARP_MODES.includes(chosen)) chosen = undefined;
				} else if (ctx.hasUI) {
					if (
						await ctx.ui.confirm(
							"pi-free-bridge",
							`Modo actual: ${current}.\n\n¿Querés cambiarlo?\n1) on — siempre WARP\n2) auto — directo primero, WARP ante rate limit\n3) off — solo directo`,
						)
					) {
						if (current !== "on") {
							chosen = (await ctx.ui.confirm("pi-free-bridge", `¿Cambiar a "on" (WARP siempre)?`)) ? "on" : undefined;
						}
						if (!chosen && current !== "auto") {
							chosen = (await ctx.ui.confirm("pi-free-bridge", `¿Cambiar a "auto" (directo primero, WARP ante rate limit)?`)) ? "auto" : undefined;
						}
						if (!chosen && current !== "off") {
							chosen = (await ctx.ui.confirm("pi-free-bridge", `¿Cambiar a "off" (solo directo)?`)) ? "off" : undefined;
						}
					}
				}

				if (!chosen) {
					ctx.ui.notify("Sin cambios en el modo WARP.", "info");
					return;
				}

				if (normalizeWarpMode(process.env.PI_FREE_BRIDGE_WARP_MODE)) {
					ctx.ui.notify(
						`PI_FREE_BRIDGE_WARP_MODE is set: it beats the config. Unset it to use ${chosen}.`,
						"warning",
					);
					return;
				}

				writeBridgeConfig({ warpEnabled: chosen });
				ctx.ui.notify(
					`WARP mode set to ${chosen} and saved to ${BRIDGE_CONFIG_PATH}. Takes effect on the next request.`,
					"info",
				);
				return;
			}
			if (normalizeWarpMode(process.env.PI_FREE_BRIDGE_WARP_MODE)) {
				ctx.ui.notify(
					`PI_FREE_BRIDGE_WARP_MODE is set: it beats the config. Unset it to use ${next}.`,
					"warning",
				);
				return;
			}
			// bun-upgrades S4: a non-off mode needs warp-minimal alive. The
			// guided download only runs after an explicit yes.
			if (next !== "off" && !(await ensureWarpWithPrompt(ctx))) {
				if (next === "on") {
					// `on` is WARP-only; switching without a working WARP would
					// fail every request until WARP comes up.
					ctx.ui.notify(
						`Not switching to on: WARP is not up. Set it again when warp-minimal answers on 127.0.0.1:${WARP_DEFAULT_PORT}.`,
						"warning",
					);
					return;
				}
			}

			writeBridgeConfig({ warpEnabled: next });

			// relay-warp-hot-reload: no relay restart. The relay re-reads the
			// config file on every request, so the new mode applies on the next
			// request with the same process (pid survives the switch).
			ctx.ui.notify(
				`WARP mode set to ${next} and saved to ${BRIDGE_CONFIG_PATH}. Takes effect on the next request.`,
				"info",
			);
		},
	});

	pi.registerCommand("free-bridge-doctor", {
		description: "Diagnose and repair why the free OpenCode models are missing from the picker",
		handler: async (_args: string, ctx) => {
			// S34: the effective id lives on the wire, so read it from the relay.
			const health = await fetchRelayHealth(RELAY_PORT);
			const lines = [
				"pi-free-bridge doctor",
				`  provider:   ${PROVIDER}`,
				`  registered: ${discovered.models.length} free models from ${discovered.source}`,
				`  session id: ${
					health?.sessionId
						? `${health.sessionId} (from ${health.sessionSource})`
						: "MISSING — run OpenCode once, or set PI_FREE_BRIDGE_SESSION_ID"
				}`,
				`  bun:        ${resolveBunPath() ?? "MISSING"}`,
				`  relay port: ${RELAY_PORT}`,
				`  relay:      ${describeRelay()}`,
				`  warp:       ${
					health?.warpMode
						? `${health.warpMode} on the relay${health.lastEgress ? ` (last egress: ${health.lastEgress})` : ""}`
						: `${resolveWarpMode()} (configured; the relay reports it once it runs)`
				}`,
				`  upstream:   ${UPSTREAM_URL}`,
				`  live ids:   ${live.source}`,
				`  skipped:    ${discovered.skipped.length ? discovered.skipped.join(", ") : "none"}`,
			];

			const result = repairEnabledModels();
			if (result.status === "unchanged") {
				lines.push(`  scope:      ok — "${SCOPE_PATTERN}" is in enabledModels`);
			} else if (result.status === "added") {
				lines.push(
					`  scope:      repaired — appended "${SCOPE_PATTERN}" to enabledModels ` +
						`(${result.previousCount} -> ${result.previousCount + 1} entries)`,
				);
			} else {
				lines.push(`  scope:      FAILED — ${result.reason}`);
				lines.push(`              edit ${SETTINGS_PATH} by hand and add "${SCOPE_PATTERN}"`);
			}

			lines.push(
				"",
				"  Pi resolves the picker scope once at startup and never re-reads",
				"  settings.json, so any change here applies on the next Pi launch.",
				"",
				`  If the models still do not appear, run:`,
				`    pi -p --model ${PROVIDER}/deepseek-v4.1-flash-free "Reply with exactly: OK"`,
				"  A non-zero exit or a non-OK reply is a gate or session-id problem,",
				"  not a scope problem — see /free-bridge-session.",
			);

			ctx.ui.notify(lines.join("\n"), result.status === "malformed" ? "error" : "info");
		},
	});
}