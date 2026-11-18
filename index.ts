import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { appendFileSync, existsSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
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

/** Only the fallback path sends this, and only when the relay has no `/models`
 *  route: the gate answers 403 to a user-agent without "opencode/". The relay
 *  carries its own copy because it is normally the only process that talks to
 *  the gate at all. */
const FALLBACK_USER_AGENT = "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

/** Optional user config: `{ "sessionId": "ses_…" }`. `liveIds` used to live
 *  here as the local half of the registered-set invariant; the catalog is now
 *  the relay's, so nothing reads it and the field was removed. */
export const BRIDGE_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge.json");

/** Pi's global settings. Pi scopes the model picker to `enabledModels`, so a
 *  non-empty list means "show ONLY these" — see ensureEnabledPattern. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** The scope entry the bridge needs. A glob, not literal ids: the bridge
 *  registers its models at runtime, so literal ids hide anything new. */
const SCOPE_PATTERN = `${PROVIDER}/*`;

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
	relayPort?: number;
	/** "off" | "auto" | "on" (bun-upgrades S5); anything else reads as off. */
	warpEnabled?: string;
	/** Path to the warp-minimal binary for supervised spawning. */
	warpBin?: string;
	/** Installed relay binary (versioned filename); unset means Bun from relay.mjs. */
	relayBin?: string;
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

/** Normalize a wire mode: "v1" | "v2", or undefined for anything else. */
function normalizeWireMode(value: unknown): "v1" | "v2" | undefined {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return text === "v1" || text === "v2" ? text : undefined;
}

/** The mode the relay will actually use: the env override wins, then the config
 *  file, then "v1". Mirrors relay.mjs `resolveWireModeHot` so this command
 *  reports what is on the wire instead of what was last written. */
function resolveWireMode(): "v1" | "v2" {
	const override = normalizeWireMode(process.env.RELAY_WIRE_MODE);
	if (override) return override;
	return normalizeWireMode((readBridgeConfig() as { wireMode?: unknown }).wireMode) ?? "v1";
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

/** The session table by OpenCode generation: v1 created `session`, v2 creates
 *  `session_v2`. Oldest schema first so a v1 store keeps its original path. */
const SESSION_TABLES: readonly string[] = ["session", "session_v2"];

/** Newest `ses_` id from the first candidate table that yields one. An absent
 *  table is skipped, and an empty (or all foreign-id) table does not shadow the
 *  next candidate. `runSql` keeps this independent of the driver API: Bun's
 *  `bun:sqlite` exposes `query(sql).all()`, Node's `node:sqlite` only exposes
 *  `prepare(sql).all()`. Mirrors relay.mjs, which harvests the same store. */
function harvestNewestSessionId(
	runSql: (sql: string) => { id?: unknown }[],
	tables: readonly string[] = SESSION_TABLES,
): string | undefined {
	for (const table of tables) {
		let rows: { id?: unknown }[];
		try {
			rows = runSql(`select id from ${table} order by time_created desc limit 5`);
		} catch {
			// Table absent from this schema, or unreadable: try the next candidate.
			continue;
		}
		for (const row of rows) {
			if (row && typeof row.id === "string" && row.id.startsWith("ses_")) return row.id;
		}
	}
	return undefined;
}

/** Newest `ses_` row from `opencode.db` via `node:sqlite` when available, in
 *  either the v1 `session` or the v2 `session_v2` table. Synchronous
 *  best-effort: a missing module, table or permission returns undefined and
 *  lets the caller fall through to the diff harvest. */
function harvestSessionFromDb(shareDir: string = OPENCODE_SHARE_DIR): string | undefined {
	const dbPath = join(shareDir, "opencode.db");
	if (!existsSync(dbPath)) return undefined;
	try {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as { DatabaseSync?: unknown };
		if (typeof DatabaseSync !== "function") return undefined;
		const db = new (DatabaseSync as new (path: string, opts?: object) => {
			prepare(sql: string): { all(): { id?: unknown }[] };
			close(): void;
		})(dbPath, { readOnly: true });
		try {
			return harvestNewestSessionId((sql) => db.prepare(sql).all());
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
	/** v1 | v2 upstream wire; absent means v1 (relay-wire-hot-reload). */
	wireMode?: "v1" | "v2";
	/** Absolute http://host:port of the WARP proxy the relay must use. */
	warpProxy?: string;
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
/** Proxy URL the relay we spawned was born with (undefined when none). */
let relayWarpProxy: string | undefined;

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

/** The relay's manual rotation route. The relay binds 127.0.0.1 only, so this is
 *  the same loopback surface `/health` already lives on. */
function relayRecycleUrl(port: number): string {
	return `http://${RELAY_HOST}:${port}/warp/recycle`;
}

/** One step of the relay's manual sweep (relay S11): the action, the exit it
 *  targeted, the outcome the proxy gave and the usable exit count observed right
 *  after it. `usable` is null when that read failed. */
type WarpRecycleStep = {
	action?: string;
	exit?: string;
	outcome?: string;
	usable?: number | null;
};

type WarpRecycleReply = {
	ok?: boolean;
	rotated?: boolean;
	reason?: string;
	steps?: WarpRecycleStep[];
	usable?: number | null;
	warpRecycles?: number;
	warp429Streak?: number;
	delivering?: number;
};

type WarpRecycleOutcome =
	| { kind: "reply"; status: number; body: WarpRecycleReply }
	| { kind: "timeout" }
	| { kind: "absent" };

/** POST the manual rotation (relay S3). A rotation may legitimately spend up to
 *  two minutes waiting for responses still being delivered over the tunnel, and
 *  a command must not hang for two minutes, so the caller is told "still
 *  working, read the result again" instead of watching a frozen prompt. */
async function requestWarpRecycle(port: number, timeoutMs = 25_000): Promise<WarpRecycleOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(relayRecycleUrl(port), {
			method: "POST",
			signal: controller.signal,
		});
		const body = (await res.json().catch(() => ({}))) as WarpRecycleReply;
		return { kind: "reply", status: res.status, body };
	} catch (err) {
		return (err as Error)?.name === "AbortError" ? { kind: "timeout" } : { kind: "absent" };
	} finally {
		clearTimeout(timer);
	}
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

	// The relay must never inherit a stale proxy URL from process.env: clear it
	// first, then set only the target this process actually resolved.
	delete env.RELAY_WARP_PROXY;
	if (typeof options.warpProxy === "string" && options.warpProxy.length > 0) {
		env.RELAY_WARP_PROXY = options.warpProxy;
	}

	// S14: the health path belongs to warp-minimal's shared config, so the relay
	// gets it from here instead of hardcoding /health. Same rule as the proxy:
	// clear an inherited value, then pass what this process actually resolved.
	delete env.RELAY_WARP_HEALTH_PATH;
	if (typeof options.warpProxy === "string" && options.warpProxy.length > 0) {
		env.RELAY_WARP_HEALTH_PATH = resolveWarpTarget().healthPath;
	}

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

	// Bun wins over a binary on purpose. Both run the same relay — the compiled
	// binary is `relay.mjs` with the runtime inside — so the only difference that
	// matters is updating: `pi install` refreshes the script with the package, and
	// nothing refreshes a binary. A binary that stays on disk is the fallback for
	// the day Bun is gone, never the preferred runtime.
	const command = resolveRelayCommand();
	if (!command) {
		// S27: never degrade into a silent 429.
		throw new Error(
			"pi-free-bridge: the free-tier relay needs either a downloaded binary or bun, and neither was found. " +
				"Run /free-bridge and choose \"Instalar / actualizar relay\", install Bun (https://bun.sh), " +
				"or set PI_FREE_BRIDGE_BUN to the bun executable.",
		);
	}

	const child =
		command.kind === "bun"
			? spawn(command.path, [RELAY_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], env: relayEnv(options) })
			: spawn(command.path, [], { stdio: ["pipe", "pipe", "pipe"], env: relayEnv(options) });

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

	// Record the proxy URL this relay was born with, so ensureRelay can restart
	// it when the shared WARP config moves the target.
	relayWarpProxy = options.warpProxy;

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
	const target = resolveWarpTarget();
	const warpMode = normalizeWarpMode(options.warpMode) ?? resolveWarpMode();
	const key = relayKey(options.port, options.sessionId);

	// A non-off mode needs the WARP proxy alive; never fatal — auto degrades
	// to local, `on` surfaces the 502 with its egress diagnostic. No console
	// warning here: the download prompt is presented only when the user enters
	// the WARP activation menu ("WARP: on / off") and no binary is present.
	if (warpMode !== "off" && !(await ensureWarp())) {
		// intentionally silent — prompt lives in the warp menu
	}

	// A relay we spawned keeps the proxy URL it was born with, so a config
	// change that moves the WARP target must restart it. A REUSED relay
	// (spawned by another Pi) keeps its own proxy URL: we cannot read it back
	// from /health. relayKey stays port + session id, so the URL never churns it.
	if (relayState?.mode === "spawned" && relayWarpProxy !== target.url) {
		await stopRelay();
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

	const promise = startRelay({ ...options, warpProxy: target.url }, key)
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
	relayWarpProxy = undefined;

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

/** Whether a pid still exists, used to wait for a relay we asked to stop. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Stop whatever relay is listening, using the `pid` `/health` already publishes.
 *
 *  Using that pid rather than only our own child handle is what makes the swap
 *  work for a relay the extension did not start (`bun relay.mjs`, an old binary
 *  on PATH): those are exactly the ones that need replacing, and a handle we do
 *  not have cannot be killed. Returns whether the process is really gone.
 */
async function stopRelayByHealthPid(timeoutMs: number): Promise<boolean> {
	const health = (await fetchRelayHealth(RELAY_PORT)) as { pid?: unknown } | undefined;
	const pid = typeof health?.pid === "number" ? health.pid : undefined;
	if (!pid) {
		// Nothing answering: there is no relay to stop, and that is success.
		await stopRelay();
		return true;
	}
	if (relayState?.child?.pid === pid) {
		await stopRelay();
	} else {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone between the health probe and here.
		}
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !isPidAlive(pid);
}

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
	/** The relay's own version. Without it a relay nobody installed (an old
	 *  `bun relay.mjs`, a file on PATH) cannot be told apart from a current one. */
	version?: string;
	warpMode?: string;
	/** relay-warp-hot-reload: who set the reported mode. */
	warpModeSource?: "env" | "config";
	lastEgress?: string;
	pid?: number;
	/** Counters `/health` already publishes: they are what makes a manual
	 *  rotation's result readable instead of guessable. */
	warp429Streak?: number;
	warpRecycles?: number;
	warpResends?: number;
	localParkedForMs?: number;
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
			warp429Streak?: unknown;
			warpRecycles?: unknown;
			warpResends?: unknown;
			localParkedForMs?: unknown;
			version?: unknown;
		};
		if (payload?.service !== RELAY_SERVICE || payload.ok !== true) return undefined;
		return {
			sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
			sessionSource: typeof payload.sessionSource === "string" ? payload.sessionSource : undefined,
			version: typeof payload.version === "string" ? payload.version : undefined,
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
			warp429Streak: typeof payload.warp429Streak === "number" ? payload.warp429Streak : undefined,
			warpRecycles: typeof payload.warpRecycles === "number" ? payload.warpRecycles : undefined,
			warpResends: typeof payload.warpResends === "number" ? payload.warpResends : undefined,
			localParkedForMs:
				typeof payload.localParkedForMs === "number" ? payload.localParkedForMs : undefined,
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

/** What a catalog answer means. `unavailable` carries a reason when the reply
 *  is a failure; an empty list with no `unavailable` means the vendor genuinely
 *  offers nothing free. Those are different facts and the UI renders them
 *  differently, so they must never collapse into one. */
export type CatalogResult = {
	models: RegistryModel[];
	source: string;
	/** How many models the relay refused as not free. The extension no longer
	 *  classifies prices itself, so this is reported, never recomputed. */
	skippedCount?: number;
	unavailable?: string;
};

/** Pure: turn a relay `/models` answer into the catalog this bridge publishes.
 *  Exported so the failure-versus-empty distinction is testable without a
 *  relay or a network. */
export function parseRelayCatalog(status: number, body: any): CatalogResult {
	const source = "relay /models";
	if (status < 200 || status >= 300 || !body || body.ok !== true) {
		const reason = body && body.reason ? body.reason : `relay /models -> HTTP ${status}`;
		return { models: [], source, unavailable: String(reason) };
	}
	const models: RegistryModel[] = [];
	for (const entry of (body.models ?? []) as any[]) {
		if (!entry || typeof entry.id !== "string" || EXCLUDED_MODELS.has(entry.id)) continue;
		models.push({
			id: entry.id,
			name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
			meta: {
				name: entry.name,
				family: entry.family,
				reasoning: Boolean(entry.reasoning),
				limit: entry.limit ?? {},
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				modalities: { input: entry.input ?? ["text"] },
			},
		});
	}
	return {
		models,
		source,
		skippedCount: typeof body.skipped === "number" ? body.skipped : undefined,
	};
}

/** The catalog, through the relay. One door to the vendor: the relay is what
 *  carries the wire headers, the egress and the session. The extension never
 *  calls the vendor itself. */
export async function fetchRelayCatalog(signal?: AbortSignal): Promise<CatalogResult> {
	const url = `http://127.0.0.1:${RELAY_PORT}/models`;
	let res: Response;
	try {
		res = await fetch(url, { signal });
	} catch (err) {
		// No relay listening. That is the agreed state for a machine that has not
		// installed one: no models, and a menu that only offers to install it.
		return {
			models: [],
			source: url,
			unavailable: `${url} unreachable: ${(err as Error).message}`,
		};
	}

	// CAPABILITY, not version: a relay either has the route or it does not. 404
	// means this relay predates /models, so the extension asks the service
	// directly — the call it made before the route existed, measured to work (3/3
	// HTTP 200, 86 models, no WARP, no 429). Never refuse to work because a
	// number looks old: the relay and the extension must be free to move
	// independently, and today's aligned numbers are bookkeeping, not a contract.
	if (res.status === 404) return fetchDirectCatalog(signal);

	const body = await res.json().catch(() => undefined);
	return parseRelayCatalog(res.status, body);
}

/** A vendor model, read the way `relay.mjs`'s `freeCatalog` reads it.
 *
 *  This is the fallback path only, and the duplication is deliberate: importing
 *  `relay.mjs` into the extension would drag its HTTP server into Pi's extension
 *  bundle. A differential test feeds the same fixture to both implementations
 *  and requires identical ids, so the two copies cannot drift apart in silence. */
function freeFromUpstreamPayload(payload: unknown): RegistryModel[] {
	const listed = ((payload as { data?: unknown[]; models?: unknown[] } | undefined)?.data ??
		(payload as { models?: unknown[] } | undefined)?.models ??
		[]) as unknown[];
	const models: RegistryModel[] = [];
	for (const entry of listed) {
		if (!entry || typeof entry !== "object") continue;
		const raw = entry as Record<string, any>;
		const id = raw.id;
		if (typeof id !== "string" || id.length === 0 || EXCLUDED_MODELS.has(id)) continue;
		const price = (kind: "input" | "output"): number | undefined => {
			const cost = raw.cost ?? {};
			const node = (cost.text ?? {})[kind];
			if (node && typeof node.price === "number") return node.price;
			return typeof cost[kind] === "number" ? cost[kind] : undefined;
		};
		const input = price("input");
		const output = price("output");
		// Unreadable is not free: guessing would advertise a model that can spend quota.
		if (input === undefined || output === undefined || input !== 0 || output !== 0) continue;
		const limit = raw.limit ?? {};
		const modalities = raw.modalities ?? {};
		const capabilities = raw.capabilities ?? {};
		models.push({
			id,
			name: typeof raw.name === "string" && raw.name ? raw.name : id,
			meta: {
				name: typeof raw.name === "string" ? raw.name : id,
				family: raw.family,
				reasoning: Boolean(capabilities.reasoning && capabilities.reasoning.supported),
				limit,
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				modalities,
			},
		});
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

/** The service itself, the way the extension used to call it: same headers, no
 *  WARP. Used only when the relay has no `/models` route to serve. */
async function fetchDirectCatalog(signal?: AbortSignal): Promise<CatalogResult> {
	const url = `${UPSTREAM_URL}/models`;
	const source = `${url} (directo: el relay no tiene /models)`;
	try {
		const res = await fetch(url, {
			headers: { "user-agent": FALLBACK_USER_AGENT, authorization: `Bearer ${API_KEY}` },
			signal,
		});
		if (!res.ok) return { models: [], source, unavailable: `${url} -> HTTP ${res.status}` };
		return { models: freeFromUpstreamPayload(await res.json().catch(() => undefined)), source };
	} catch (err) {
		return { models: [], source, unavailable: `${url} unreachable: ${(err as Error).message}` };
	}
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

		// The gate's contract is `role: "system"` and `max_tokens`. pi-ai's
		// `detectCompat` reads a loopback baseUrl with the provider's own id as a
		// standard endpoint, so it infers `supportsDeveloperRole: true` and
		// `max_completion_tokens` and every `reasoning` model goes out with
		// `role: "developer"`. One backend refuses it outright:
		// `400 ... unknown variant 'developer', expected one of
		// 'system','user','assistant','tool'`. Pin both on every model of this
		// provider instead of letting detection decide, and merge the family
		// fields under it.
		const compat: Record<string, unknown> = {
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		};

		// DeepSeek and Kimi need reasoning_content replayed on tool-call turns.
		if (family.includes("deepseek")) {
			compat.allowsSyntheticReasoningContentForToolCalls = false;
		} else if (family.includes("kimi")) {
			compat.requiresReasoningContentForToolCalls = true;
			compat.thinkingFormat = "zai";
		}

		model.compat = compat;

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

/** The gate requires exactly one tool name: `read`. Measured against the live
 *  gate on 2026-11-18 — `[read]` alone is accepted, while `[bash]`, `[grep, find,
 *  ls]`, `[]` and an absent array are refused with `429 FreeUsageLimitError`, the
 *  same answer a spent quota gets (which is why the refusal reads like a quota
 *  problem). Pi's one-off calls — the auto-compaction, `/compact` and the branch
 *  summarization — build their request context from a system prompt plus a user
 *  message with NO tools at all (pi-coding-agent
 *  dist/core/compaction/compaction.js:498 and
 *  dist/core/compaction/branch-summarization.js:224), and pi-ai only sets
 *  `params.tools` when the resolved transcript has tools
 *  (pi-ai dist/api/openai-completions.js:600), so those requests hit that
 *  refusal. */
const GATE_TOOL_NAMES = ["read"];

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
 *  A context that already resolves the gate tool is returned untouched: the normal
 *  conversation path must not change. Otherwise the missing name is injected as a
 *  TRAILING system message. `toolChoice` is pinned to `none` ONLY when the caller
 *  had no tools at all, because those declarations exist solely to satisfy the
 *  gate; a partial set keeps the choice it asked for, so its own tools stay
 *  callable (pinning it there is the defect PR #29 fixed).
 *
 *  The injection is appended, not patched into the leading system message,
 *  because Pi resolves every delta: an earlier `toolsRemoved` would otherwise
 *  drop the injected tool again (pi-ai
 *  dist/utils/transcript.js:41-51). Only the name that is actually missing is
 *  added, so a partial tool set is unioned instead of duplicated. */
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

	const messages = [...context.messages, injected];
	return present.size === 0 ? { messages, toolChoice: "none" } : { messages };
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
// warp-minimal is the alternate egress proxy of S5. Its OWN config file
// (`<install dir>/config.json`) is the SHARED source of truth: warp-minimal
// obeys it and this extension reads the same values — `listen` and
// `health_path` — so both always agree on the endpoint. The file is read-only
// here: nothing is ever created or rewritten, a missing key falls back to the
// default, and an absent file means every value is the default.
//
// The target may be a REMOTE host (warp-minimal in another PC or container).
// Only a loopback target is ever spawned locally; a remote one is reported,
// never started.
//
// It ships separately (its own repo, e.g. PI_FREE_BRIDGE_WARP_BIN); when the
// configured mode needs it and it is not answering, the extension spawns the
// binary if one is known. Without a path it never spawns anything — it just
// warns, and the relay's own egress chain degrades exactly per the mode.

export const WARP_DEFAULT_PORT = 8789;
const WARP_DEFAULT_HEALTH_PATH = "/health";
const WARP_START_TIMEOUT_MS = 5000;
const WARP_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Resolved WARP endpoint plus where each value came from. */
export type WarpTarget = {
	host: string;
	port: number;
	healthPath: string;
	/** http://host:port — the relay's proxy URL. */
	url: string;
	/** http://host:port<healthPath> — what the probe hits. */
	healthUrl: string;
	/** Only a loopback target may be spawned locally. */
	isLoopback: boolean;
	source: "default" | "config";
};

/** Parse a warp-minimal `listen` value. Accepts "host:port", ":port", "port",
 *  "[::1]:port". Returns undefined for anything unparseable so the caller can
 *  fall back to the defaults. Never throws. */
export function parseListen(value: unknown): { host: string; port: number } | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return undefined;

	// Bare port: "8789"
	if (/^\d+$/.test(text)) {
		const port = Number.parseInt(text, 10);
		return Number.isInteger(port) && port > 0 && port < 65536 ? { host: "127.0.0.1", port } : undefined;
	}

	// Bracketed IPv6: "[::1]:8789"
	const bracketed = text.match(/^\[([^\]]+)\]:(\d+)$/);
	if (bracketed) {
		const port = Number.parseInt(bracketed[2]!, 10);
		return Number.isInteger(port) && port > 0 && port < 65536
			? { host: bracketed[1]!, port }
			: undefined;
	}

	// "host:port" and ":port"
	const lastColon = text.lastIndexOf(":");
	if (lastColon === -1) return undefined;
	const host = text.slice(0, lastColon).trim();
	const port = Number.parseInt(text.slice(lastColon + 1).trim(), 10);
	if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
	return { host: host || "127.0.0.1", port };
}

/** Bracketed when the host is a bare IPv6 literal. */
export function warpHostUrl(host: string): string {
	const bare = host.replace(/^\[|\]$/g, "");
	return bare.includes(":") ? `[${bare}]` : bare;
}

export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	return WARP_LOOPBACK_HOSTS.has(bare) || bare.startsWith("127.");
}

/** Build the target from already-parsed parts; shared by both paths. */
function buildWarpTarget(host: string, port: number, healthPath: string, source: "default" | "config"): WarpTarget {
	const authority = `${warpHostUrl(host)}:${port}`;
	return {
		host,
		port,
		healthPath,
		url: `http://${authority}`,
		healthUrl: `http://${authority}${healthPath}`,
		isLoopback: isLoopbackHost(host),
		source,
	};
}

/** warp-minimal's own config file, in its canonical install directory. */
function warpConfigPath(): string {
	return join(WARP_INSTALL_DIR, "config.json");
}

/** Resolve the target from warp-minimal's shared config file. The file is
 *  read-only for us: absent, unreadable or malformed all mean "defaults".
 *  Never throws, never writes. */
export function resolveWarpTarget(configPath: string = warpConfigPath()): WarpTarget {
	const fallback = () => buildWarpTarget("127.0.0.1", WARP_DEFAULT_PORT, WARP_DEFAULT_HEALTH_PATH, "default");
	if (!existsSync(configPath)) return fallback();

	let raw: Record<string, unknown>;
	try {
		const text = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback();
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		if (!warpConfigWarned) {
			console.error(`pi-free-bridge: ignoring ${configPath} — ${(err as Error).message}`);
			warpConfigWarned = true;
		}
		return fallback();
	}

	const listen = parseListen(raw.listen);
	const host = listen?.host ?? "127.0.0.1";
	const port = listen?.port ?? WARP_DEFAULT_PORT;
	const rawHealth = typeof raw.health_path === "string" ? raw.health_path.trim() : "";
	const healthPath = rawHealth.startsWith("/") ? rawHealth : WARP_DEFAULT_HEALTH_PATH;
	// Report "config" only when a value actually came from the file. A file that
	// exists but contributes nothing usable (typo, wrong types) must not claim
	// the defaults were read from it — that is exactly the confusing case.
	const usedFile = listen !== undefined || rawHealth.startsWith("/");
	return buildWarpTarget(host, port, healthPath, usedFile ? "config" : "default");
}

/** One line naming the effective endpoint and where it came from. */
function describeWarpTarget(target: WarpTarget): string {
	const origin = target.source === "config" ? `from ${warpConfigPath()}` : "defaults";
	return `${target.url} (${origin}) — ${target.isLoopback ? "loopback" : "remote"}`;
}

/** Probe a WARP health endpoint. Never throws. */
async function probeWarp(healthUrl: string, attempts: number): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
			if (res.ok) return true;
		} catch {
			// not up yet
		}
		if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

let warpWarned = false;
let warpConfigWarned = false;

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

/** Best-effort: never throws; returns whether WARP answered its health endpoint.
 *
 *  Startup rule: probe first. Only when a LOOPBACK target does not answer is a
 *  local binary launched — a remote target is never spawned, only reported. */
/** T9b / S29: the identity a binary prints for itself. Its `-version` line ends
 *  in the commit in parentheses, and the Go default is the literal `unknown` —
 *  which is absence of identity, never a commit to compare against. */
export function parseWarpBuildVersion(text: string): string | null {
	if (typeof text !== "string") return null;
	const match = /\(([^()]*)\)\s*$/.exec(text.trim());
	if (!match) return null;
	const commit = match[1].trim();
	return commit && commit !== "unknown" ? commit : null;
}

/** T9b / S30c, S30d: one line of policy for "installed versus running". Silence
 *  when there is nothing to do, otherwise a sentence that names the action — a
 *  diagnostic that names no command is noise. The case this deliberately cannot
 *  speak about is an installed file older than the running process: advising an
 *  update would advise a downgrade, so it says nothing instead of misleading. */
export function warpBuildNotice({ running, installed }: { running: string | null; installed: string | null }): string | null {
	if (!running) {
		return "warp does not publish its identity (a build older than warp-build-identity), so what runs cannot be verified — update with /free-bridge-warp-update";
	}
	if (!installed || installed === running) return null;
	return `the proxy runs ${running}, the installed build is ${installed} — /free-bridge-warp-update`;
}

/** T9c: what an update really costs, in the exact words shown before consent.
 *  The download is the cheap part: stopping the proxy costs two enrollments, a
 *  few seconds without service, new egress addresses, and the matching of every
 *  parked entry — the entries survive, they just stop lining up with a live exit.
 *  And the proxy is shared, so another Pi behind it pays the same seconds. */
export function warpUpdateCostLines(): string[] {
	return [
		"Updating the proxy costs more than the download:",
		"",
		"  · two enrollments — the new process registers with the exit service twice before it serves.",
		"  · 3-5 s with no service at all, between the stop and the moment the new process answers.",
		"  · new egress addresses — the tunnel comes up from a different pair than the one before.",
		"  · every parked entry stops matching a live exit. Nothing is deleted: the entries stay",
		"    exactly where they are, they just stop lining up with an exit that can serve them.",
		"",
		"  The proxy is shared: if another Pi talks through it, it loses service during the swap too.",
	];
}

export type UpdateWarpBinaryDeps = {
	/** The tag of the newest published release, or null when it cannot be read. */
	latestTag: () => Promise<string | null>;
	/** What this extension installed last, from its record. */
	installedRecord: () => { tag: string; commit: string } | undefined;
	confirm: () => Promise<boolean>;
	/** The verified path of the new binary, or undefined when nothing landed. */
	download: () => Promise<string | undefined>;
	swap: (downloaded: string, tag: string) => Promise<{ ok: boolean; rolledBack: boolean; reason?: string; inPlace?: string }>;
	/** The commit the running proxy reports for itself, or null when it has none. */
	readRunningCommit: () => Promise<string | null>;
	writeRecord: (record: { tag: string; commit: string }) => void;
	/** A request that crosses the tunnel, or "no-traffic" when it cannot. The
	 *  declaration said the pool is ready; this is the only thing that proves the
	 *  binary actually serves, and it never depends on the relay's egress mode. */
	probeTraffic?: () => Promise<WarpTraffic>;
	/** Is the downloaded file byte-identical to the installed one? The update is
	 *  asked to install the published build; when the published build is already
	 *  what is installed, the safe and honest answer is not to touch anything. It
	 *  used to evict, swap and probe in that case, which cost an exit and reported
	 *  a failure for a machine that was already correct. */
	sameFile?: (downloaded: string, installed: string) => Promise<boolean>;
	/** Where the installed binary lives, so `sameFile` has something to compare to. */
	installedPath?: string;
	/** The menu installs on request even when the tag matches: what the owner asks
	 *  for there is the file on disk replaced with the published one, not a
	 *  comparison. Without it, an update that only reports "up to date" would
	 *  leave a binary this record disagrees with in place. */
	force?: boolean;
};

export type UpdateWarpBinaryResult = {
	status: "up-to-date" | "unknown" | "declined" | "same-build" | "updated" | "rolled-back" | "failed";
	tag?: string;
	commit?: string;
	reason?: string;
	/** Only for a successful install: did the new binary carry real traffic?
	 *  It informs, it never rolls back — a flaky network must not condemn a
	 *  binary that started and declared its exits. */
	traffic?: WarpTraffic;
	/** The proxy ran but never described itself, so the record had to say "unknown". */
	identityUnreadable?: boolean;
};

/** T9c: the update, in the only order that is safe. The decision first, because
 *  an update nobody needs must not even ask for consent; consent before the
 *  download, because the download is the only step that touches the network;
 *  the swap after it, because a bad download must never leave the proxy down;
 *  and the record last, because the only commit worth recording is the one the
 *  running proxy reports — a swap that returns ok but no identity proved
 *  nothing. Every effect is a dependency so this can be measured without a
 *  network, a binary or a running proxy. */
/** Did the proxy start? Two ways to know, and the weaker one is enough.
 *
 *  `/health` is the strong answer: the process is up, serving and willing to
 *  describe itself. But it is an HTTP request made from inside the host, and on a
 *  measured machine that request never arrives while the proxy serves traffic
 *  perfectly — so gating the install on it reported a working proxy as broken, and
 *  the rollback that followed threw away a good build.
 *
 *  The port is the weak answer, and it is a fact the operating system owns: if the
 *  proxy's port is held, something bound it, and the swap only starts the binary
 *  it installed. A gate that accepts either can no longer fail an install that
 *  worked; it only reports which evidence it got.
 */
export async function warpServed(deps: {
	health: () => Promise<unknown>;
	held: () => Promise<boolean>;
}): Promise<unknown> {
	try {
		const body = await deps.health();
		if (body) return body;
	} catch {
		// A health read that threw is the same as one that did not answer.
	}
	try {
		if (await deps.held()) return { bound: true, health: "did not answer" };
	} catch {
		return undefined;
	}
	return undefined;
}

/** Is the downloaded file byte-identical to the file already installed?
 *
 *  Two comparisons are refused, because a vacuous "same" is worse than no answer:
 *  a missing installed file is a first install, not a match, and a downloaded path
 *  that is the installed path is the file compared with itself — which would let
 *  the update claim it verified something it never looked at.
 */
export async function sameBinaryFile(downloadedFile: string, installedFile: string): Promise<boolean> {
	let a: string;
	let b: string;
	try {
		a = resolve(downloadedFile);
		b = resolve(installedFile);
	} catch {
		return false;
	}
	if (a === b) return false;
	if (!existsSync(a) || !existsSync(b)) return false;
	try {
		return createHash("sha256").update(readFileSync(a)).digest("hex") ===
			createHash("sha256").update(readFileSync(b)).digest("hex");
	} catch {
		return false;
	}
}

export async function updateWarpBinary(deps: UpdateWarpBinaryDeps): Promise<UpdateWarpBinaryResult> {
	const latestTag = await deps.latestTag();
	const installed = deps.installedRecord();
	const decision = warpUpdateDecision({ latestTag, installedTag: installed?.tag ?? null });

	if (decision === "unknown") {
		return {
			status: "unknown",
			reason: lastReleaseReadFailure
				? `the release could not be read — ${lastReleaseReadFailure}`
				: "the release could not be read: with no published tag there is nothing to install and nothing to claim",
		};
	}
	if (decision === "up-to-date" && !deps.force) {
		return { status: "up-to-date", tag: latestTag ?? undefined, commit: installed?.commit || undefined };
	}

	const tag = String(latestTag).trim();
	if (!(await deps.confirm())) return { status: "declined", tag };

	const downloaded = await deps.download();
	if (!downloaded) {
		return {
			status: "failed",
			tag,
			reason: "the download failed and nothing was changed: the proxy keeps the binary it already had",
		};
	}

	// Nothing is stopped, renamed or probed for a file that is already in place.
	if (deps.sameFile && deps.installedPath) {
		let same = false;
		try {
			same = await deps.sameFile(downloaded, deps.installedPath);
		} catch {
			same = false;
		}
		if (same) return { status: "same-build", tag };
	}

	const swapped = await deps.swap(downloaded, tag);
	if (!swapped.ok) {
		const reason = swapped.reason ?? "no reason was reported";
		if (swapped.rolledBack) return { status: "rolled-back", tag, reason };
		// S33: a swap that renamed nothing cannot have failed to restore anything.
		// The only true statement is that nothing was replaced, and it names the
		// file that is still where it was.
		const nothingReplaced = swapped.inPlace
			? `nothing was replaced — ${swapped.inPlace} is still in place`
			: "nothing was replaced";
		return {
			status: "failed",
			tag,
			reason: `${reason}: the install did not prove itself and ${nothingReplaced}`,
		};
	}

	// S38: the build's identity is a fact to record, never a gate to pass. A build
	// that answers /health without declaring `build.commit` — every release before
	// that field existed — was installed and then thrown away for not describing
	// itself, which is the update refusing to keep a binary that works.
	const commit = await deps.readRunningCommit();
	const recorded = commit ?? "unknown";
	deps.writeRecord({ tag, commit: recorded });
	let traffic: WarpTraffic = "unknown";
	if (deps.probeTraffic) {
		try {
			traffic = await deps.probeTraffic();
		} catch {
			traffic = "no-traffic";
		}
	}
	return { status: "updated", tag, commit: recorded, traffic, identityUnreadable: !commit };
}

/** T9c: is there anything to install? A release publishes its tag and its
 *  assets, never the commit it was built from, and the binary's own `-version`
 *  prints the version constant from the source (v0.2.3 today), not the tag. So
 *  "already up to date" cannot be inferred from the download; it is read from
 *  the record this extension writes after a successful install. `unknown` is its
 *  own answer: no latest tag read means no claim either way. */
export function warpUpdateDecision({ latestTag, installedTag }: { latestTag: string | null; installedTag: string | null }): "up-to-date" | "update" | "unknown" {
	const normalize = (tag: string | null): string => (typeof tag === "string" ? tag.trim().replace(/^v/i, "").toLowerCase() : "");
	const latest = normalize(latestTag);
	if (!latest) return "unknown";
	const installed = normalize(installedTag);
	return installed === latest ? "up-to-date" : "update";
}

/** T9b: the two observations the notice needs, injected so the decision can be
 *  tested without a proxy or a spawn. A dependency that fails is "no answer",
 *  never an exception: this runs at an entry point and must not break it. */
export async function warpBuildDrift(deps: {
	fetchProxyBuild: () => Promise<string | null>;
	readInstalledBuild: () => string | null;
}): Promise<string | null> {
	let running: string | null = null;
	try {
		running = await deps.fetchProxyBuild();
	} catch {
		running = null;
	}
	let installed: string | null = null;
	try {
		installed = deps.readInstalledBuild();
	} catch {
		installed = null;
	}
	return warpBuildNotice({ running, installed });
}

/** D11: the proxy's own process record, kept beside its binary. It is the only
 *  thing that knows which pid belongs to us after the session that spawned it is
 *  gone: the proxy is detached on purpose, and its `/health` has no pid. */
function warpProcessPath(): string {
	return join(WARP_INSTALL_DIR, "warp-process.json");
}

export function recordWarpProcess(pid: number | undefined, bin: string, now = Date.now()): void {
	if (typeof pid !== "number" || !Number.isFinite(pid)) return;
	try {
		mkdirSync(WARP_INSTALL_DIR, { recursive: true });
		writeFileSync(warpProcessPath(), `${JSON.stringify({ pid, bin, spawned_at: now })}\n`, "utf-8");
	} catch {
		// A record that cannot be written must not break starting the proxy.
	}
}

export function readWarpProcess(): { pid: number; bin: string; spawned_at: number } | undefined {
	try {
		const raw = JSON.parse(readFileSync(warpProcessPath(), "utf-8"));
		if (!raw || typeof raw !== "object") return undefined;
		if (typeof raw.pid !== "number" || !Number.isFinite(raw.pid) || raw.pid <= 0) return undefined;
		return {
			pid: raw.pid,
			bin: typeof raw.bin === "string" ? raw.bin : "",
			spawned_at: typeof raw.spawned_at === "number" ? raw.spawned_at : 0,
		};
	} catch {
		return undefined;
	}
}

/** T9c: what this extension last installed, kept beside the binary like the
 *  process record. A release publishes its tag and its assets, never the commit
 *  inside it, and the binary prints the source's version constant — so "is the
 *  release newer than what I installed?" is a fact only this file can answer.
 *  Nothing reads it yet: the update path that will is a separate change. */
export function warpInstallRecordPath(): string {
	return join(WARP_INSTALL_DIR, "warp-install.json");
}

/** A tag that is not a non-empty string means no record, so the `tag` check is
 *  the whole shape rule; the other two fields degrade to empty values. */
export type WarpInstallRecord = { tag: string; commit: string; installed_at: number };

export function writeWarpInstallRecord({ tag, commit }: { tag: string; commit: string }, path = warpInstallRecordPath()): void {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temp, `${JSON.stringify({ tag, commit, installed_at: Date.now() })}\n`, "utf-8");
		renameSync(temp, path);
	} catch {
		// A lost record costs one unnecessary install; a thrown error would cost
		// the update that just succeeded. Leave no half-written temp behind either.
		try {
			rmSync(temp, { force: true });
		} catch {
			// Nothing more to do: the record is lost and that is survivable.
		}
	}
}

export function readWarpInstallRecord(path = warpInstallRecordPath()): WarpInstallRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		if (typeof raw.tag !== "string" || !raw.tag.trim()) return undefined;
		return {
			tag: raw.tag,
			commit: typeof raw.commit === "string" ? raw.commit : "",
			installed_at: typeof raw.installed_at === "number" ? raw.installed_at : 0,
		};
	} catch {
		return undefined;
	}
}

export type StopWarpDeps = {
	/** The proxy's `/health` body, or undefined when nothing answers. */
	probe: () => Promise<unknown>;
	recorded: () => { pid: number; bin: string } | undefined;
	/** The executable behind a pid when the platform exposes it; undefined when
	 *  it cannot be read, which is not the same as a mismatch. */
	exeOf: (pid: number) => string | undefined;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep: (ms: number) => Promise<void>;
	attempts?: number;
	/** S31: who holds the port, resolved from the port itself. Without it the
	 *  D11 record policy is the whole policy, exactly as it was. */
	holder?: () => WarpPortHolder | undefined;
	/** S31: every pid that executes the installed binary, wherever the record
	 *  says it was spawned from. */
	ours?: () => number[] | undefined;
	/** S31(b): is the port still held? The last word on whether anything may be
	 *  started in its place. */
	portHeld?: () => boolean | Promise<boolean>;
	/** S31: where a refusal says what it left alone and which pid would not die.
	 *  A stop that cannot report is quieter than the rule allows, so every caller
	 *  that swaps a binary passes one. */
	refuse?: (reason: string) => void;
};

/** S31: one path, spelled one way. Collapses `.`/`..` and repeated separators,
 *  lower-cases on Windows (paths are case-insensitive there), and drops Linux's
 *  ` (deleted)` marker — what the kernel appends to a live process's link after
 *  the file was renamed underneath it, which is still the binary we own. */
export function canonicalBinaryPath(path: string | undefined): string {
	const text = String(path ?? "").trim().replace(/ \(deleted\)$/, "");
	const absolute = /^[\\/]/.test(text);
	const parts: string[] = [];
	for (const segment of text.replace(/\\/g, "/").split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	const joined = `${absolute ? "/" : ""}${parts.join("/")}`;
	return process.platform === "win32" ? joined.toLowerCase() : joined;
}

/** S31: ownership is the path, never the image name. A `warp-minimal` copied
 *  into another directory is somebody else's process. */
export function isInstalledWarpBinary(exe: string | undefined, installed: string | undefined): boolean {
	if (!exe || !installed) return false;
	return canonicalBinaryPath(exe) === canonicalBinaryPath(installed);
}

/** S31: the listener on the proxy's port, and whether it is ours. `exe` is kept
 *  even when it is not ours, because the refusal has to name what it left
 *  alone. */
export type WarpPortHolder = { pid: number; exe?: string; ours: boolean };

/** S31: the port decides who holds it. `pids` reads the listening pids for that
 *  port and `exeOf` the executable behind each; either may answer "I cannot
 *  know", which is never turned into a claim about ownership. */
export function resolveWarpPortHolder(deps: {
	port: number;
	installed: string;
	pids: (port: number) => number[] | undefined;
	exeOf: (pid: number) => string | undefined;
}): WarpPortHolder | undefined {
	let pids: number[] | undefined;
	try {
		pids = deps.pids(deps.port);
	} catch {
		return undefined;
	}
	if (!Array.isArray(pids)) return undefined;
	for (const pid of pids) {
		if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) continue;
		let exe: string | undefined;
		try {
			exe = deps.exeOf(pid);
		} catch {
			exe = undefined;
		}
		if (!exe) continue; // an unreadable executable is not ours
		return { pid, exe, ours: isInstalledWarpBinary(exe, deps.installed) };
	}
	return undefined;
}

/** D11 + S31: stop the proxy, and refuse to guess.
 *
 *  The record is a hint, never the identity. Two facts outrank it: the process
 *  holding the port, and every process executing the installed binary. Both are
 *  path-scoped, so a same-named binary elsewhere is never touched.
 *
 *  S31 states the three conditions this enforces. (a) A process of ours that
 *  survives the eviction stops the swap before a single rename, and the refusal
 *  names the pid that would not die. (b) The port has to be observed free, so
 *  `portHeld` is asked before the answer is "stopped": the caller must never
 *  start onto a held port, which is exactly how a dead pid became the record.
 *  (c) Both waits are a fixed number of attempts, and exhausting one is a
 *  refusal that names what is still there — never a quiet proceed.
 *
 *  When the port cannot be identified the D11 record policy is unchanged, and
 *  that is deliberate: "cannot know" is not a licence to kill by name. That
 *  policy keeps its five answers, including a process that survives SIGKILL
 *  being reported as `unverified` instead of assumed dead. */
export async function stopWarpProxy(deps: StopWarpDeps): Promise<"stopped" | "nothing-to-stop" | "unknown-pid" | "refused" | "unverified"> {
	const attempts = deps.attempts ?? 20;
	const report = (reason: string): void => {
		try {
			deps.refuse?.(reason);
		} catch {
			// Reporting is the last step of a failure; it cannot become the failure.
		}
	};
	const alive = async (): Promise<boolean> => {
		try {
			return Boolean(await deps.probe());
		} catch {
			return false;
		}
	};
	/** The port when the platform lets us ask, `/health` otherwise: a stop may
	 *  only claim "gone" about something it actually observed. A check that throws
	 *  observed nothing, so it counts as still held. */
	const held = async (): Promise<boolean> => {
		if (!deps.portHeld) return alive();
		try {
			return Boolean(await deps.portHeld());
		} catch {
			return true;
		}
	};
	/** SIGTERM, bounded wait, SIGKILL, bounded wait. Bounded on purpose: a wait
	 *  that can be extended is a hang with a nicer name. */
	const evict = async (pids: number[]): Promise<boolean> => {
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			for (const pid of pids) {
				try {
					deps.kill(pid, signal);
				} catch {
					// already gone, or not ours to signal: the port decides below
				}
			}
			for (let i = 0; i < attempts; i++) {
				if (!(await held())) return true;
				await deps.sleep(150);
			}
		}
		return false;
	};

	let holder: WarpPortHolder | undefined;
	try {
		holder = deps.holder?.();
	} catch {
		holder = undefined;
	}

	// S31(a): a listener that is not our binary is the one thing this must not
	// kill, and nothing may be renamed while it holds the port.
	if (holder && !holder.ours) {
		report(
			`no se pudo detener el proxy: el puerto lo ocupa el pid ${holder.pid}${
				holder.exe ? ` (${holder.exe})` : ""
			}, que no es el binario instalado`,
		);
		return "refused";
	}

	if (holder) {
		const targets = [holder.pid];
		let others: number[] | undefined;
		try {
			others = deps.ours?.();
		} catch {
			others = undefined;
		}
		for (const pid of others ?? []) {
			if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) continue;
			if (targets.includes(pid)) continue;
			let otherExe: string | undefined;
			try {
				otherExe = deps.exeOf(pid);
			} catch {
				otherExe = undefined;
			}
			// Path-scoped: only a process executing the same binary is ours.
			if (!isInstalledWarpBinary(otherExe, holder.exe)) continue;
			targets.push(pid);
		}
		if (await evict(targets)) return "stopped";
		report(
			`no se pudo detener el proxy: el pid ${targets.join(", ")}${
				holder.exe ? ` (${holder.exe})` : ""
			} sigue ocupando el puerto después de SIGKILL`,
		);
		return "refused";
	}

	if (!(await alive())) return "nothing-to-stop";
	const record = deps.recorded();
	if (!record) return "unknown-pid";
	let exe: string | undefined;
	try {
		exe = deps.exeOf(record.pid);
	} catch {
		exe = undefined;
	}
	if (exe && record.bin && exe !== record.bin) return "refused";

	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		try {
			deps.kill(record.pid, signal);
		} catch {
			// already gone, or not ours to signal: the probe decides below
		}
		for (let i = 0; i < attempts; i++) {
			if (!(await alive())) {
				// S31(b): a silent /health is not a free port. Only an observed free
				// port lets the caller start a new binary here.
				if (!deps.portHeld) return "stopped";
				if (!(await held())) return "stopped";
				report(
					`no se pudo detener el proxy: el pid ${record.pid} dejó de responder pero el puerto sigue ocupado`,
				);
				return "refused";
			}
			await deps.sleep(150);
		}
	}
	return "unverified";
}

/** D11 / S31: the executable behind a pid, when the platform exposes it. Linux
 *  reads the kernel's own link and Windows asks the process itself; everywhere
 *  else this answers undefined, which the stop policy reads as "cannot check"
 *  and never as a mismatch. */
function exeBehindPid(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			return readlinkSync(`/proc/${pid}/exe`);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		try {
			const out = execFileSync(
				"powershell",
				["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`],
				{ encoding: "utf-8", timeout: 4000, windowsHide: true },
			);
			const path = out.trim();
			return path || undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** S31: the pids listening on a local port. Linux reads the kernel's own socket
 *  table and matches the inode against `/proc/<pid>/fd`; Windows asks
 *  PowerShell for the listener's owning process. Every other platform answers
 *  "cannot know", which the stop policy turns into the record policy rather
 *  than into a guess about who is serving. */
function warpPidsOnPort(port: number): number[] | undefined {
	if (!Number.isInteger(port) || port <= 0) return undefined;
	if (process.platform === "linux") return linuxPidsOnPort(port);
	if (process.platform === "win32") return windowsPidsOnPort(port);
	return undefined;
}

function linuxPidsOnPort(port: number): number[] | undefined {
	const wanted = port.toString(16).toUpperCase().padStart(4, "0");
	const inodes = new Set<string>();
	let tableRead = false;
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text: string;
		try {
			text = readFileSync(table, "utf-8");
		} catch {
			continue; // that family is not in use on this kernel
		}
		tableRead = true;
		for (const line of text.split("\n").slice(1)) {
			const columns = line.trim().split(/\s+/);
			if (columns.length < 10) continue;
			const local = columns[1] ?? "";
			if (!local.toUpperCase().endsWith(`:${wanted}`)) continue;
			if ((columns[3] ?? "").toUpperCase() !== "0A") continue; // LISTEN
			const inode = columns[9];
			if (inode && inode !== "0") inodes.add(inode);
		}
	}
	if (!tableRead) return undefined;
	if (inodes.size === 0) return [];

	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${entry}/fd`);
		} catch {
			continue; // another user's process: not ours to inspect
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = readlinkSync(`/proc/${entry}/fd/${fd}`);
			} catch {
				continue;
			}
			const match = /^socket:\[(\d+)\]$/.exec(target);
			if (match && inodes.has(match[1]!)) {
				pids.push(Number.parseInt(entry, 10));
				break;
			}
		}
	}
	return pids;
}

function windowsPidsOnPort(port: number): number[] | undefined {
	try {
		const out = execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`,
			],
			{ encoding: "utf-8", timeout: 4000, windowsHide: true },
		);
		return out
			.split(/\r?\n/)
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch {
		return undefined;
	}
}

/** S31: every process executing the installed binary. Linux scans the kernel's
 *  own `/proc/<pid>/exe` links; Windows asks PowerShell for each process's image
 *  path. A lookup that cannot run answers undefined, and then the caller falls
 *  back to the record instead of killing by name. */
function warpProcessesUnderInstall(installed: string): number[] | undefined {
	if (process.platform === "linux") {
		let entries: string[];
		try {
			entries = readdirSync("/proc");
		} catch {
			return undefined;
		}
		const pids: number[] = [];
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			const pid = Number.parseInt(entry, 10);
			if (isInstalledWarpBinary(exeBehindPid(pid), installed)) pids.push(pid);
		}
		return pids;
	}
	if (process.platform === "win32") {
		try {
			const out = execFileSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)\t$($_.Path)" }',
				],
				{ encoding: "utf-8", timeout: 5000, windowsHide: true },
			);
			const pids: number[] = [];
			for (const line of out.split(/\r?\n/)) {
				const [rawPid, rawPath] = line.split("\t");
				if (!rawPid || !rawPath) continue;
				const pid = Number.parseInt(rawPid.trim(), 10);
				if (Number.isInteger(pid) && isInstalledWarpBinary(rawPath.trim(), installed)) pids.push(pid);
			}
			return pids;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** S31(b) / S32: is anything holding this port right now? A completed connect
 *  means somebody is listening; a refused connect means nobody is. A timeout
 *  observed neither, so it counts as held — "could not tell" is never permission
 *  to bind. The socket is opened and closed, nothing is sent. */
export function observePortHeld(host: string, port: number, timeoutMs = 700): Promise<boolean> {
	return new Promise((done) => {
		const socket = netConnect({ host: host.replace(/^\[|\]$/g, ""), port });
		let settled = false;
		const finish = (held: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			done(held);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/** The host and port a health URL names, when it names one. */
function warpAddressOf(healthUrl: string): { host: string; port: number } | undefined {
	try {
		const url = new URL(healthUrl);
		const port = Number.parseInt(url.port, 10);
		if (Number.isInteger(port) && port > 0) return { host: url.hostname, port };
		return { host: url.hostname, port: url.protocol === "https:" ? 443 : 80 };
	} catch {
		return undefined;
	}
}

/** D11 + S31: the only place the proxy is stopped is the menu switching WARP off
 *  (and an update, which stops it to replace the binary). Closing the relay
 *  leaves it running on purpose: stopping it costs two enrollments, new
 *  addresses and the matching of every parked entry.
 *
 *  `refuse` receives the sentence a refusal produced, so the swap that asked for
 *  the stop can show the pid and the executable it left alone (S31, S33). */
async function stopWarpFromMenu(healthUrl: string, refuse?: (reason: string) => void): Promise<WarpStopResult> {
	const installed = warpInstallPath();
	const where = warpAddressOf(healthUrl);
	return stopWarpProxy({
		probe: async () => {
			try {
				const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
				return res.ok ? await res.json() : undefined;
			} catch {
				return undefined;
			}
		},
		recorded: () => readWarpProcess(),
		exeOf: exeBehindPid,
		kill: (pid, signal) => process.kill(pid, signal),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		// S31: the port decides who is evicted and the executable decides whether
		// it is ours. The record cannot pre-empt either: it once named a corpse.
		holder: () =>
			where ? resolveWarpPortHolder({ port: where.port, installed, pids: warpPidsOnPort, exeOf: exeBehindPid }) : undefined,
		ours: () => warpProcessesUnderInstall(installed),
		portHeld: where ? () => observePortHeld(where.host, where.port) : undefined,
		refuse,
	});
}

/** The five answers the stop policy can give, named once so the swap gate and
 *  the stop itself cannot drift apart. */
export type WarpStopResult = "stopped" | "nothing-to-stop" | "unknown-pid" | "refused" | "unverified";

/** D11: a swap replaces the binary underneath the proxy, so it may go ahead only
 *  when the old process is provably gone. "nothing-to-stop" is fine — there is
 *  nothing to replace underneath. The refusals are not: an unstopped proxy still
 *  serving an old binary is exactly the wrong kill this policy forbids.
 *
 *  S31: the answer is only as good as what the stop observed, so the stop itself
 *  asks the port whether it came free and refuses when it did not. The sentence a
 *  refusal produced is handed to the caller that passed a `refuse` sink, which is
 *  how the pid that would not die reaches the message (S33). */
export async function warpStopForSwap(healthUrl: string, stop: (url: string) => Promise<WarpStopResult> = stopWarpFromMenu): Promise<boolean> {
	try {
		const result = await stop(healthUrl);
		return result === "stopped" || result === "nothing-to-stop";
	} catch {
		// A stop that threw proved nothing, so it is not permission to replace.
		return false;
	}
}

/** How long the poll waits between probes. Together with the attempt count this
 *  is the whole deadline: no probe can extend it. */
export const WARP_RESTART_POLL_MS = 250;

/** The whole startup deadline: 80 × 250 ms = 20 s.
 *
 *  It used to be 20 probes, five seconds, and five seconds is shorter than the
 *  truth: a measured MASQUE start reached `WARP masque tunnel up` eleven seconds
 *  after launch, with the exit pool still cooling. Every update therefore
 *  "failed" against a build that was merely slow, and the rollback that followed
 *  could not even restore a binary it had never replaced. A deadline that is too
 *  short does not make startup faster; it only makes a working binary look
 *  broken. */
export const WARP_START_ATTEMPTS = 80;

export type StartAndVerifyDeps = {
	start: () => Promise<unknown>;
	/** The proxy's `/health` body, or undefined when nothing answers. */
	probe: () => Promise<unknown>;
	sleep: (ms: number) => Promise<void>;
	attempts?: number;
};

/** D11 / S30c: relaunch the proxy, then wait for the new binary to prove itself
 *  with `warpReadyFact`. The wait is a fixed number of probes, never an open
 *  loop, so an old build that keeps serving fails the swap instead of hanging
 *  the update. Never throws: the caller has to be able to report the failure. */
export async function warpStartAndVerify(deps: StartAndVerifyDeps): Promise<boolean> {
	try {
		await deps.start();
	} catch {
		// Nothing was launched, so there is nothing that could turn ready.
		return false;
	}
	const attempts = deps.attempts ?? WARP_START_ATTEMPTS;
	for (let i = 0; i < attempts; i++) {
		try {
			if (warpReadyFact(await deps.probe())) return true;
		} catch {
			// A probe that fails is a proxy that is not ready yet, nothing more.
		}
		if (i < attempts - 1) {
			try {
				await deps.sleep(WARP_RESTART_POLL_MS);
			} catch {
				// A failed wait still leaves the remaining attempts to spend.
			}
		}
	}
	return false;
}

/** D11 / S30c: the new binary is in place only if the answering proxy proves it:
 *  an identity, the exit capability, and at least one exit with an address. A
 *  restart that leaves the old build serving fails here, which is the whole
 *  point of checking. */
export function warpReadyFact(body: unknown): boolean {
	const b = body as { build?: { commit?: unknown }; capabilities?: { exits?: unknown }; exits?: unknown } | undefined;
	if (!b || typeof b !== "object") return false;
	const commit = b.build && typeof b.build.commit === "string" ? b.build.commit.trim() : "";
	if (!commit || commit === "unknown") return false;
	if (!b.capabilities || b.capabilities.exits !== true) return false;
	const exits = Array.isArray(b.exits) ? b.exits : [];
	// S42: the proxy declares its pool as text — "warp-<id> (in_use, served=2,
	// streams=2)" — not as objects with an `ip`. Requiring an object made this
	// function return false against every real `/health`, so no update could ever
	// pass its own readiness check, whatever the binary did. Both shapes are read:
	// what matters is that the pool reports at least one exit.
	return exits.some((exit) => {
		if (typeof exit === "string") return exit.trim().length > 0;
		if (!exit || typeof exit !== "object") return false;
		// An id alone is not an address, so an object still has to name one.
		const named = exit as { ip?: unknown; address?: unknown };
		return Boolean(named.ip ?? named.address);
	});
}

/** Where the traffic probe asks.
 *
 *  Plain HTTP on purpose: an HTTPS target needs a CONNECT tunnel, and `node:http`
 *  answers the absolute-form request a proxy accepts without any dependency. The
 *  body is public — Cloudflare publishes `warp=on` in it — so nothing secret is
 *  exposed by asking over an unencrypted hop that ends inside the tunnel anyway.
 */
export const WARP_TRAFFIC_URL = "http://www.cloudflare.com/cdn-cgi/trace";

/** What a real request through the proxy proved. `unknown` means nobody asked. */
export type WarpTraffic = "traffics" | "not-tunnelling" | "no-traffic" | "unknown";

/** Cloudflare's trace is one `key=value` per line. Only the tunnel bit matters
 *  here: which address it used belongs to the quota workflow, not to this. */
export function parseTraceFact(body: unknown): { traffic: boolean; tunnel: boolean } {
	const text = typeof body === "string" ? body : "";
	const lines = text.split("\n").map((line) => line.trim());
	return {
		traffic: text.length > 0,
		tunnel: lines.includes("warp=on"),
	};
}

/** S30f: the downloaded binary must carry traffic, not merely declare exits.
 *
 *  The startup check reads a declaration; this reads a result. They answer
 *  different questions and must never be collapsed: a proxy with every exit in
 *  cooldown declares nothing and says so honestly, while a proxy that declares a
 *  ready pool and forwards nothing is lying about the only thing it does. Neither
 *  answer depends on the relay's egress mode, because this talks to the proxy.
 *
 *  Never throws: an unreachable proxy is "no-traffic", which the caller reports
 *  and never rolls back over.
 */
export async function probeWarpTraffic(deps: {
	request: () => Promise<{ status: number; body: string }>;
	/** S41: a proxy that just started answers 503 until its pool is enrolled, which
	 *  the laboratory measured at ~3 s and six answers in a row. A single request
	 *  cannot tell "not serving" from "not ready yet", so the caller may allow a
	 *  bounded wait. Default is one attempt: no waiting unless it was asked for. */
	intervalMs?: number;
	budgetMs?: number;
}): Promise<WarpTraffic> {
	const interval = deps.intervalMs ?? 0;
	const budget = deps.budgetMs ?? 0;
	const from = Date.now();
	for (;;) {
		let answer: { status: number; body: string } | undefined;
		try {
			answer = await deps.request();
		} catch {
			answer = undefined;
		}
		if (answer && answer.status === 200) {
			const fact = parseTraceFact(answer.body);
			if (fact.traffic) return fact.tunnel ? "traffics" : "not-tunnelling";
		}
		if (interval <= 0 || Date.now() - from + interval > budget) return "no-traffic";
		await new Promise((done) => setTimeout(done, interval));
	}
}

/** S34: the traffic answer read together with `/health`, because either one on
 *  its own blames the wrong thing. Exits declared plus a request that did not
 *  come back means the binary is not carrying traffic; no exits declared plus no
 *  answer means the pool is empty, so there was no tunnel to cross and the
 *  download is not to blame.
 *
 *  A report, never a verdict: this returns lines to show and nothing else. No
 *  caller may block, retry or roll back on it, and the install stands either way.
 *  `unknown` is "nobody asked", which is not a finding. */
export function warpTrafficReport({ health, traffic }: { health: unknown; traffic: WarpTraffic }): string[] {
	const body = health as { exits?: unknown } | undefined;
	const exits = Array.isArray(body?.exits) ? body.exits.length : 0;
	if (traffic === "not-tunnelling") {
		return [
			"  El proxy nuevo responde y lleva tráfico, pero ese tráfico no va por el túnel:",
			"  Cloudflare informa warp=off. El binario quedó instalado; conviene revisarlo.",
		];
	}
	if (traffic !== "no-traffic") return [];
	return exits > 0
		? [
				`  El proxy nuevo declara ${exits} salida${exits === 1 ? "" : "s"} y una petición a través suyo`,
				"  no volvió: el binario instalado es la parte que no está llevando tráfico.",
				"  La instalación queda, y este informe no decide nada.",
			]
		: [
				"  El proxy nuevo no declara ninguna salida, así que no hay túnel por donde cruzar:",
				"  el pool está vacío y el binario no tiene la culpa.",
				"  La instalación queda, y este informe no decide nada.",
			];
}

/** One absolute-form GET sent to the proxy. No CONNECT, no TLS, no dependency:
 *  the proxy takes `GET http://host/path` and answers it through the tunnel. */
/** A loopback read that cannot leave through the tunnel (S40).
 *  The extension's global fetch can carry the egress dispatcher: a request to
 *  127.0.0.1:8789 is then dialled inside the tunnel, and an IPv6-only MASQUE
 *  tunnel has no loopback, so the read fails while the proxy serves fine.
 *  node:http with no agent always dials the address it was given. */
export function directLoopbackGet(url: string, timeoutMs = 1500): Promise<{ status: number; body: string }> {
	return new Promise((done, fail) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch (error) {
			fail(error);
			return;
		}
		const req = httpRequest(
			{
				host: target.hostname.replace(/^\[|\]$/g, ""),
				port: target.port || 80,
				path: `${target.pathname}${target.search}`,
				method: "GET",
				headers: { accept: "application/json" },
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => done({ status: res.statusCode ?? 0, body }));
			},
		);
		req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		req.on("error", fail);
		req.end();
	});
}

export function proxyHttpRequest(
	proxyUrl: string,
	target = WARP_TRAFFIC_URL,
	timeoutMs = 5000,
): Promise<{ status: number; body: string }> {
	return new Promise((done, fail) => {
		let proxy: URL;
		let destination: URL;
		try {
			proxy = new URL(proxyUrl);
			destination = new URL(target);
		} catch (error) {
			fail(error);
			return;
		}
		const req = httpRequest({
			host: proxy.hostname,
			port: proxy.port || 80,
			path: destination.toString(),
			method: "GET",
			headers: { host: destination.host, accept: "text/plain" },
			timeout: timeoutMs,
		}, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.on("end", () => done({ status: res.statusCode ?? 0, body }));
			res.on("error", fail);
		});
		req.on("timeout", () => {
			req.destroy(new Error(`the proxy did not answer in ${timeoutMs} ms`));
		});
		req.on("error", fail);
		req.end();
	});
}

export type EnsureWarpDeps = {
	target: WarpTarget;
	probe: (healthUrl: string, attempts: number) => Promise<boolean>;
	bin: () => string | undefined;
	configPath: () => string;
	configExists: () => boolean;
	/** Start the binary and hand back the process that was started; the caller
	 *  owns the detaching and the unref. */
	spawn: (bin: string, args: string[]) => { pid?: number } | undefined;
	record: (pid: number | undefined, bin: string) => void;
	/** S32: whether something already listens on the proxy port. */
	portTaken: (port: number) => Promise<boolean>;
	/** S31: who that listener is, when the platform can say. */
	holder?: (port: number) => WarpPortHolder | undefined;
};

/** D11 + S32: bring the proxy up, or report honestly that it is not up.
 *
 *  The record this writes has to describe the process that actually serves. A
 *  spawn onto a port somebody else already holds dies on bind, and recording
 *  its pid is how a corpse became the identity that every later stop then
 *  refused to touch. So the port is asked before anything is spawned: when it
 *  is already held, the record is corrected to the listener when that listener
 *  is provably ours, and nothing new is started. */
export async function ensureWarpWithDeps(deps: EnsureWarpDeps): Promise<boolean> {
	const target = deps.target;

	// (a) Probe the resolved health endpoint — if WARP answers, we are done.
	if (await deps.probe(target.healthUrl, 2)) return true;

	// (b) The target lives on another machine: nothing can be started from here,
	//     so report the miss silently and let the relay degrade per its mode.
	if (!target.isLoopback) return false;

	// (c) No health response from a local target: try to find a binary. If none
	//     exists, stay completely silent (startup must not warn or download).
	const bin = deps.bin();
	if (!bin) return false;

	// (d) S32: is the port already somebody's? A spawn that cannot bind would die
	//     and its pid would overwrite the record of the process still serving.
	let taken = true;
	try {
		taken = Boolean(await deps.portTaken(target.port));
	} catch {
		taken = true; // a check that failed observed nothing, so nothing is spawned
	}
	if (taken) {
		let holder: WarpPortHolder | undefined;
		try {
			holder = deps.holder?.(target.port);
		} catch {
			holder = undefined;
		}
		// Only a listener that is provably our binary may become the record; a
		// foreign one is reported by the stop path, not adopted here.
		if (holder?.ours) deps.record(holder.pid, holder.exe ?? bin);
		// The holder may still be coming up: give it the same probe instead of a
		// spawn that could never have bound.
		return await deps.probe(target.healthUrl, 6);
	}

	// (e) Spawn the binary, handing it the shared config file when it exists so
	//     both sides read the same listen address and health path.
	try {
		const installConfig = deps.configPath();
		const args = deps.configExists() ? ["-config", installConfig] : [];
		const child = deps.spawn(bin, args);
		// D11: remember what was started, so a later update can stop exactly this
		// process instead of hunting a pid by name or leaving it serving an old
		// binary while a new one sits on disk.
		deps.record(child?.pid, bin);

		// (f) Probe again up to 6 attempts.
		return await deps.probe(target.healthUrl, 6);
	} catch (err) {
		// (g) Log once via warpWarned.
		if (!warpWarned) {
			console.error(`pi-free-bridge: could not start warp-minimal — ${(err as Error).message}`);
			warpWarned = true;
		}
		return false;
	}
}

export async function ensureWarp(): Promise<boolean> {
	const target = resolveWarpTarget();
	const installed = warpInstallPath();
	return ensureWarpWithDeps({
		target,
		probe: probeWarp,
		bin: resolveWarpBin,
		configPath: warpConfigPath,
		configExists: () => existsSync(warpConfigPath()),
		spawn: (bin, args) => {
			const child = spawn(bin, args, {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
			child.once("error", () => undefined); // surface via probe failure
			child.unref();
			return child;
		},
		record: recordWarpProcess,
		// S31/S32: the port and the executable behind it are the facts; the record
		// this may write is only a claim about the process that serves.
		portTaken: (port) => observePortHeld(target.host, port),
		holder: (port) => resolveWarpPortHolder({ port, installed, pids: warpPidsOnPort, exeOf: exeBehindPid }),
	});
}

// ---------------------------------------------------------------------------
// Download progress
// ---------------------------------------------------------------------------
//
// Every file this extension downloads says how far along it is. The honest
// constraint is that a percentage is a claim about the whole file: it is shown
// only when the server said how big the body is (`content-length`), never
// guessed — not from the release API's `size`, not from an assumption that a
// finished stream was the whole file. A body read is all-or-nothing: a stream
// that fails midway rejects, so the caller's existing failure path runs and no
// truncated archive or binary can be written, verified or renamed into place.

/** Same base the install prompts already use for an asset size (`(1.9 MB)`),
 *  so the live readout and the consent prompt never disagree. */
const DOWNLOAD_BYTES_PER_MB = 1048576;

/** How long a progress line may go unrepeated when the percentage does not
 *  move. One notification per chunk would flood Pi's UI and slow the very
 *  download it describes. */
const DOWNLOAD_PROGRESS_INTERVAL_MS = 100;

/** A byte count the way the install prompts state one: `1.9 MB`. */
export function formatDownloadSize(bytes: number): string {
	return `${(Math.max(0, bytes) / DOWNLOAD_BYTES_PER_MB).toFixed(1)} MB`;
}

/** Percentage of a known total received so far, or undefined when there is no
 *  usable total. A missing, zero, negative or non-finite total has no
 *  percentage: dividing by it would invent a 0% or 100% the server never
 *  promised. Clamped at 100 for a server that overruns its own header. */
export function downloadPercent(received: number, total: number | undefined): number | undefined {
	if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
	if (!Number.isFinite(received) || received <= 0) return 0;
	return Math.min(100, Math.floor((received / total) * 100));
}

/** The one line the user reads while a download runs:
 *
 *   Downloading warp-minimal v0.5.0… 47% (1.9 MB / 4.0 MB)
 *   Downloading relay.js v0.6.0… 1.9 MB (size unknown)
 *
 *  `label` is the wording the caller already announces; the numbers and the
 *  percentage are appended to it rather than replacing it. */
export function formatDownloadProgress(input: {
	label: string;
	received: number;
	total?: number;
}): string {
	const percent = downloadPercent(input.received, input.total);
	if (percent === undefined) {
		return `${input.label} ${formatDownloadSize(input.received)} (size unknown)`;
	}
	return `${input.label} ${percent}% (${formatDownloadSize(input.received)} / ${formatDownloadSize(input.total as number)})`;
}

/** `content-length` as a byte count, or undefined when the server did not send
 *  a usable one — a chunked response, a garbage header, a zero total. */
export function contentLengthFrom(
	headers: { get(name: string): string | null } | null | undefined,
): number | undefined {
	const raw = headers?.get("content-length");
	if (raw === null || raw === undefined) return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.trunc(value);
}

export type DownloadProgressReporter = (received: number, force?: boolean) => void;

/** Throttled progress emitter: at most one line per interval, plus one for
 *  every whole percentage point that moves, plus one when the caller forces it
 *  (the final line, so the readout ends on the real byte count). `now` and
 *  `intervalMs` are injectable so the throttle is testable without sleeping. */
export function createDownloadReporter(input: {
	label: string;
	total?: number;
	report: (line: string) => void;
	now?: () => number;
	intervalMs?: number;
}): DownloadProgressReporter {
	const now = input.now ?? Date.now;
	const intervalMs = input.intervalMs ?? DOWNLOAD_PROGRESS_INTERVAL_MS;
	let lastAt: number | undefined;
	let lastPercent: number | undefined;
	return (received, force = false) => {
		const at = now();
		const percent = downloadPercent(received, input.total);
		if (!force && lastAt !== undefined) {
			const moved = percent !== undefined && percent !== lastPercent;
			if (!moved && at - lastAt < intervalMs) return;
		}
		lastAt = at;
		lastPercent = percent;
		input.report(formatDownloadProgress({ label: input.label, received, total: input.total }));
	};
}

/** Stream a response body, reporting progress as bytes arrive, and resolve with
 *  the complete body. Never resolves with a partial body: a stream that errors
 *  midway rejects, so a drop in the middle of a download surfaces as a failed
 *  download rather than a short one. */
export async function readDownloadBody(input: {
	body: ReadableStream<Uint8Array> | null;
	label: string;
	total?: number;
	report?: (line: string) => void;
	now?: () => number;
	intervalMs?: number;
}): Promise<Buffer> {
	if (!input.body) throw new Error(`download of ${input.label} returned no body`);
	const notify = input.report
		? createDownloadReporter({
				label: input.label,
				total: input.total,
				report: input.report,
				now: input.now,
				intervalMs: input.intervalMs,
			})
		: undefined;

	const reader = input.body.getReader();
	const chunks: Buffer[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value || value.byteLength === 0) continue;
		chunks.push(Buffer.from(value));
		received += value.byteLength;
		notify?.(received);
	}
	// Only a fully read body reaches this line, so the last thing the user sees
	// before the success message is the complete size.
	notify?.(received, true);
	return Buffer.concat(chunks);
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

/** Why the last release read failed, in words an owner can act on.
 *
 *  "GitHub did not answer" is not a diagnosis: the measured failure was a 403
 *  saying the unauthenticated limit for this IP was spent, and the only useful
 *  part of that answer — which limit, and when it comes back — was being thrown
 *  away. It is kept here so the message can name the cause and the wait. */
/** Turn a failed release read into a sentence that names the cause and the wait.
 *
 *  Pure, because the interesting part is the text and the text is what was wrong:
 *  it said "GitHub did not answer" for a 403 that said exactly what was spent and
 *  when it comes back. */
export function releaseReadFailure(
	status: number,
	body: string,
	header: (name: string) => string | null,
): string {
	const message = /"message"\s*:\s*"([^"]{0,200})"/.exec(String(body ?? ""))?.[1] ?? "";
	const parts = [`GitHub answered ${status}${message ? `: ${message}` : ""}`];
	const reset = header("x-ratelimit-reset");
	if (reset && /^\d+$/.test(reset)) {
		parts.push(`the limit comes back at ${new Date(Number(reset) * 1000).toISOString().slice(11, 16)} UTC`);
	}
	if (header("x-ratelimit-remaining") === "0") parts.push("requests remaining: 0");
	return parts.join("; ");
}

let lastReleaseReadFailure: string | undefined;

/** Latest platform asset from the release API. */
async function findWarpAsset(): Promise<{ tag: string; url: string; name: string; size: number } | undefined> {
	lastReleaseReadFailure = undefined;
	try {
		const res = await fetch(WARP_RELEASE_API, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			// The body carries the reason; the reset header carries the wait.
			let body = "";
			try {
				body = (await res.text()).slice(0, 300);
			} catch {
				body = "";
			}
			lastReleaseReadFailure = releaseReadFailure(res.status, body, (name) => res.headers.get(name));
			return undefined;
		}
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
 *  zip archives too.
 *
 *  `stage` is for the update path, and it is not a convenience: a proxy that is
 *  already running executes the file at the canonical name, so writing the new
 *  bytes over it either fails (Windows will not replace a running image) or
 *  destroys the only known-good rollback source (elsewhere). Staging leaves the
 *  verified bytes under a third name beside `current` and `current.prev`, and
 *  the swap renames them into place after the proxy stopped. Same volume by
 *  construction, so the rename never has to copy. */
async function installWarpBinary(
	asset: { tag: string; url: string; name: string; size: number },
	status?: (message: string) => void,
	options: { stage?: boolean } = {},
): Promise<string | undefined> {
	const tmpDir = mkdtempSync(join(tmpdir(), "pfb-warp-"));
	try {
		const archivePath = join(tmpDir, asset.name);
		const label = `Downloading warp-minimal ${asset.tag}…`;
		status?.(label);
		const res = await fetch(asset.url, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(60000),
		});
		if (!res.ok) {
			console.error(`pi-free-bridge: warp-minimal download failed — HTTP ${res.status}`);
			return undefined;
		}
		// The bytes only reach `archivePath` once the whole body arrived, so a drop
		// in the middle leaves nothing behind for the checksum or tar step to read.
		writeFileSync(
			archivePath,
			await readDownloadBody({ body: res.body, label, total: contentLengthFrom(res.headers), report: status }),
		);

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

		status?.(
			options.stage
				? `Staging the verified binary in ${WARP_INSTALL_DIR}…`
				: `Installing to ${WARP_INSTALL_DIR}…`,
		);
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
		const target = options.stage ? `${join(WARP_INSTALL_DIR, exeName)}.tmp` : join(WARP_INSTALL_DIR, exeName);
		if (options.stage) rmSync(target, { force: true });
		copyFileSync(extracted, target);
		if (process.platform !== "win32") chmodSync(target, 0o755);
		// The config names the binary that runs; a staged file is not it yet.
		if (!options.stage) writeBridgeConfig({ warpBin: target });
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

// ---------------------------------------------------------------------------
//
// Relay release binaries. The relay can run from a downloaded,
// checksum-verified binary instead of requiring Bun — but only after an
// explicit yes, never at Pi startup, and never replacing a working runtime
// behind the user's back.
//
// Rollback is a filename, not a copy: every install lands under
// RELAY_INSTALL_DIR with its release tag in the name, so the previous binary
// is still on disk to run again.

/** The oldest relay this extension can talk to. `/models` — the route the
 *  catalog comes from — first shipped in 0.5.1, so an older relay answers 404
 *  on it. Reporting that bare 404 sends the user hunting for a broken route;
 *  naming the version tells them what to do. */
/** The version a `/health` body reports, or undefined when it cannot be read.
 *
 *  INFORMATION ONLY — never a gate. The extension does not refuse to work
 *  because a number looks old: it asks the relay for what it can do. The numbers
 *  are aligned today only so we do not lose track of which piece is which; in
 *  the future the relay and the extension must be free to move independently,
 *  and a version comparison is exactly what would make that impossible. */
export function parseRelayVersion(health: unknown): string | undefined {
	const value = (health as { version?: unknown } | null | undefined)?.version;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Where a relay binary lives under a directory. The name carries no version:
 *  `current` is what runs and `current.prev` is what ran before. */
export function relayBinaryPath(dir: string, assetName: string): string {
	return join(dir, assetName);
}

/** What a swap needs from the outside world, injected so the sequence can be
 *  tested with fake binaries and no process is ever spawned. */
export type SwapDeps = {
	dir: string;
	name: string;
	downloaded: string;
	version: string;
	timeoutMs: number;
	/** The binary the config points at today. On a first update under the
	 *  two-name layout it is the versioned file an older scheme installed, and it
	 *  is the thing that actually answered `/health`, so it becomes `.prev`. */
	previous?: string;
	stopRelay: () => Promise<boolean>;
	startRelay: () => Promise<boolean>;
	askContinue: () => Promise<"wait" | "rollback" | "none">;
	/** S33: what this swap is replacing. The helper is shared by the relay and by
	 *  the proxy, so the noun in its messages comes from the caller and is never
	 *  baked in as "the relay". */
	label?: "relay" | "proxy";
	/** S31/S33: the sentence the stop itself produced. It wins over the generic
	 *  one, because only it can name the pid and the executable left alone. */
	stopReason?: () => string | undefined;
	logPath?: string;
	now?: () => Date;
};

export type SwapResult = {
	ok: boolean;
	rolledBack: boolean;
	reason?: string;
	installed?: string;
	/** S33: set only when nothing was replaced. It names the file still in place,
	 *  which is the whole truth a caller may report — never "not restored". */
	inPlace?: string;
};

/** Remove leftovers from the version-in-filename scheme.
 *
 *  Deliberately narrow: only files named after this binary with a `.` suffix
 *  that is not the two names this layout owns. `failed.log` and anything else a
 *  user put there is never touched — a cleanup step that deletes by wildcard is
 *  how a tool eats something it did not create. */
function purgeVersionedLeftovers(dir: string, name: string): void {
	for (const leftover of versionedLeftovers(dir, name)) rmSync(leftover, { force: true });
}

/** The version-in-filename scheme's leftovers, newest version first.
 *
 *  Matched narrowly — `<name>.` followed by an optional `v` and a digit — so this
 *  can never touch a file the tool did not create. `failed.log`, `.prev`, `.tmp`
 *  and the active binary are excluded by shape, not by allow-list. */
function versionedLeftovers(dir: string, name: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const found: { path: string; parts: number[] }[] = [];
	for (const entry of entries) {
		if (!entry.startsWith(`${name}.`)) continue;
		const suffix = entry.slice(name.length + 1);
		if (!/^v?\d[0-9A-Za-z._-]*$/.test(suffix)) continue;
		const parts = suffix
			.replace(/^v/, "")
			.split(".")
			.map((piece) => Number.parseInt(piece, 10));
		if (parts.some((piece) => Number.isNaN(piece))) continue;
		found.push({ path: join(dir, entry), parts });
	}
	found.sort((left, right) => {
		for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
			const diff = (right.parts[i] ?? 0) - (left.parts[i] ?? 0);
			if (diff !== 0) return diff;
		}
		return right.path.localeCompare(left.path);
	});
	return found.map((entry) => entry.path);
}

/** One line per failure, capped: a log that grows forever is a log nobody reads.
 *  The newest failure is the one that explains the current state, so the oldest
 *  lines are the ones dropped. */
export const FAILED_LOG_MAX_LINES = 20;

function appendFailedLog(path: string, line: string, max: number = FAILED_LOG_MAX_LINES): void {
	let existing = "";
	try {
		existing = readFileSync(path, "utf8");
	} catch {
		existing = "";
	}
	const lines = existing.split("\n").filter((entry) => entry.trim().length > 0);
	lines.push(line);
	writeFileSync(path, `${lines.slice(-max).join("\n")}\n`);
}

/** Replace the running relay binary with a verified download.
 *
 *  INVARIANT (S4): whatever is named `current` has answered `/health` at least
 *  once, and so has `.prev`. A version that fails is deleted, never kept, so
 *  `.prev` is always a known-good build. With no `.prev` there is nothing to
 *  roll back to, and the honest outcome is a clean failure that leaves nothing
 *  installed — not a half-installed relay nobody can explain later.
 *
 *  Order matters (S3): the download is verified before anything is touched, so
 *  a bad download never leaves the relay down; and the swap is byte-identical
 *  on every platform, because the relay restarts anyway and therefore does not
 *  need Linux's rename-while-running.
 */
export async function swapRelayBinary(deps: SwapDeps): Promise<SwapResult> {
	const current = relayBinaryPath(deps.dir, deps.name);
	const previous = `${current}.prev`;
	const logPath = deps.logPath ?? join(deps.dir, "failed.log");
	const now = deps.now ?? (() => new Date());
	// S33: this helper serves the relay and the proxy, so it names the one its
	// caller is replacing — never a noun baked into the helper.
	const label = deps.label ?? "relay";

	if (!existsSync(deps.downloaded)) {
		return { ok: false, rolledBack: false, reason: `no está el binario descargado en ${deps.downloaded}` };
	}

	// S3.2-3 / S31(a): a process that will not stop must not be replaced
	// underneath itself. Nothing was renamed, so the file it runs is still there.
	let stopped = false;
	try {
		stopped = await deps.stopRelay();
	} catch {
		stopped = false;
	}
	if (!stopped) {
		// S33: the stop's own sentence wins, because only it can name the pid and
		// the executable it left alone.
		let own: string | undefined;
		try {
			own = deps.stopReason?.()?.trim() || undefined;
		} catch {
			own = undefined;
		}
		return {
			ok: false,
			rolledBack: false,
			reason: own ?? `no se pudo detener el ${label} que corre`,
			inPlace: existsSync(current) ? current : undefined,
		};
	}

	// S3.4: keep one known-good binary as the rollback target, never a pile.
	//
	// Precedence, and why it is not simply "the newest file": the spare's whole
	// job is to be the build that already answered /health, so the file the config
	// names as running wins even when a higher number sits next to it — a newer
	// build that was rolled back from is precisely the one we must not keep as the
	// known-good spare. Only when nothing on disk tells us what ran do we fall back
	// to the newest version.
	const leftovers = versionedLeftovers(deps.dir, deps.name);
	const incumbent = existsSync(current)
		? current
		: deps.previous && existsSync(deps.previous)
			? deps.previous
			: undefined;
	const spare = incumbent ?? leftovers[0];
	rmSync(previous, { force: true });
	if (spare) renameSync(spare, previous);
	renameSync(deps.downloaded, current);
	if (process.platform !== "win32") chmodSync(current, 0o755);

	// S1: two names, not a cemetery. The scheme before this one left one file per
	// release (`relay-linux-x64.v0.3.0`, `.v0.4.0`, ...) and nothing ever removed
	// them — 109 MB of binaries nobody will ever run again. Exactly one is adopted
	// above; the rest go now.
	purgeVersionedLeftovers(deps.dir, deps.name);

	// S3.5
	let started = false;
	try {
		started = await deps.startRelay();
	} catch {
		started = false;
	}
	if (started) return { ok: true, rolledBack: false, installed: current };

	// S3.6: one more chance if the user asks for it. Nobody answering is not
	// permission to wait forever, so anything but an explicit "wait" rolls back.
	let answer: "wait" | "rollback" | "none" = "none";
	try {
		answer = await deps.askContinue();
	} catch {
		answer = "none";
	}
	if (answer === "wait") {
		let retried = false;
		try {
			retried = await deps.startRelay();
		} catch {
			retried = false;
		}
		if (retried) return { ok: true, rolledBack: false, installed: current };
	}

	// S3.6-7: roll back, delete the binary that failed, keep the evidence.
	//
	// Order matters more than anything else in this function. The old sequence
	// deleted `current` first and only then asked whether `.prev` existed, so a
	// machine whose spare was missing ended up with NO relay binary at all: worse
	// than an update that failed, because there is nothing left to run. So:
	//   1. decide whether there is anything to restore;
	//   2. move the failed binary aside to its own name — it can never be confused
	//      with the restored file, because the restore lands on `current` after;
	//   3. restore, then delete the failed copy.
	// The only binary this function removes is one whose bytes already failed, and
	// only after a known-good one is back in place.
	const reason = `el ${label} ${deps.version} no respondió /health`;
	appendFailedLog(logPath, `${now().toISOString()}\t${deps.version}\t${reason}`);

	// The build we just started is **still running** — that is the whole reason we
	// are here: nothing answered, but nothing died either. It must be stopped
	// before a single file moves, for two different reasons:
	//   - on Windows a running executable cannot be renamed or deleted at all, so
	//     the order below would fail with EBUSY and leave the update half done;
	//   - on Unix the rename succeeds and the process keeps running a file that no
	//     longer has a name. That orphan then holds the port, and no later stop can
	//     identify it as ours, because `/proc/<pid>/exe` points at a deleted
	//     `…​.failed`: every future update is refused before it starts.
	// So: stop, then rename, then start. In that order and no other.
	let stoppedNew = false;
	try {
		stoppedNew = await deps.stopRelay();
	} catch {
		stoppedNew = false;
	}
	if (!stoppedNew) {
		return {
			ok: false,
			rolledBack: false,
			reason: `${reason}; no se pudo detener el build nuevo, así que no se renombró ningún archivo`,
		};
	}

	if (!existsSync(previous)) {
		// Nothing to restore, so nothing good can be lost: the only binary here is
		// the one that just failed, and a corpse at the canonical name would be
		// adopted as the next `.prev` — poisoning the spare with bytes already
		// known to fail. Remove it and leave `failed.log` as the evidence.
		rmSync(current, { force: true });
		return { ok: false, rolledBack: false, reason: `${reason}; no previous version to fall back to` };
	}

	const failedPath = `${current}.failed`;
	rmSync(failedPath, { force: true });
	if (existsSync(current)) renameSync(current, failedPath);
	renameSync(previous, current);
	if (process.platform !== "win32") chmodSync(current, 0o755);
	rmSync(failedPath, { force: true });
	let restored = false;
	try {
		restored = await deps.startRelay();
	} catch {
		restored = false;
	}
	return {
		ok: false,
		rolledBack: true,
		reason: restored ? reason : `${reason}; la versión anterior tampoco respondió`,
	};
}

export const RELAY_RELEASE_API = "https://api.github.com/repos/Deury08/pi-free-bridge/releases/latest";
export const RELAY_INSTALL_DIR = join(homedir(), ".pi", "agent", "pi-free-bridge", "bin");

/** How long a swap waits for the relay to stop and then to answer /health.
 *  Shared by both waits on purpose: the same patience, applied twice. */
const RELAY_SWAP_TIMEOUT_MS = 15000;

/** Published asset name per `<platform>/<arch>`. These are the exact strings
 *  release v0.4.0 published; a wrong name is a 404 the reader cannot tell
 *  apart from an unsupported machine, so this map never guesses. */
const RELAY_ASSETS: Record<string, string> = {
	"win32/x64": "relay-windows-x64.exe",
	"linux/x64": "relay-linux-x64",
	"linux/arm64": "relay-linux-arm64",
	"darwin/x64": "relay-darwin-x64",
	"darwin/arm64": "relay-darwin-arm64",
};

/** The published asset name for a platform/arch pair, or a thrown error naming
 *  both so an unsupported machine reads as unsupported, not as a bug. */
export function relayAssetName(platform: string = process.platform, arch: string = process.arch): string {
	const name = RELAY_ASSETS[`${platform}/${arch}`];
	if (!name) {
		throw new Error(
			`pi-free-bridge: no relay binary is published for ${platform}/${arch}. ` +
				`Published: ${Object.keys(RELAY_ASSETS).join(", ")}.`,
		);
	}
	return name;
}

/** Parse a published SHA256SUMS file into name -> lowercase hex digest.
 *  Ordinary parse problems are collected instead of thrown, so the caller can
 *  refuse rather than crash. Tolerates CRLF, blank lines and the binary-marker
 *  form (`hash *name`) that `sha256sum --binary` emits. */
export function parseChecksums(text: unknown): { entries: Map<string, string>; errors: string[] } {
	const entries = new Map<string, string>();
	const errors: string[] = [];
	const lines = String(text ?? "").split(/\r?\n/);
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		if (!line) continue;
		const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
		if (!match) {
			errors.push(`line ${index + 1} is not a sha256 entry: ${line}`);
			continue;
		}
		const digest = match[1].toLowerCase();
		const name = match[2].trim();
		const previous = entries.get(name);
		if (previous && previous !== digest) {
			errors.push(`line ${index + 1} lists ${name} twice with different digests`);
			continue;
		}
		entries.set(name, digest);
	}
	return { entries, errors };
}

/** Whether the downloaded bytes may be executed.
 *  Refuses on a digest mismatch — the security-critical path — and on an asset
 *  the manifest does not list, because an unlisted binary cannot be verified.
 *  No refusal ever returns a success shape. */
export function verifyRelayChecksum(input: {
	assetName?: string;
	bytes?: Uint8Array | Buffer | string;
	checksums?: unknown;
}): {
	ok: boolean;
	reason?: "mismatch" | "not-listed";
	assetName?: string;
	expected?: string;
	actual: string;
	message?: string;
} {
	const assetName = input?.assetName ?? "";
	const raw = input?.bytes;
	const body = raw === undefined ? Buffer.alloc(0) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
	const actual = createHash("sha256").update(body).digest("hex");

	const parsed = input?.checksums instanceof Map
		? { entries: input.checksums as Map<string, string>, errors: [] as string[] }
		: input?.checksums && typeof input.checksums === "object" && "entries" in (input.checksums as object)
			? (input.checksums as { entries: Map<string, string>; errors: string[] })
			: parseChecksums(input?.checksums);

	const expected = parsed.entries.get(assetName);
	if (!expected) {
		return {
			ok: false,
			reason: "not-listed",
			assetName,
			actual,
			message:
				`pi-free-bridge: ${assetName || "the download"} is not listed in the published SHA256SUMS — ` +
				"refusing to run an unverifiable download.",
		};
	}
	if (expected !== actual) {
		return {
			ok: false,
			reason: "mismatch",
			assetName,
			expected,
			actual,
			message:
				`pi-free-bridge: checksum mismatch for ${assetName} — expected ${expected}, got ${actual}. ` +
				"The download was discarded and nothing was replaced.",
		};
	}
	return { ok: true, assetName, expected, actual };
}

/** The release asset for this machine plus the SHA256SUMS that must verify it. */
async function findRelayRelease(): Promise<
	{ tag: string; asset: { name: string; url: string; size: number }; checksumsUrl: string } | undefined
> {
	try {
		const name = relayAssetName();
		const res = await fetch(RELAY_RELEASE_API, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return undefined;
		const release = (await res.json()) as {
			tag_name?: unknown;
			assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown }[];
		};
		const assets = release.assets ?? [];
		const asset = assets.find((a) => a.name === name && typeof a.browser_download_url === "string");
		const sums = assets.find((a) => a.name === "SHA256SUMS" && typeof a.browser_download_url === "string");
		if (!asset || !sums) return undefined;
		return {
			tag: typeof release.tag_name === "string" ? release.tag_name : "unknown",
			asset: {
				name,
				url: asset.browser_download_url as string,
				size: typeof asset.size === "number" ? asset.size : 0,
			},
			checksumsUrl: sums.browser_download_url as string,
		};
	} catch {
		return undefined;
	}
}

/** Download, verify against the published SHA256SUMS, and install the relay
 *  binary for this machine. Returns the installed path, or undefined after
 *  reporting why — a refusal leaves the current runtime untouched. */
async function installRelayBinary(
	release: { tag: string; asset: { name: string; url: string; size: number }; checksumsUrl: string },
	status?: (message: string) => void,
): Promise<string | undefined> {
	const tmpDir = mkdtempSync(join(tmpdir(), "pfb-relay-"));
	try {
		const label = `Downloading ${release.asset.name} ${release.tag}…`;
		status?.(label);
		const res = await fetch(release.asset.url, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(120000),
		});
		if (!res.ok) {
			console.error(`pi-free-bridge: relay download failed — HTTP ${res.status}`);
			return undefined;
		}
		// Complete-or-throw: a half-read body rejects here, lands in the catch below
		// and is reported as a failure, leaving the staged path unwritten.
		const bytes = await readDownloadBody({
			body: res.body,
			label,
			total: contentLengthFrom(res.headers),
			report: status,
		});

		status?.("Verifying the published SHA256SUMS…");
		const sumsRes = await fetch(release.checksumsUrl, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(15000),
		});
		if (!sumsRes.ok) {
			console.error(`pi-free-bridge: SHA256SUMS unreachable — HTTP ${sumsRes.status}`);
			return undefined;
		}
		const verdict = verifyRelayChecksum({
			assetName: release.asset.name,
			bytes,
			checksums: await sumsRes.text(),
		});
		if (!verdict.ok) {
			console.error(verdict.message);
			status?.(verdict.message ?? "checksum verification failed");
			return undefined;
		}

		status?.(`Descargando en ${RELAY_INSTALL_DIR}…`);
		mkdirSync(RELAY_INSTALL_DIR, { recursive: true });
		// S3.1: the verified bytes land in a transient `.tmp` beside the two names
		// that matter, while the old relay keeps serving. Nothing is renamed until
		// the swap runs, so a bad download never leaves the relay down.
		const staged = `${relayBinaryPath(RELAY_INSTALL_DIR, release.asset.name)}.tmp`;
		if (existsSync(staged)) rmSync(staged, { force: true });
		writeFileSync(staged, bytes);
		if (process.platform !== "win32") chmodSync(staged, 0o755);
		return staged;
	} catch (err) {
		const message = `relay install failed: ${(err as Error).message}`;
		console.error(`pi-free-bridge: ${message}`);
		status?.(message);
		return undefined;
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

/** Guided relay install/update: the only place a binary is ever downloaded.
 *  Asks first and says that it restarts the relay, verifies the published
 *  checksum before executing anything, swaps atomically, restarts, polls
 *  /health, and rolls back to the previous runtime when the new binary does
 *  not come up. */
/** Which binary the relay should be started from, migrating a config that names a
 *  file the current layout no longer produces.
 *
 *  Installs before the two-name layout wrote `relayBin` as
 *  `.../bin/relay-linux-x64.v0.4.0`. Nothing produces that name any more, so a
 *  config still naming one points every start at a path that will never exist:
 *  the relay never answers, the swap rolls back, and a machine that was healthy a
 *  minute ago is left with no relay. That stale path IS the bug, so ignoring it
 *  is not enough — it is rewritten once, so the next start cannot repeat it.
 *
 *  The versioned file is not thrown away: the swap adopts it as `.prev`
 *  (versionedLeftovers), which is the one thing those leftovers are good for. */
export type RelayBinDeps = {
	read?: () => BridgeConfig;
	write?: (patch: BridgeConfig) => unknown;
	exists?: (path: string) => boolean;
};

export function resolveRelayBin(dir: string, assetName: string, deps: RelayBinDeps = {}): string {
	const read = deps.read ?? readBridgeConfig;
	const exists = deps.exists ?? existsSync;
	const canonical = relayBinaryPath(dir, assetName);
	const configured = read().relayBin?.trim();
	if (!configured) return canonical;
	if (!isStaleRelayBin(configured, assetName, exists)) return configured;
	return canonical;
}

/** True when a path is a leftover of the version-in-filename scheme.
 *
 *  Matched against the published asset names only, so an unrelated binary that
 *  happens to carry a number (`/usr/local/bin/relay-2`) is never mistaken for one
 *  of ours and silently ignored. */
export function isVersionedRelayBinName(path: string): boolean {
	// Both separators on purpose: a Windows path must be read the same on every
	// machine that parses it, and basename only knows its own platform.
	const base = path.split(/[\\\\/]/).pop() ?? path;
	for (const name of Object.values(RELAY_ASSETS)) {
		if (!base.startsWith(`${name}.`)) continue;
		if (/^v?\d/.test(base.slice(name.length + 1))) return true;
	}
	return false;
}

/** What the relay is started from: Bun running the bundled script, or a binary. */
export type RelayCommand = { kind: "bun"; path: string } | { kind: "binary"; path: string };

export type RelayCommandDeps = {
	dir?: string;
	read?: () => { relayBin?: string };
	exists?: (path: string) => boolean;
	bunPath?: () => string | undefined;
};

/** Bun wins when it is installed; a binary is the fallback.
 *
 *  Both run the same relay — the compiled binary is `relay.mjs` with the Bun
 *  runtime inside — so nothing behavioural separates them. Updating does: `pi
 *  install` refreshes the script that ships in this package, and nothing
 *  refreshes a binary. So a binary kept on disk answers only when Bun is gone; it
 *  is never preferred over it, even when `relayBin` names it on purpose.
 *
 *  A versioned leftover is not a candidate at all: starting it would run the
 *  build the human just replaced. */
export function resolveRelayCommand(deps: RelayCommandDeps = {}): RelayCommand | undefined {
	const dir = deps.dir ?? RELAY_INSTALL_DIR;
	const read = deps.read ?? readBridgeConfig;
	const exists = deps.exists ?? existsSync;
	const bunPath = deps.bunPath ?? resolveBunPath;

	const bun = bunPath();
	if (bun) return { kind: "bun", path: bun };

	const configured = read().relayBin?.trim();
	if (configured && !isVersionedRelayBinName(configured) && exists(configured)) {
		return { kind: "binary", path: configured };
	}
	for (const name of Object.values(RELAY_ASSETS)) {
		const canonical = join(dir, name);
		if (exists(canonical)) return { kind: "binary", path: canonical };
	}
	return undefined;
}

/** True when a configured `relayBin` names something the layout no longer
 *  produces, or nothing at all. */
function isStaleRelayBin(configured: string, assetName: string, exists: (path: string) => boolean): boolean {
	const base = basename(configured);
	const suffix = base.startsWith(`${assetName}.`) ? base.slice(assetName.length + 1) : undefined;
	// Version-shaped is stale even when the file is still there: the swap adopts
	// it as `.prev`, and nothing may start from that name again.
	if (suffix !== undefined && /^v?\d/.test(suffix)) return true;
	return !exists(configured);
}

/** Rewrite the config once, and only after the human said yes.
 *
 *  Split from `resolveRelayBin` on purpose: resolving is free and happens before
 *  the confirm so the message can name the real previous binary, while writing is
 *  a mutation that must not happen when the answer is "no" — declining an
 *  install has to leave the machine exactly as it was. */
export function migrateRelayBinConfig(dir: string, assetName: string, deps: RelayBinDeps = {}): string {
	const read = deps.read ?? readBridgeConfig;
	const write = deps.write ?? ((patch: BridgeConfig) => writeBridgeConfig(patch));
	const exists = deps.exists ?? existsSync;
	const canonical = relayBinaryPath(dir, assetName);
	const configured = read().relayBin?.trim();
	if (!configured || !isStaleRelayBin(configured, assetName, exists)) return canonical;
	write({ relayBin: canonical });
	return canonical;
}

/** True while an install is running. Two installs at once would each stop the
 *  relay the other just started and then swap the same two names; a second Enter
 *  during a download is enough to do it. */
let relayInstallInFlight = false;

export function beginRelayInstall(): boolean {
	if (relayInstallInFlight) return false;
	relayInstallInFlight = true;
	return true;
}

export function endRelayInstall(): void {
	relayInstallInFlight = false;
}

export function isRelayInstallInFlight(): boolean {
	return relayInstallInFlight;
}

async function runRelayInstallWithPrompt(ctx: WarpPromptContext): Promise<boolean> {
	if (!beginRelayInstall()) {
		ctx.ui.notify(
			"Ya hay una instalación del relay en curso. Esperá a que termine y volvé a intentar.",
			"warning",
		);
		return false;
	}
	try {
		return await runRelayInstallFlow(ctx);
	} finally {
		endRelayInstall();
	}
}

async function runRelayInstallFlow(ctx: WarpPromptContext): Promise<boolean> {
	const bun = resolveBunPath();
	const release = await findRelayRelease();

	if (!release) {
		ctx.ui.notify(
			[
				"pi-free-bridge: no hay release alcanzable para esta máquina.",
				`  plataforma: ${process.platform}/${process.arch}`,
				`  bun:        ${bun ?? "no encontrado"}`,
				"",
				bun
					? "  Sin release, el relay sigue usando Bun desde relay.mjs."
					: "  Sin release y sin Bun, el relay no puede arrancar.",
			].join("\n"),
			"warning",
		);
		return false;
	}

	const previousBin = resolveRelayBin(RELAY_INSTALL_DIR, release.asset.name);
	const sizeMb = release.asset.size > 0 ? ` (${(release.asset.size / 1048576).toFixed(1)} MB)` : "";
	const lines = [
		`${release.asset.name} — ${release.tag}${sizeMb}`,
		"desde github.com/Deury08/pi-free-bridge",
		"",
		`Se verifica el SHA256SUMS publicado y se instala en ${RELAY_INSTALL_DIR}.`,
		"",
		previousBin
			? `Esto DETIENE el relay que está corriendo —lo haya arrancado esta extensión o vos— y reemplaza el binario anterior (${previousBin}).`
			: "Esto DETIENE el relay que está corriendo —lo haya arrancado esta extensión o vos— para que use el binario nuevo.",
	];
	if (bun) lines.push("", `Bun ya está disponible (${bun}): si decís que no, nada cambia.`);
	lines.push(
		"",
		"El código del relay se actualiza con npm (pi install npm:pi-free-bridge@x); un binario compilado se actualiza sólo desde este menú.",
	);

	if (!ctx.hasUI) return false;
	if (!(await ctx.ui.confirm("pi-free-bridge: instalar / actualizar relay", lines.join("\n")))) {
		ctx.ui.notify("Sin cambios: no se descargó nada.", "info");
		return false;
	}

	// Only now: consent was given, so the config may be rewritten. A `relayBin`
	// naming a versioned path from before the layout change is migrated here, and
	// the swap is told to work from the canonical name.
	const previous = migrateRelayBinConfig(RELAY_INSTALL_DIR, release.asset.name);

	const downloaded = await installRelayBinary(release, (message) => ctx.ui.notify(message, "info"));
	if (!downloaded) {
		ctx.ui.notify(
			`La instalación falló y no se cambió nada. El relay sigue como estaba${bun ? " (Bun)" : ""}.`,
			"error",
		);
		return false;
	}

	ctx.ui.notify("Deteniendo el relay, intercambiando el binario y arrancando el nuevo…", "info");
	const target = relayBinaryPath(RELAY_INSTALL_DIR, release.asset.name);
	const timeoutSeconds = Math.round(RELAY_SWAP_TIMEOUT_MS / 1000);
	const result = await swapRelayBinary({
		dir: RELAY_INSTALL_DIR,
		name: release.asset.name,
		downloaded,
		version: String(release.tag ?? "").replace(/^v/, "") || "desconocida",
		timeoutMs: RELAY_SWAP_TIMEOUT_MS,
		previous,
		stopRelay: () => stopRelayByHealthPid(RELAY_SWAP_TIMEOUT_MS),
		// The same deadline as the proxy, because it is the same question: did the
		// binary we just installed manage to serve? One immediate probe answered
		// "no" whenever the spawn returned before the port was bound — a relay
		// that was merely young, rolled back as if it were broken.
		startRelay: () =>
			warpStartAndVerify({
				start: async () => {
					const resolved = resolveSessionId();
					await ensureRelay({
						port: RELAY_PORT,
						sessionId: resolved.sessionId,
						sessionSource: resolved.source,
						upstream: UPSTREAM_URL,
						cwd: process.cwd(),
					});
				},
				probe: () => fetchRelayHealth(RELAY_PORT),
				sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
			}),
		askContinue: async () => {
			if (!ctx.hasUI) return "none";
			const wait = await ctx.ui.confirm(
				"pi-free-bridge: el relay nuevo no responde",
				[
					`El binario nuevo se instaló pero no contestó /health en ${timeoutSeconds}s.`,
					"",
					"¿Esperar otra vez lo mismo, o volver al binario anterior?",
					"Si no contestás, vuelve solo al anterior: no se queda esperando para siempre.",
				].join("\n"),
			);
			return wait ? "wait" : "rollback";
		},
	});

	if (result.ok) {
		writeBridgeConfig({ relayBin: target });
		ctx.ui.notify(`Relay actualizado y respondiendo en ${relayHealthUrl(RELAY_PORT)}.`, "info");
		return true;
	}

	// A rollback leaves the known-good binary AT the canonical name, so the config
	// must point there. A first install left nothing behind: the config keeps
	// naming whatever it named before, which still works.
	writeBridgeConfig({ relayBin: result.rolledBack ? target : previous });
	ctx.ui.notify(
		[
			result.rolledBack
				? `El binario nuevo no respondió /health: ${result.reason}. Se volvió al anterior.`
				: `El binario nuevo no respondió /health: ${result.reason}.`,
			`  nuevo:    ${target} (eliminado, no se conserva una versión que falla)`,
			`  registro: ${join(RELAY_INSTALL_DIR, "failed.log")}`,
		].join("\n"),
		"error",
	);
	return false;
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
 *  Returns whether WARP ended up answering its health endpoint. Never downloads
 *  without an explicit yes from ctx.ui.confirm. */
async function ensureWarpWithPrompt(ctx: WarpPromptContext): Promise<boolean> {
	if (await ensureWarp()) return true;

	const target = resolveWarpTarget();

	// A remote target runs on another host: installing a binary here could never
	// bring it up, so report the miss and stop.
	if (!target.isLoopback) {
		ctx.ui.notify(
			`warp-minimal at ${target.healthUrl} is not answering. It runs on another host, so nothing is started here.`,
			"warning",
		);
		return false;
	}

	const bin = resolveWarpBin();
	if (bin) {
		ctx.ui.notify(
			`warp-minimal is present at ${bin} but did not answer ${target.healthUrl}.`,
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
				`Configure the path manually with warpBin in ${BRIDGE_CONFIG_PATH}\n` +
				`or set PI_FREE_BRIDGE_WARP_BIN.`,
	);
	if (!consent) return false;
	if (!asset) {
		ctx.ui.notify(
			`No release asset is reachable right now. Configure warpBin in\n${BRIDGE_CONFIG_PATH}, or set PI_FREE_BRIDGE_WARP_BIN.`,
			"warning",
		);
		return false;
	}

	ctx.ui.notify(`Downloading warp-minimal ${asset.tag}…`, "info");
	const installed = await installWarpBinary(asset, (message) => ctx.ui.notify(message, "info"));
	if (!installed) {
		ctx.ui.notify(
			`warp-minimal install failed — see the Pi error log.\n` +
				`You can still configure the path manually: warpBin in\n${BRIDGE_CONFIG_PATH}, or PI_FREE_BRIDGE_WARP_BIN.`,
			"warning",
		);
		return false;
	}
	ctx.ui.notify(`warp-minimal installed to ${installed}`, "info");

	// Start it right away so the current Pi session can use the proxy without a
	// restart. ensureWarp probes /health, then spawns the binary; the extra probe
	// gives a first run on a fresh machine time to bring the tunnel up.
	ctx.ui.notify("Starting warp-minimal…", "info");
	const up = (await ensureWarp()) || (await probeWarp(target.healthUrl, 20));
	if (!up) {
		ctx.ui.notify(
			`warp-minimal was installed but did not answer ${target.healthUrl}.\n` +
				`Check that the binary runs on this system, then retry with the "WARP: on / off" menu item.`,
			"warning",
		);
		return false;
	}
	ctx.ui.notify(
		`WARP is up on ${target.url}. Choose mode on or auto to route through it.`,
		"info",
	);
	return true;
}


// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function printDryRun(
	discovered: CatalogResult,
	session: { sessionId?: string; source: string },
): void {
	const lines = [
		"pi-free-bridge dry run",
		`  catalog:     ${discovered.source}`,
		`  upstream:    ${UPSTREAM_URL}`,
		`  relay:       ${RELAY_URL} (port ${RELAY_PORT})`,
		`  bun:         ${resolveBunPath() ?? "MISSING"}`,
		`  api:         ${API}   apiKey: ${API_KEY}`,
		`  session id:  ${
			session.sessionId
				? `${session.sessionId} (from ${session.source})`
				: "harvested by the relay from the OpenCode store"
		}`,
		`  excluded:    ${[...EXCLUDED_MODELS].join(", ")}`,
		// The relay is the side that knows which models it refused and why, so
		// this reports its count instead of printing an always-empty list again.
		`  skipped:     ${
			discovered.skippedCount === undefined
				? "unknown (the catalog did not report a count)"
				: `${discovered.skippedCount} (not free, per the relay)`
		}`,
		`  unavailable: ${discovered.unavailable ?? "no"}`,
		`  models (${discovered.models.length}):`,
		...discovered.models.map((m) => `    - ${m.id}`),
	];
	console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The seven menu entries, in the order the owner dictated. Never reorder. */
export const MENU_ITEMS = [
	"Instalar / actualizar relay",
	"Estado del relay",
	"Modo: on / off",
	"Reciclar WARP",
	"Protocolo: v1 / v2",
	"Modelos",
	"Refrescar sesión",
	"Instalar/actualizar warp",
] as const;

/** Named menu indices, so the dispatch never depends on a bare number. */
export const MENU_INSTALL = 0;
export const MENU_STATUS = 1;
export const MENU_WARP = 2;
export const MENU_RECYCLE = 3;
export const MENU_WIRE = 4;
export const MENU_MODELS = 5;
export const MENU_REFRESH = 6;
export const MENU_UPDATE_WARP = 7;

/** The sectors, in the order the owner asked for: relay and warp are the two
 *  binaries, the wire protocol is how the relay talks upstream, and everything
 *  about models is the session's own business. Sectorizing is not decoration:
 *  a flat list mixes "replace a binary" with "refresh a model list", and the
 *  two have nothing in common except living in the same file. */
export const MENU_SECTIONS: ReadonlyArray<{ label: string; actions: readonly number[] }> = [
	{ label: "Relay", actions: [MENU_INSTALL, MENU_STATUS] },
	{ label: "WARP", actions: [MENU_WARP, MENU_UPDATE_WARP, MENU_RECYCLE] },
	{ label: "Red", actions: [MENU_WIRE] },
	{ label: "Sesión", actions: [MENU_MODELS, MENU_REFRESH] },
];

/** Which items this machine can actually use, in the dictated order.
 *
 *  Progressive disclosure, not decoration: an item that can only fail is a
 *  trap. The install row exists for the machine that has no other way to run
 *  the relay, so it appears exactly when Bun is absent. With Bun present the
 *  relay source already ships in this package and npm carries its updates, so
 *  downloading a compiled copy changes nothing. Every other row needs a
 *  runnable relay — a binary, or Bun — and recycling needs a WARP binary to
 *  route through. */
export function visibleMenuIndices(state: {
	bunReady: boolean;
	binaryPresent: boolean;
	warpReady: boolean;
}): number[] {
	const runnable = state.bunReady || state.binaryPresent;
	const visible: number[] = [];
	for (let index = 0; index < MENU_ITEMS.length; index++) {
		if (index === MENU_INSTALL) {
			// The install row exists for the machine that has no other way to run the
			// relay. With Bun present the relay source already ships in this package
			// and npm carries its updates, so a compiled copy changes nothing.
			if (!state.bunReady) visible.push(index);
			continue;
		}
		// Everything else needs a runnable relay: a binary, or Bun. On a machine
		// with neither, the menu is the single row that can fix that and nothing
		// else — every other action could only fail.
		if (!runnable) continue;
		if (index === MENU_RECYCLE && !state.warpReady) continue;
		visible.push(index);
	}
	return visible;
}

/** The sector's own order, filtered by what this machine can use. Filtering the
 *  ascending visible list instead would silently reorder the sector: the declared
 *  order is the reading order, not an implementation detail. */
export function sectorActions(actions: readonly number[], visible: readonly number[]): number[] {
	return actions.filter((index) => visible.includes(index));
}

/** What a row can honestly say about being behind. The label carries a fact, not
 *  a promise: with no installed tag there is nothing to compare, so it names the
 *  published version instead of claiming "up to date". A row that cannot read
 *  the release says so — it never guesses "al día". */
export function menuUpdateSuffix({
	latestTag,
	currentTag,
}: {
	latestTag: string | null;
	currentTag: string | null;
}): string {
	if (!latestTag) return " — no se pudo verificar la última versión";
	const latest = String(latestTag).trim().replace(/^v/, "");
	if (!latest) return " — no se pudo verificar la última versión";
	if (!currentTag) return ` — última publicada: ${latest}`;
	const current = String(currentTag).trim().replace(/^v/, "");
	if (current === latest) return ` — al día (${latest})`;
	return ` — hay ${latest}, corre ${current}`;
}

/** The latest published tag, read once when the extension loads. A menu open must
 *  spend nothing: the API allows sixty unauthenticated reads an hour, and a menu
 *  is opened far more often than a release is published. The read is a promise
 *  stored at startup, so the first menu open waits for it at most once and every
 *  later one is already settled. A failure stays a failure — "no answer" is a
 *  fact this row is allowed to state. */
const latestTagReads = new Map<string, Promise<string | null>>();

export async function readLatestTag(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	try {
		const res = await fetchImpl(url, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { tag_name?: unknown };
		return typeof body.tag_name === "string" ? body.tag_name : null;
	} catch {
		return null;
	}
}

/** Starts the one read per URL, at startup. Calling it twice is harmless. */
export function warmLatestTags(urls: readonly string[], fetchImpl: typeof fetch = fetch): void {
	for (const url of urls) {
		if (!latestTagReads.has(url)) latestTagReads.set(url, readLatestTag(url, fetchImpl));
	}
}

/** The startup answer, or "no answer" when nothing was read for this URL. */
export async function latestPublishedTag(url: string): Promise<string | null> {
	const pending = latestTagReads.get(url);
	return pending ? await pending : null;
}

/** After an install we know the tag better than any read does: the row must not
 *  keep saying "hay 0.4.1" about the release we just installed. */
export function noteInstalledTag(url: string, tag: string): void {
	latestTagReads.set(url, Promise.resolve(tag));
}

export default async function (pi: ExtensionAPI) {
	// One read per release, at startup, in the background: the menu must not wait
	// for the network, but it must have the fact when it opens.
	try {
		warmLatestTags([WARP_RELEASE_API, RELAY_RELEASE_API]);
	} catch {
		// A release read that cannot even start is "no answer", not a crash.
	}
	const g = globalThis as Record<symbol, unknown>;
	if (g[REG_KEY]) return;

	/** Register or re-register the provider from a catalog. Registration after
	 *  initial loading takes effect immediately (docs/custom-provider.md:122),
	 *  so publishing a fresh list never asks the user to restart Pi.
	 *
	 *  One body for the three callers — startup, the menu refresh and the
	 *  post-install republish — because three copies would eventually disagree
	 *  about `refreshModels` or the streaming handler. */
	function publishCatalog(models: RegistryModel[]): void {
		pi.registerProvider(PROVIDER, {
			apiKey: API_KEY,
			api: API,
			baseUrl: RELAY_URL,
			authHeader: true,
			models: buildPiModels(models),
			// Pi calls this on every model refresh, so the picker follows the
			// service instead of a snapshot taken at startup. No embedded list
			// and no fallback: an unreachable catalog reports empty.
			refreshModels: async ({ signal }: { signal?: AbortSignal }) =>
				buildPiModels((await fetchRelayCatalog(signal)).models) as never,
			streamSimple: gateStreamSimple,
		});
	}

	const session = resolveSessionId();

	// The relay first, then its catalog: the extension no longer has a door of
	// its own to the service, so asking for models before the relay exists is
	// asking a process that is not running. Starting it here also keeps the
	// original intent (the first real request never pays the spawn cost).
	// A failure is reported once and retried on the first real request; it must
	// never take Pi down at startup.
	if (process.env.PI_FREE_BRIDGE_DRY_RUN !== "1") {
		await ensureRelay({
			port: RELAY_PORT,
			sessionId: session.sessionId,
			sessionSource: session.source,
			upstream: UPSTREAM_URL,
			cwd: process.cwd(),
		}).catch((err) => {
			console.error(`pi-free-bridge: relay not ready — ${(err as Error).message}`);
		});
	}

	// The catalog comes from the relay, never from the OpenCode cache file: that
	// file only exists on a machine that already has OpenCode, which is the
	// opposite of the machine this bridge is for.
	const discovered =
		process.env.PI_FREE_BRIDGE_SKIP_CATALOG === "1"
			? { models: [] as RegistryModel[], source: "catalog fetch skipped" }
			: await fetchRelayCatalog(AbortSignal.timeout(4000));

	if (process.env.PI_FREE_BRIDGE_DRY_RUN === "1") {
		printDryRun(discovered, session);
	}

	// Zero models is NOT a failure any more. The provider is only registered
	// when it has a catalog to publish — registering an empty list would blank
	// the provider — but the commands below must register either way. The menu
	// is most needed on a machine where nothing is set up yet, and that is
	// exactly the machine that used to lose it to an early return here.
	if (discovered.models.length === 0) {
		// A catalog that could not be read is not a vendor without free models.
		// Reporting them the same way would send someone hunting for a missing
		// model when the real problem is an unreachable relay.
		console.error(
			discovered.unavailable
				? `pi-free-bridge: model catalog unavailable — ${discovered.unavailable}. ` +
						"The provider stays unregistered until the relay can answer. Run /free-bridge."
				: `pi-free-bridge: the catalog answered with no free models (${discovered.source}). ` +
						"The provider stays unregistered. Run /free-bridge for details.",
		);
	} else {
		publishCatalog(discovered.models);
	}

	g[REG_KEY] = true;

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

	// -----------------------------------------------------------------------
	// Command surface (spec odd/tasks/relay-download.md, S1-S3).
	//
	// Only three commands stay registered: `free-bridge` (this menu),
	// `free-bridge-warp-recycle` (for incidents) and `free-bridge-doctor`
	// (direct only, never in the menu). The other capabilities still work —
	// they are reached from the menu instead of from autocomplete, because
	// every registered command, aliases included, costs a completion entry.
	// -----------------------------------------------------------------------

	/** Is Bun resolvable? It is never a dependency — the relay can come as a
	 *  compiled binary instead — but when it is there it runs the script this
	 *  package already ships, with nothing to download. */
	function bunReady(): boolean {
		return resolveBunPath() !== undefined;
	}

	/** Is there a compiled binary the spawn would accept? Same order `startRelay`
	 *  applies: a configured path that is not a versioned leftover, then the
	 *  canonical name of any published asset. A version-shaped `relayBin` exists
	 *  but is refused by the spawn, so it never counts here. */
	function binaryPresent(): boolean {
		const configured = readBridgeConfig().relayBin?.trim();
		if (configured && !isVersionedRelayBinName(configured) && existsSync(configured)) return true;
		return Object.values(RELAY_ASSETS).some((name) => existsSync(join(RELAY_INSTALL_DIR, name)));
	}

	/** Is a WARP binary available? Recycling an exit without one is a menu
	 *  entry that can only fail, so it is hidden. */
	function warpReady(): boolean {
		const bin = resolveWarpBin();
		return bin !== undefined && existsSync(bin);
	}

	/** ctx shape the menu needs: notify/confirm always, select when Pi offers it. */
	type MenuCtx = WarpPromptContext & {
		ui: { select?(title: string, options: string[]): Promise<string | undefined> };
	};

	/** Health payload fields this file reads beyond the shared type. */
	type RelayHealthExtras = { wireMode?: string };

	/** Rotate the WARP exit now. Shared by menu item 4 and the
	 *  `free-bridge-warp-recycle` command — one body, never two copies. */
	async function runWarpRecycle(ctx: MenuCtx): Promise<void> {
		const before = await fetchRelayHealth(RELAY_PORT);
		if (!before) {
			ctx.ui.notify(
				`pi-free-bridge: the relay does not answer on ${relayHealthUrl(RELAY_PORT)} — nothing to rotate.`,
				"error",
			);
			return;
		}

		const lines = [
			"pi-free-bridge warp recycle",
			`  relay:   ${relayHealthUrl(RELAY_PORT)}`,
			`  mode:    ${before.warpMode ?? "unknown"}${
				before.warpModeSource ? ` (from ${before.warpModeSource})` : ""
			}`,
			`  before:  streak ${before.warp429Streak ?? 0}, ${before.warpRecycles ?? 0} recycle(s), last egress ${
				before.lastEgress ?? "none"
			}`,
		];

		if ((before.warpMode ?? "off") === "off") {
			lines.push(
				"",
				"  warp is off, so the 429 came from the direct egress: rotating WARP",
				"  cannot fix it. Choose «WARP: on / off» in the menu (or on) first.",
			);
			ctx.ui.notify(lines.join("\n"), "error");
			return;
		}

		const outcome = await requestWarpRecycle(RELAY_PORT);

		if (outcome.kind === "absent") {
			lines.push("", "  FAILED — the relay did not accept the request.");
			ctx.ui.notify(lines.join("\n"), "error");
			return;
		}

		if (outcome.kind === "timeout") {
			lines.push(
				"",
				"  no answer in 25s. A rotation can wait up to two minutes for responses",
				"  still being delivered over the tunnel, and it rotates on its own when that",
				"  wait ends. Re-run this command to read the result.",
				"",
				"  Heads up: if this session talks through the bridge, the rotation replaces",
				"  the exit under your own answer. Best run from a session that does not.",
			);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		const body = outcome.body;
		if (outcome.status === 404) {
			// The route is part of the relay build, not of the extension: a 404
			// means an older relay is answering, and calling that a refusal would
			// send the reader looking for a step that does not exist.
			lines.push(
				"",
				`  the relay on port ${RELAY_PORT} has no /warp/recycle route: it is still`,
				"  running an older build. Restart Pi so the extension spawns the new one,",
				"  then run this command again.",
			);
			ctx.ui.notify(lines.join("\n"), "error");
			return;
		}

		// One line per step, never an aggregate verdict: the sweep is the answer
		// (which exit it drained, what the proxy said, what the pool looks like
		// afterwards), and a single "rotated" would hide exactly the two-exit
		// case where one swap is the whole recovery.
		const steps = body.steps ?? [];
		lines.push("  steps:");
		if (steps.length === 0) {
			lines.push("    (the relay reported no step)");
		}
		for (const [index, step] of steps.entries()) {
			const action = step.action === "swap" ? `swap ${step.exit ?? "an unnamed exit"}` : "recycle";
			const usable =
				typeof step.usable === "number" ? `${step.usable} usable exit(s)` : "usable count unknown";
			lines.push(`    ${index + 1}. ${action} — ${step.outcome ?? "unknown"}, ${usable}`);
		}
		lines.push(
			"",
			`  result:  ${body.ok ? "recovered" : `stopped (${body.reason ?? "unknown"})`}`,
			`  after:   ${body.warpRecycles ?? before.warpRecycles ?? 0} recycle(s), streak ${
				body.warp429Streak ?? 0
			}`,
		);

		if (!body.ok) {
			lines.push(
				"",
				"  in_flight      another rotation is running right now — look again shortly.",
				"  no_proxy       the relay has no WARP proxy configured.",
				"  not_confirmed  the proxy took the POST but never showed a new exit.",
				"  no_standby     the proxy has no standby exit — the pool is one exit thin.",
				"  unavailable    the proxy has no /swap route (older build) — only a recycle is left.",
				"  cooldown       an exit is parked for 30 minutes by the proxy; the recycle clears it.",
			);
		}

		lines.push(
			"",
			"  The sweep is also what runs by itself on the next request after a warp 429;",
			"  this command is for when it did not, or when you do not want to spend a turn.",
		);
		ctx.ui.notify(lines.join("\n"), body.ok ? "info" : "error");
	}

	/** The one command that updates warp-minimal — and therefore the only path
	 *  that stops the proxy to replace its binary. The decision, the consent order
	 *  and the rollback live in `updateWarpBinary` and `swapRelayBinary`; this body
	 *  supplies their real deps and turns the outcome into one message per status.
	 *
	 *  Two refusals come first, because both would cost more than saying no: a
	 *  session with no UI cannot show the cost before stopping the proxy, and a
	 *  proxy started from a path outside WARP_INSTALL_DIR keeps executing bytes
	 *  this command would never replace. */
	async function runWarpUpdate(ctx: MenuCtx): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				[
					"pi-free-bridge: this command replaces the proxy binary, and replacing it",
					"STOPS the proxy on purpose: the file is swapped underneath the process",
					"that is serving right now. That needs a confirmation, and this session has",
					"no UI to ask in.",
					"",
					"Run /free-bridge → WARP → Instalar/actualizar warp from an interactive Pi session.",
				].join("\n"),
				"warning",
			);
			return;
		}

		const target = resolveWarpTarget();
		const exeName = process.platform === "win32" ? "warp-minimal.exe" : "warp-minimal";
		const binPath = warpInstallPath();
		const runningBin = resolveWarpBin();
		const sameDir = (left: string, right: string): boolean =>
			left.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
			right.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		if (runningBin && !sameDir(dirname(runningBin), WARP_INSTALL_DIR)) {
			ctx.ui.notify(
				[
					"free-bridge-warp-update",
					`  runs from: ${runningBin}`,
					`  replaces:  ${binPath}`,
					"",
					"The running proxy is not the binary this command owns, so swapping the file",
					"here would leave the old process serving the old build. Point warpBin (in",
					`${BRIDGE_CONFIG_PATH}) or PI_FREE_BRIDGE_WARP_BIN at ${binPath}, then run it again.`,
				].join("\n"),
				"warning",
			);
			return;
		}

		// Facts the outcome message needs and `UpdateWarpBinaryResult` cannot carry:
		// whether the swap was even reached, whether the proxy stopped, and whether
		// the new binary landed. Each one changes what "the old binary" means.
		let asset: { tag: string; url: string; name: string; size: number } | undefined;
		let staged: string | undefined;
		let swapAttempted = false;
		let stoppedForSwap: boolean | undefined;
		// True when the swap accepted the port as proof because /health never came.
		let servedBoundOnly = false;
		let swapOk = false;
		let swapInPlace: string | undefined;
		let stopReason: string | undefined;
		let proxyHealthBody: unknown;

		const proxyHealth = async (): Promise<unknown> => {
			try {
				// S40: direct, never through the tunnel. This is the probe that read
				// "no respondió /health" for two healthy builds in a row.
				const res = await directLoopbackGet(target.healthUrl, 1500);
				return res.status >= 200 && res.status < 300 ? JSON.parse(res.body) : undefined;
			} catch {
				return undefined;
			}
		};
		const timeoutSeconds = Math.round(RELAY_SWAP_TIMEOUT_MS / 1000);

		/** Where the old binary stands after an attempt that installed no verified
		 *  build. Never a bare verdict: every branch names a file. */
		const restoreNote = (): string[] => {
			if (!swapAttempted) return [`  No se cambió nada: ${binPath} sigue siendo el binario que ya estaba.`];
			if (stoppedForSwap === false) return [`  No se pudo detener el proxy, así que ${binPath} no se reemplazó.`];
			if (swapOk) return [`  El binario nuevo está en ${binPath}; el anterior quedó guardado como ${binPath}.prev.`];
			// S33: a swap that renamed nothing never "failed to restore" anything.
			if (swapInPlace) return [`  No se reemplazó nada: ${swapInPlace} sigue en su lugar.`];
			return [`  No se pudo restaurar el binario anterior: ${binPath} no lo contiene.`];
		};

		let result: UpdateWarpBinaryResult | undefined;
		let thrown: string | undefined;
		try {
			result = await updateWarpBinary({
				// The menu action means "install the published binary", not "tell me
				// whether it is newer": the owner asked for the file to be replaced.
				force: true,
				// Proof, not declaration: one request through the proxy. It talks to
				// the proxy directly, so the relay's egress mode never enters it.
				probeTraffic: () =>
					probeWarpTraffic({
						request: () => proxyHttpRequest(target.url),
						// S41: the pool takes seconds to enroll; a cold start must not read
						// as "the build carries no traffic".
						intervalMs: 500,
						budgetMs: WARP_START_ATTEMPTS * WARP_RESTART_POLL_MS,
					}),
				// The published build is compared with the installed one before
				// anything is stopped: an update that has nothing to install must not
				// evict a working proxy, and must not spend an exit proving it.
				installedPath: binPath,
				sameFile: sameBinaryFile,
				latestTag: async () => {
					asset = await findWarpAsset();
					return asset?.tag ?? null;
				},
				installedRecord: () => {
					const record = readWarpInstallRecord();
					return record ? { tag: record.tag, commit: record.commit } : undefined;
				},
				confirm: async () => {
					const lines = [
						`${asset?.tag ?? "the latest release"} — warp-minimal from github.com/Deury08/warp-minimal`,
						"  update path: S41 — direct /health, cold-pool wait, eviction by path",
						`  installs to ${binPath}`,
						"  the published sha256 is verified before anything is executed",
						"",
						"This is the only path that stops the proxy: the binary is replaced",
						"underneath the process serving right now, and it stays down until the",
						"new one answers /health.",
						"",
						...warpUpdateCostLines(),
					];
					return ctx.ui.confirm("pi-free-bridge: update warp-minimal", lines.join("\n"));
				},
				download: async () => {
					// One release read for the whole update: the tag the decision used and
					// the asset that is downloaded must be the same release.
					const release = asset ?? (await findWarpAsset());
					if (!release) return undefined;
					staged = await installWarpBinary(release, (message) => ctx.ui.notify(message, "info"), {
						stage: true,
					});
					return staged;
				},
				swap: async (downloaded, tag) => {
					swapAttempted = true;
					const swapped = await swapRelayBinary({
						dir: WARP_INSTALL_DIR,
						name: exeName,
						downloaded,
						version: String(tag).replace(/^v/, "") || "unknown",
						timeoutMs: RELAY_SWAP_TIMEOUT_MS,
						// S33: this command replaces the proxy, so the shared helper says so and
						// repeats whatever the stop itself reported (S31: only that sentence
						// can name the pid and the executable left alone).
						label: "proxy",
						stopReason: () => stopReason,
						stopRelay: async () => {
							stopReason = undefined;
							stoppedForSwap = await warpStopForSwap(target.healthUrl, (url) =>
								stopWarpFromMenu(url, (reason) => {
									stopReason = reason;
								}),
							);
							return stoppedForSwap;
						},
						startRelay: () =>
							warpStartAndVerify({
								start: () => ensureWarp(),
								// The port is a fact the OS owns; /health is a request that, on a
								// measured machine, never arrives while the proxy serves fine.
								probe: async () => {
									const evidence = await warpServed({
										health: proxyHealth,
										held: async () => {
											const where = warpAddressOf(target.healthUrl);
											return where ? observePortHeld(where.host, where.port) : false;
										},
									});
									if (evidence && (evidence as { bound?: unknown }).bound === true) servedBoundOnly = true;
									return evidence;
								},
								sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
							}),
						askContinue: async () => {
							if (!ctx.hasUI) return "none";
							const wait = await ctx.ui.confirm(
								"pi-free-bridge: the new proxy did not answer",
								[
									`The new warp-minimal is installed but did not answer /health in ${timeoutSeconds}s.`,
									`  target: ${target.healthUrl}`,
									"",
									`Wait the same ${timeoutSeconds}s again, or go back to the previous binary?`,
									"If you do not answer, the previous binary comes back on its own.",
								].join("\n"),
							);
							return wait ? "wait" : "rollback";
						},
					});
					swapOk = swapped.ok;
					swapInPlace = swapped.inPlace;
					return {
						ok: swapped.ok,
						rolledBack: swapped.rolledBack,
						reason: swapped.reason,
						inPlace: swapped.inPlace,
					};
				},
				readRunningCommit: async () => {
					const body = (await proxyHealth()) as { build?: { commit?: unknown } } | undefined;
					// S34: the /health read that proves the commit is also what the traffic
					// report is read with; one answer alone blames the wrong thing.
					proxyHealthBody = body;
					const commit = body?.build && typeof body.build.commit === "string" ? body.build.commit.trim() : "";
					return commit && commit !== "unknown" ? commit : null;
				},
				writeRecord: ({ tag, commit }) => writeWarpInstallRecord({ tag, commit }),
			});
		} catch (err) {
			thrown = (err as Error)?.message || String(err);
		} finally {
			// A staged download is either renamed into place by the swap or left behind
			// by a swap that never ran; it must not linger as a third name.
			if (staged) {
				try {
					rmSync(staged, { force: true });
				} catch {
					// A leftover staged file costs disk, not correctness.
				}
			}
		}

		const lines = ["Actualización de warp-minimal", `  proxy:   ${describeWarpTarget(target)}`];

		if (!result) {
			lines.push(`  La actualización se detuvo con un error: ${thrown ?? "no se informó ningún resultado"}.`, ...restoreNote());
			ctx.ui.notify(lines.join("\n"), "error");
			return;
		}

		switch (result.status) {
			case "up-to-date":
				lines.push(
					`  ${result.tag} ya es la versión que instaló esta extensión${
						result.commit ? ` (commit ${result.commit})` : ""
					}: no se descargó nada.`,
				);
				break;
			case "unknown":
				lines.push(
					"  No se pudieron leer las versiones publicadas de Deury08/warp-minimal:",
					"  no se descargó nada y no se tocó nada. El proxy sigue con el binario que tiene.",
					`  ${result.reason ?? "no se informó el motivo"}`,
					"  GitHub permite 60 consultas por hora por IP sin cuenta; el proxy no se ve",
					"  afectado, y este comando se puede volver a ejecutar cuando pase la espera.",
				);
				break;
			case "declined":
				lines.push("  Respondiste que no: no se descargó nada y no se detuvo nada.");
				break;
			case "same-build": {
				// The honest report for a machine that was already right: the file was
				// replaced by the same bytes, so nothing was touched and nothing spent.
				const hash = createHash("sha256").update(readFileSync(binPath)).digest("hex").slice(0, 12);
				lines.push(
					`  La versión publicada es idéntica, byte por byte, al archivo que ya está en ${binPath}`,
					`  (sha256 ${hash}…): no hay nada que instalar y nada que reemplazar.`,
					"  No se detuvo el proxy, no se renombró ningún archivo y no se gastó ninguna salida.",
				);
				break;
			}
			case "updated":
				// S39: the proof is the request, not the declaration. One real request
				// through the proxy says the new build serves, and it says so whatever
				// the relay's egress mode happens to be, because it talks to the proxy.
				if (result.traffic === "traffics") {
					lines.push("  La petición de prueba cruzó el túnel: el proxy nuevo está sirviendo.");
				}
				if (result.identityUnreadable) {
					lines.push(
						`  El proxy en ${binPath} está corriendo pero no declara su versión, y un binario`,
						"  que no declara su versión es anterior a la que incorporó ese dato:",
						"  la instalación queda, el registro dice «desconocida» y conviene reemplazarlo.",
					);
				}
				// until the next restart: after this point the installed tag is a fact
				// this session produced.
				if (result.tag) noteInstalledTag(WARP_RELEASE_API, result.tag);
				// S34: reported together with /health and nothing more. It never blocks
				// the install, never rolls back and is never retried.
				lines.push(...warpTrafficReport({ health: proxyHealthBody, traffic: result.traffic ?? "unknown" }));
				lines.push(
					`  ${result.tag} quedó instalado, y ${target.healthUrl} responde /health`,
					`  con el commit ${result.commit}: esta extensión registró lo que ahora corre.`,
				);
				break;
			case "rolled-back":
				lines.push(
					`  La versión nueva no llegó a probar que sirve: ${result.reason}.`,
					`  Se dejó el binario anterior en ${binPath}; el que falló se borró.`,
				);
				break;
			case "failed":
				lines.push(`  ${result.reason}.`, ...restoreNote());
				break;
		}

		const level =
			result.status === "failed"
				? "error"
				: result.status === "unknown" || result.status === "rolled-back"
					? "warning"
					: "info";
		ctx.ui.notify(lines.join("\n"), level);
	}

	/** Menu item 2: what the relay is doing right now. */
	async function showRelayStatus(ctx: MenuCtx): Promise<void> {
		const health = await fetchRelayHealth(RELAY_PORT);
		const extras = health as (RelayHealthExtras & typeof health) | null;
		const wireOnWire = extras?.wireMode;
		const lines = [
			"pi-free-bridge relay",
			`  url:        ${RELAY_URL}`,
			`  process:    ${describeRelay()}`,
			`  health:     ${health ? "answering" : "not answering"} (${relayHealthUrl(RELAY_PORT)})`,
			// Information, not a contract: it says which piece is running, and the
			// extension has already decided what to do by capability.
			`  version:    ${parseRelayVersion(health) ?? "not reported (relay older than the version field)"}`,
			`  catalog:    ${discovered.models.length} free from ${discovered.source}`,
			`  session:    ${
				health?.sessionId
					? `${health.sessionId} (from ${health.sessionSource})`
					: "resolved at the first request by the relay"
			}`,
			`  warp:       ${health?.warpMode ?? resolveWarpMode()}${
				health?.lastEgress ? ` — last egress ${health.lastEgress}` : ""
			}`,
			`  cable:      ${wireOnWire ?? resolveWireMode()}`,
			`  bun:        ${resolveBunPath() ?? "not found"}`,
			`  upstream:   ${UPSTREAM_URL}`,
		];
		ctx.ui.notify(lines.join("\n"), health ? "info" : "warning");
	}

	/** Menu item 6: the free models this extension registered. */
	function showFreeModels(ctx: MenuCtx): void {
		const lines = [
			`pi-free-bridge: ${discovered.models.length} free models from ${discovered.source}`,
			...discovered.models.map((m) => `  ${PROVIDER}/${m.id}`),
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	/** Menu item 7: re-fetch the catalog from the service and re-register.
	 *  Registration is live (docs/custom-provider.md:122), so no Pi restart. */
	async function refreshLiveModels(ctx: MenuCtx): Promise<void> {
		ctx.ui.notify("Refreshing the free-model catalog from the service…", "info");
		try {
			const catalog = await fetchRelayCatalog(AbortSignal.timeout(8000));
			if (catalog.models.length === 0) {
				ctx.ui.notify(
					catalog.unavailable
						? `Catalog unavailable: ${catalog.unavailable}. Keeping the current list.`
						: `The service answered with no free models (${catalog.source}). Keeping the current list.`,
					catalog.unavailable ? "error" : "warning",
				);
				return;
			}
			publishCatalog(catalog.models);
			ctx.ui.notify(
				`${PROVIDER} now registers ${catalog.models.length} free models: ${catalog.models.map((m) => m.id).join(", ")}`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(`Could not refresh: ${(err as Error).message}`, "error");
		}
	}

	/** Menu item 3: report the WARP mode and switch it. */
	async function promptWarpMode(ctx: MenuCtx): Promise<void> {
		const envOverride = normalizeWarpMode(process.env.PI_FREE_BRIDGE_WARP_MODE);
		const health = await fetchRelayHealth(RELAY_PORT);
		const onWire = health?.warpMode
			? `relay reports ${health.warpMode}${health.lastEgress ? `, last egress ${health.lastEgress}` : ""}`
			: "relay not running";
		const current = resolveWarpMode();
		const warpTarget = resolveWarpTarget();
		ctx.ui.notify(
			[
				`pi-free-bridge warp: ${current} (config)${envOverride ? ` — env override wins: ${envOverride}` : ""}`,
				onWire,
				`target: ${describeWarpTarget(warpTarget)}`,
				`health: ${warpTarget.healthUrl}`,
				"off: direct only; auto: direct first, WARP on rate limit; on: always WARP.",
			].join("\n"),
			"info",
		);

		// Entering this item: is WARP answering? If not, launch the installed
		// binary; only when no binary exists is the download offered (yes/no).
		// Nothing is downloaded at Pi startup.
		await ensureWarpWithPrompt(ctx);

		// T9b: the one place the build-drift notice is shown. It runs after
		// ensureWarpWithPrompt, so the proxy has answered and its build is a fact
		// rather than a guess; the installed side is the record the update command
		// wrote, so nothing is spawned to ask a binary its version. Silence when the
		// two agree, when the record is missing, or when the lookup fails: a notice
		// that cannot name a real drift is noise, and an error here must never
		// stop the menu.
		try {
			const drift = await warpBuildDrift({
				fetchProxyBuild: async () => {
					const response = await fetch(warpTarget.healthUrl);
					if (!response.ok) return null;
					const body = (await response.json()) as { build?: { commit?: unknown } };
					// Go publishes the literal "unknown" for a build with no injected
					// commit (S25: the proxy states facts). That is not an identity, so it
					// must not become the "running" side of a comparison.
					const commit = body.build?.commit;
					return typeof commit === "string" && commit !== "unknown" ? commit : null;
				},
				readInstalledBuild: () => readWarpInstallRecord()?.commit ?? null,
			});
			if (drift) ctx.ui.notify(drift, "warning");
		} catch {
			// No answer is not a drift.
		}

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

		// bun-upgrades S4: a non-off mode needs warp-minimal alive. The guided
		// download only runs after an explicit yes.
		if (chosen !== "off" && !(await ensureWarpWithPrompt(ctx))) {
			if (chosen === "on") {
				// `on` is WARP-only; switching without a working WARP would fail
				// every request until WARP comes up.
				ctx.ui.notify(
					`Not switching to on: WARP is not up. Set it again when warp-minimal answers on ${warpTarget.healthUrl}.`,
					"warning",
				);
				return;
			}
		}

		writeBridgeConfig({ warpEnabled: chosen });
		// D11: nothing stops the proxy automatically. It is shared between sessions, so
		// a session that quits cannot know whether another one is using it; the cost
		// of leaving it alive is zero, and the cost of guessing wrong is another Pi's
		// service. The only stop is an explicit act: replacing the binary.
		const stopNote =
			chosen === "off"
				? " The proxy keeps running: nothing stops it automatically, and switching back on stays instant."
				: "";
		// relay-warp-hot-reload: no relay restart. The relay re-reads the config
		// file on every request, so the new mode applies on the next request with
		// the same process (pid survives the switch).
		ctx.ui.notify(
			`WARP mode set to ${chosen} and saved to ${BRIDGE_CONFIG_PATH}. Takes effect on the next request.${stopNote}`,
			"info",
		);
	}

	/** Menu item 5: report the wire mode and switch it. */
	async function promptWireMode(ctx: MenuCtx): Promise<void> {
		const current = resolveWireMode();
		const envOverride = normalizeWireMode(process.env.RELAY_WIRE_MODE);
		const header = `pi-free-bridge wire: ${current} (config)${envOverride ? ` — env override wins: ${envOverride}` : ""}`;
		if (!(ctx.hasUI && typeof ctx.ui.select === "function")) {
			ctx.ui.notify(
				`${header}\nv1: content-type, user-agent, authorization, x-opencode-session, x-opencode-session-id\nv2: the five above, plus x-session-affinity, X-Session-Id, x-opencode-client`,
				"info",
			);
			return;
		}
		const selected = await ctx.ui.select(`🔌 Gentle wire 🪢 — modo actual: ${current}`, [
			"v1 — los cinco headers de siempre (por defecto)",
			"v2 — agrega x-session-affinity, X-Session-Id, x-opencode-client",
		]);
		if (selected === undefined) return;
		const chosen = normalizeWireMode(String(selected).slice(0, 2));
		if (!chosen) return;
		writeBridgeConfig({ wireMode: chosen });
		ctx.ui.notify(`pi-free-bridge: wire mode set to ${chosen} in ${BRIDGE_CONFIG_PATH}`, "info");
	}

	/** Menu item 1: install or update the relay binary, after an explicit yes.
	 *  This is also the only path that ever downloads one: nothing is fetched at
	 *  Pi startup, and an existing Bun keeps being used until the user asks. */
	async function installOrUpdateRelay(ctx: MenuCtx): Promise<void> {
		const installed = await runRelayInstallWithPrompt(ctx);
		if (!installed) return;

		// S3: a relay that just started is a catalog the picker may never have
		// seen. Publish it now — registration is live, so there is no restart.
		const catalog = await fetchRelayCatalog(AbortSignal.timeout(8000));
		if (catalog.models.length === 0) {
			ctx.ui.notify(
				catalog.unavailable
					? `Relay instalado, pero el catálogo no está disponible: ${catalog.unavailable}. ` +
							"El ítem «Modelos» lo reintenta sin reiniciar nada."
					: `Relay instalado. El servicio respondió sin modelos gratis (${catalog.source}).`,
				catalog.unavailable ? "error" : "warning",
			);
			return;
		}
		publishCatalog(catalog.models);
		ctx.ui.notify(
			`${PROVIDER}: ${catalog.models.length} modelos gratis registrados en vivo. ` +
				"No hace falta reiniciar Pi.",
			"info",
		);
	}

	/** Ask which menu entry to run. `select` when Pi exposes it, otherwise a
	 *  numbered confirmation chain, so the menu still works without it. */
	async function pickMenuItem(ctx: MenuCtx, labels: readonly string[]): Promise<number | undefined> {
		if (ctx.hasUI && typeof ctx.ui.select === "function") {
			const selected = await ctx.ui.select("🌉 pi-free-bridge", [...labels]);
			if (selected === undefined || selected === null) return undefined;
			const index = labels.indexOf(String(selected));
			return index === -1 ? undefined : index;
		}
		if (!ctx.hasUI) return undefined;
		for (const [index, label] of labels.entries()) {
			if (await ctx.ui.confirm("pi-free-bridge", `¿${label}?`)) return index;
		}
		return undefined;
	}

	/** The one flat menu behind `/free-bridge`. Toggles show the current state
	 *  in their label so choosing one is never a guess. */
	async function runMenu(ctx: MenuCtx): Promise<void> {
		const warpNow = resolveWarpMode();
		const wireNow = resolveWireMode();

		const state = {
			bunReady: bunReady(),
			binaryPresent: binaryPresent(),
			warpReady: warpReady(),
		};
		const visible = visibleMenuIndices(state);
		// Two levels: sector, then action. A sector whose every action is hidden is
		// not offered at all, so the menu never opens on a dead end.
		const sections = MENU_SECTIONS.map((section) => ({
			label: section.label,
			actions: sectorActions(section.actions, visible),
		})).filter((section) => section.actions.length > 0);

		const pickedSector = await pickMenuItem(
			ctx,
			sections.map((section) => section.label),
		);
		if (pickedSector === undefined) return;
		const section = sections[pickedSector];
		if (!section) return;

		// The label carries a fact, so building it may read a release. Only the
		// sector the user actually opened pays for it, and the read is cached.
		const labels: string[] = [];
		for (const index of section.actions) {
			let label: string = MENU_ITEMS[index];
			if (index === MENU_WARP) label = `${label} — ahora: ${warpNow}`;
			if (index === MENU_WIRE) label = `${label} — ahora: ${wireNow}`;
			if (index === MENU_UPDATE_WARP) {
				label = `${label}${menuUpdateSuffix({
					latestTag: await latestPublishedTag(WARP_RELEASE_API),
					currentTag: readWarpInstallRecord()?.tag ?? null,
				})}`;
			}
			if (index === MENU_INSTALL) {
				const relayHealth = await fetchRelayHealth(RELAY_PORT);
				label = `${label}${menuUpdateSuffix({
					latestTag: await latestPublishedTag(RELAY_RELEASE_API),
					currentTag: parseRelayVersion(relayHealth) ?? null,
				})}`;
			}
			labels.push(label);
		}

		const picked = await pickMenuItem(ctx, labels);
		if (picked === undefined) return;
		const index = section.actions[picked];

		switch (index) {
			case MENU_INSTALL:
				await installOrUpdateRelay(ctx);
				return;
			case MENU_STATUS:
				await showRelayStatus(ctx);
				return;
			case MENU_WARP:
				await promptWarpMode(ctx);
				return;
			case MENU_RECYCLE:
				await runWarpRecycle(ctx);
				return;
			case MENU_WIRE:
				await promptWireMode(ctx);
				return;
			case MENU_MODELS:
				showFreeModels(ctx);
				return;
			case MENU_REFRESH:
				await refreshLiveModels(ctx);
				return;
			case MENU_UPDATE_WARP:
				await runWarpUpdate(ctx);
				return;
			default:
				return;
		}
	}

	pi.registerCommand("free-bridge", {
		description: "Open the pi-free-bridge menu: relay, WARP, wire mode, models, session",
		// No arguments on purpose: the owner rejected argument forms, so there is
		// nothing here for autocomplete to hint at.
		handler: async (_args: string, ctx) => {
			await runMenu(ctx as MenuCtx);
		},
	});

	pi.registerCommand("free-bridge-warp-recycle", {
		description:
			"Rotate the WARP exit right now — manual recovery when a 429 keeps killing turns",
		handler: async (_args: string, ctx) => {
			await runWarpRecycle(ctx as MenuCtx);
		},
	});

	pi.registerCommand("free-bridge-doctor", {
		description: "Diagnose and repair why the free OpenCode models are missing from the picker",
		handler: async (_args: string, ctx) => {
			// S34: the effective id lives on the wire, so read it from the relay.
			const health = await fetchRelayHealth(RELAY_PORT);
			const warpTarget = resolveWarpTarget();
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
				`  warp target: ${describeWarpTarget(warpTarget)}`,
				`  warp health: ${warpTarget.healthUrl}`,
				`  upstream:   ${UPSTREAM_URL}`,
				// The catalog is the only source of ids now: the snapshot and the
				// config field that used to answer this are gone, so the count the
				// relay publishes is what the report can state.
				`  skipped:    ${
					discovered.skippedCount === undefined
						? "unknown (the catalog did not report a count)"
						: `${discovered.skippedCount} (not free, per the relay)`
				}`,
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
				"  not a scope problem — see the \"Relay status\" menu item.",
			);

			ctx.ui.notify(lines.join("\n"), result.status === "malformed" ? "error" : "info");
		},
	});
}

