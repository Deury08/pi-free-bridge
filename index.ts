import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
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
 *  the startup path. Refresh the snapshot with the "Refresh session" menu item, which
 *  fetches the live list and persists it to BRIDGE_CONFIG_PATH.
 *
 *  This list is what a **fresh install** registers before the user runs
 *  that menu item, so a stale entry here is a permanently broken model
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

	// A configured binary wins over Bun: it is the standalone runtime the user
	// installed on purpose. Bun stays the default, so an existing install keeps
	// behaving exactly as before.
	const configuredBin = readBridgeConfig().relayBin?.trim();
	const relayBin = configuredBin && existsSync(configuredBin) ? configuredBin : undefined;
	const bun = relayBin ? undefined : resolveBunPath();
	if (!relayBin && !bun) {
		// S27: never degrade into a silent 429.
		throw new Error(
			"pi-free-bridge: the free-tier relay needs either a downloaded binary or bun, and neither was found. " +
				"Run /free-bridge and choose \"Instalar / actualizar relay\", install Bun (https://bun.sh), " +
				"or set PI_FREE_BRIDGE_BUN to the bun executable.",
		);
	}

	const child = relayBin
		? spawn(relayBin, [], { stdio: ["pipe", "pipe", "pipe"], env: relayEnv(options) })
		: spawn(bun as string, [RELAY_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], env: relayEnv(options) });

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

/** Upstream prices are nested (`cost.text.<kind>.price`), unlike the flattened
 *  shape the OpenCode cache file used. Reading only flat numbers classifies
 *  every upstream model as paid — that is the whole reason this adapter exists:
 *  with the old reader the live catalog yields 0 free models, not 12.
 *
 *  Exported because it is the one rule that decides what the picker shows. */
export function upstreamPrice(meta: Record<string, unknown>, kind: "input" | "output"): number | undefined {
	const cost = (meta.cost ?? {}) as Record<string, any>;
	const text = (cost.text ?? {}) as Record<string, any>;
	const node = text[kind];
	if (node && typeof node.price === "number") return node.price;
	// Flat fallback: older payloads and the cache file wrote plain numbers.
	if (typeof cost[kind] === "number") return cost[kind];
	return undefined;
}

/** Turn one upstream `/models` entry into the flat shape `buildPiModels` reads.
 *  Returns undefined for anything this bridge will not offer: a paid model, an
 *  excluded id, or an entry too malformed to price honestly. Refusing is the
 *  point — a model whose cost cannot be read must not be advertised as free. */
export function normalizeUpstreamModel(entry: unknown): RegistryModel | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const meta = entry as Record<string, any>;
	const id = meta.id;
	if (typeof id !== "string" || id.length === 0 || EXCLUDED_MODELS.has(id)) return undefined;

	const input = upstreamPrice(meta, "input");
	const output = upstreamPrice(meta, "output");
	if (input === undefined || output === undefined) return undefined;
	if (input !== 0 || output !== 0) return undefined;

	const limit = (meta.limit ?? {}) as Record<string, unknown>;
	const modalities = (meta.modalities ?? {}) as Record<string, unknown>;
	const capabilities = (meta.capabilities ?? {}) as Record<string, any>;
	return {
		id,
		name: typeof meta.name === "string" && meta.name ? meta.name : id,
		meta: {
			name: meta.name,
			family: meta.family,
			reasoning: Boolean(capabilities.reasoning?.supported),
			limit: { context: limit.context, output: limit.output },
			cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
			modalities: { input: modalities.input ?? ["text"] },
		},
	};
}

/** The free catalog, read from the service itself. No OpenCode cache file and
 *  no embedded list: the machines that most need this bridge are the ones with
 *  nothing installed, and they were exactly the machines that got zero models. */
export async function fetchUpstreamCatalog(
	signal?: AbortSignal,
): Promise<{ models: RegistryModel[]; source: string; skipped: string[] }> {
	const url = `${UPSTREAM_URL}/models`;
	try {
		const res = await fetch(url, {
			headers: { "user-agent": USER_AGENT, authorization: `Bearer ${API_KEY}` },
			signal,
		});
		if (!res.ok) return { models: [], source: `${url} -> HTTP ${res.status}`, skipped: [] };
		const payload = (await res.json()) as { data?: unknown[]; models?: unknown[] };
		const models: RegistryModel[] = [];
		const skipped: string[] = [];
		for (const entry of payload.data ?? payload.models ?? []) {
			const model = normalizeUpstreamModel(entry);
			if (model) {
				models.push(model);
				continue;
			}
			const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
			if (typeof id === "string") skipped.push(id);
		}
		models.sort((a, b) => a.id.localeCompare(b.id));
		return { models, source: url, skipped };
	} catch (err) {
		return { models: [], source: `${url} unreachable: ${(err as Error).message}`, skipped: [] };
	}
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
export async function ensureWarp(): Promise<boolean> {
	const target = resolveWarpTarget();

	// (a) Probe the resolved health endpoint — if WARP answers, we are done.
	if (await probeWarp(target.healthUrl, 2)) return true;

	// (b) The target lives on another machine: nothing can be started from here,
	//     so report the miss silently and let the relay degrade per its mode.
	if (!target.isLoopback) return false;

	// (c) No health response from a local target: try to find a binary. If none
	//     exists, stay completely silent (startup must not warn or download).
	const bin = resolveWarpBin();
	if (!bin) return false;

	// (d) Spawn the binary, handing it the shared config file when it exists so
	//     both sides read the same listen address and health path.
	try {
		const installConfig = warpConfigPath();
		const args = existsSync(installConfig) ? ["-config", installConfig] : [];
		const child = spawn(bin, args, {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", () => undefined); // surface via probe failure
		child.unref();

		// (e) Probe again up to 6 attempts.
		return await probeWarp(target.healthUrl, 6);
	} catch (err) {
		// (f) Log once via warpWarned.
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

export const RELAY_RELEASE_API = "https://api.github.com/repos/Deury08/pi-free-bridge/releases/latest";
export const RELAY_INSTALL_DIR = join(homedir(), ".pi", "agent", "pi-free-bridge", "bin");

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

/** Versioned on-disk name, so an update never overwrites the binary that is
 *  currently running: rolling back is running the previous file. */
export function relayBinaryFilename(assetName: string, tag: string): string {
	const version = String(tag ?? "").trim().replace(/[^0-9A-Za-z._-]/g, "");
	if (!version) throw new Error("pi-free-bridge: a release tag is required to name an installed relay binary");
	return `${assetName}.${version}`;
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
		status?.(`Downloading ${release.asset.name} ${release.tag}…`);
		const res = await fetch(release.asset.url, {
			headers: { "user-agent": "pi-free-bridge" },
			signal: AbortSignal.timeout(120000),
		});
		if (!res.ok) {
			console.error(`pi-free-bridge: relay download failed — HTTP ${res.status}`);
			return undefined;
		}
		const bytes = Buffer.from(await res.arrayBuffer());

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

		status?.(`Installing to ${RELAY_INSTALL_DIR}…`);
		mkdirSync(RELAY_INSTALL_DIR, { recursive: true });
		const target = join(RELAY_INSTALL_DIR, relayBinaryFilename(release.asset.name, release.tag));
		// Write beside the target and rename, so an interrupted download never
		// leaves a half-written file under a name a later run would execute.
		const staging = join(tmpDir, "staged-binary");
		writeFileSync(staging, bytes);
		if (process.platform !== "win32") chmodSync(staging, 0o755);
		if (existsSync(target)) rmSync(target, { force: true });
		renameSync(staging, target);
		return target;
	} catch (err) {
		const message = `relay install failed: ${(err as Error).message}`;
		console.error(`pi-free-bridge: ${message}`);
		status?.(message);
		return undefined;
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

/** Restart the relay with whatever runtime the config now names, then confirm
 *  /health answers. Returns whether it came up. */
async function restartRelayWithConfiguredBin(): Promise<boolean> {
	const resolved = resolveSessionId();
	try {
		await stopRelay();
		await ensureRelay({
			port: RELAY_PORT,
			sessionId: resolved.sessionId,
			sessionSource: resolved.source,
			upstream: UPSTREAM_URL,
			cwd: process.cwd(),
		});
	} catch (err) {
		console.error(`pi-free-bridge: relay restart failed — ${(err as Error).message}`);
		return false;
	}
	return !!(await fetchRelayHealth(RELAY_PORT));
}

/** Guided relay install/update: the only place a binary is ever downloaded.
 *  Asks first and says that it restarts the relay, verifies the published
 *  checksum before executing anything, swaps atomically, restarts, polls
 *  /health, and rolls back to the previous runtime when the new binary does
 *  not come up. */
async function runRelayInstallWithPrompt(ctx: WarpPromptContext): Promise<boolean> {
	const previousBin = readBridgeConfig().relayBin?.trim() || undefined;
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

	const sizeMb = release.asset.size > 0 ? ` (${(release.asset.size / 1048576).toFixed(1)} MB)` : "";
	const lines = [
		`${release.asset.name} — ${release.tag}${sizeMb}`,
		"desde github.com/Deury08/pi-free-bridge",
		"",
		`Se verifica el SHA256SUMS publicado y se instala en ${RELAY_INSTALL_DIR}.`,
		"",
		previousBin
			? `Esto REINICIA el relay y reemplaza el binario anterior (${previousBin}).`
			: "Esto REINICIA el relay para que use el binario nuevo.",
	];
	if (bun) lines.push("", `Bun ya está disponible (${bun}): si decís que no, nada cambia.`);

	if (!ctx.hasUI) return false;
	if (!(await ctx.ui.confirm("pi-free-bridge: instalar / actualizar relay", lines.join("\n")))) {
		ctx.ui.notify("Sin cambios: no se descargó nada.", "info");
		return false;
	}

	const installed = await installRelayBinary(release, (message) => ctx.ui.notify(message, "info"));
	if (!installed) {
		ctx.ui.notify(
			`La instalación falló y no se cambió nada. El relay sigue como estaba${bun ? " (Bun)" : ""}.`,
			"error",
		);
		return false;
	}

	writeBridgeConfig({ relayBin: installed });
	ctx.ui.notify(`Instalado en ${installed}. Reiniciando el relay…`, "info");

	if (await restartRelayWithConfiguredBin()) {
		ctx.ui.notify(`Relay actualizado y respondiendo en ${relayHealthUrl(RELAY_PORT)}.`, "info");
		return true;
	}

	// Roll back: restore the previous runtime and restart it, so a bad download
	// never leaves the user without a working relay.
	writeBridgeConfig({ relayBin: previousBin });
	const restored = await restartRelayWithConfiguredBin();
	ctx.ui.notify(
		[
			restored
				? "El binario nuevo no respondió /health. Se volvió al anterior y el relay está arriba."
				: "El binario nuevo no respondió /health y el relay TAMPOCO volvió a levantar con el anterior.",
			`  anterior: ${previousBin ?? "Bun desde relay.mjs"}`,
			`  nuevo:    ${installed} (queda en disco, no se borra)`,
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

/** The seven menu entries, in the order the owner dictated. Never reorder. */
export const MENU_ITEMS = [
	"Instalar / actualizar relay",
	"Estado del relay",
	"WARP: on / off",
	"Reciclar WARP",
	"Cable: v1 / v2",
	"Modelos",
	"Refrescar sesión",
] as const;

/** Named menu indices, so the dispatch never depends on a bare number. */
export const MENU_INSTALL = 0;
export const MENU_STATUS = 1;
export const MENU_WARP = 2;
export const MENU_RECYCLE = 3;
export const MENU_WIRE = 4;
export const MENU_MODELS = 5;
export const MENU_REFRESH = 6;

/** Which items this machine can actually use, in the dictated order.
 *
 *  Progressive disclosure, not decoration: an item that can only fail is a
 *  trap. Nothing installed means installing is the only real action, so that
 *  is the entire menu. Recycling an exit needs a WARP binary to route through.
 *
 *  Exported so the gating is testable without a Pi runtime: this is the rule
 *  that used to be unexpressible, because the early return removed the menu
 *  before any of it could run. */
export function visibleMenuIndices(state: { relayReady: boolean; warpReady: boolean }): number[] {
	const visible: number[] = [];
	for (let index = 0; index < MENU_ITEMS.length; index++) {
		if (index !== MENU_INSTALL && !state.relayReady) continue;
		if (index === MENU_RECYCLE && !state.warpReady) continue;
		visible.push(index);
	}
	return visible;
}

export default async function (pi: ExtensionAPI) {
	const g = globalThis as Record<symbol, unknown>;
	if (g[REG_KEY]) return;

	const session = resolveSessionId();
	const live = resolveLiveIds();
	// The catalog comes from the service itself, never from the OpenCode cache
	// file: that file only exists on a machine that already has OpenCode, which
	// is the opposite of the machine this bridge is for.
	const discovered =
		process.env.PI_FREE_BRIDGE_SKIP_CATALOG === "1"
			? { models: [] as RegistryModel[], source: "catalog fetch skipped", skipped: [] as string[] }
			: await fetchUpstreamCatalog(AbortSignal.timeout(4000));

	if (process.env.PI_FREE_BRIDGE_DRY_RUN === "1") {
		printDryRun(discovered, session, live);
	}

	// Zero models is NOT a failure any more. The provider is only registered
	// when it has a catalog to publish — registering an empty list would blank
	// the provider — but the commands below must register either way. The menu
	// is most needed on a machine where nothing is set up yet, and that is
	// exactly the machine that used to lose it to an early return here.
	if (discovered.models.length === 0) {
		console.error(
			`pi-free-bridge: no free models yet (${discovered.source}); ` +
				"the provider stays unregistered until a catalog is available. " +
				"Run /free-bridge to install the relay.",
		);
	} else {
		pi.registerProvider(PROVIDER, {
			apiKey: API_KEY,
			api: API,
			baseUrl: RELAY_URL,
			authHeader: true,
			models: buildPiModels(discovered.models),
			// Pi calls this on every model refresh, so the picker follows the
			// service instead of a snapshot taken at startup. No embedded list
			// and no fallback: an unreachable catalog reports empty.
			refreshModels: async ({ signal }: { signal?: AbortSignal }) =>
				buildPiModels((await fetchUpstreamCatalog(signal)).models) as never,
			streamSimple: gateStreamSimple,
		});
	}

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

	// -----------------------------------------------------------------------
	// Command surface (spec odd/tasks/relay-download.md, S1-S3).
	//
	// Only three commands stay registered: `free-bridge` (this menu),
	// `free-bridge-warp-recycle` (for incidents) and `free-bridge-doctor`
	// (direct only, never in the menu). The other capabilities still work —
	// they are reached from the menu instead of from autocomplete, because
	// every registered command, aliases included, costs a completion entry.
	// -----------------------------------------------------------------------

	/** Is the relay runnable on this machine: an installed binary, or Bun to
	 *  run the script. This is what decides whether the menu can offer anything
	 *  beyond installing. */
	function relayReady(): boolean {
		const configured = readBridgeConfig().relayBin?.trim();
		if (configured && existsSync(configured)) return true;
		return resolveBunPath() !== undefined;
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
			`  session:    ${
				health?.sessionId
					? `${health.sessionId} (from ${health.sessionSource})`
					: "resolved at the first request by the relay"
			}`,
			`  models:     ${discovered.models.length} free from ${discovered.source}`,
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
			const catalog = await fetchUpstreamCatalog(AbortSignal.timeout(8000));
			if (catalog.models.length === 0) {
				ctx.ui.notify(
					`The service advertised no free models (${catalog.source}); keeping the current list`,
					"warning",
				);
				return;
			}
			pi.registerProvider(PROVIDER, {
				apiKey: API_KEY,
				api: API,
				baseUrl: RELAY_URL,
				authHeader: true,
				models: buildPiModels(catalog.models),
				refreshModels: async ({ signal }: { signal?: AbortSignal }) =>
					buildPiModels((await fetchUpstreamCatalog(signal)).models) as never,
				streamSimple: gateStreamSimple,
			});
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
		// relay-warp-hot-reload: no relay restart. The relay re-reads the config
		// file on every request, so the new mode applies on the next request with
		// the same process (pid survives the switch).
		ctx.ui.notify(
			`WARP mode set to ${chosen} and saved to ${BRIDGE_CONFIG_PATH}. Takes effect on the next request.`,
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
		await runRelayInstallWithPrompt(ctx);
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

		// `visible` maps a picked row back to its real menu index, so hiding an
		// item never shifts the dispatch.
		const visible = visibleMenuIndices({ relayReady: relayReady(), warpReady: warpReady() });
		const labels = visible.map((index) => {
			const item = MENU_ITEMS[index];
			if (index === MENU_WARP) return `${item} — ahora: ${warpNow}`;
			if (index === MENU_WIRE) return `${item} — ahora: ${wireNow}`;
			return item;
		});

		const picked = await pickMenuItem(ctx, labels);
		if (picked === undefined) return;
		const index = visible[picked];

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
				"  not a scope problem — see the \"Relay status\" menu item.",
			);

			ctx.ui.notify(lines.join("\n"), result.status === "malformed" ? "error" : "info");
		},
	});
}