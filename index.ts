import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider id is load-bearing: settings.json, gentle-ai profiles and subagents
 *  all reference `oc-sdk-zen/<model>`. Do not rename it (HANDOFF D2). */
const PROVIDER = "oc-sdk-zen";

/** The free tier moved here from the retired Zen surface, which is now hard-403
 *  for every client outside the official CLI (HANDOFF §4.1).
 *
 *  This is the upstream bridge-go calls. Pi points at the local bridge-go
 *  server instead (GATE-DIAGNOSIS.md §3.1, §5). bridge-go is a Go-native
 *  replacement for the Bun relay: it emulates Bun's TLS ClientHello (uTLS),
 *  injects the gate-mandated headers, session id, `<env>` block and tools on
 *  the wire. */
const UPSTREAM_URL = "https://opencode.ai/inference/v1";
const API = "openai-completions" as const;

/** The free tier needs no API key: any bearer value passes, and the literal
 *  "public" keeps credentials out of the repo and out of auth.json. */
const API_KEY = "public";

/** User-agent must contain "opencode/" or the gate answers 403 (HANDOFF §4.2).
 *  bridge-go sends its own copy; this one stays for the registry refresh. */
const USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

const REGISTRY_PATHS = [
	join(homedir(), ".cache", "opencode", "models.json"),
	join(homedir(), ".config", "opencode", "models.json"),
];

/** Optional user config: `{ "sessionId": "ses_…", "liveIds": ["…"] }`. */
const BRIDGE_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge.json");

/** Pi's global settings. Pi scopes the model picker to `enabledModels`, so a
 *  non-empty list means "show ONLY these" — see ensureEnabledPattern. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** The scope entry the bridge needs. A glob, not literal ids: the bridge
 *  registers `oc-sdk-zen/*` at runtime, so literal ids hide anything new. */
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
	autoUpdate?: boolean;
	lastUpdateCheck?: number;
	lastKnownVersion?: string;
	/** Proxy failover pool (odd/tasks/proxy-failover.md S6). */
	proxy?: {
		static?: string[];
		source?: string;
		refreshMinutes?: number;
		/** S12: prefer the pool even when the direct path still works. */
		force?: boolean;
	};
};

function readBridgeConfig(): BridgeConfig {
	if (!existsSync(BRIDGE_CONFIG_PATH)) return {};
	try {
		const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf-8"));
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

/** Harvest the most recent OpenCode session id from
 *  ~/.local/share/opencode/storage/session_diff/ses_*.json (by mtime). */
function harvestSessionId(): string | undefined {
	const diffDir = join(homedir(), ".local", "share", "opencode", "storage", "session_diff");
	if (!existsSync(diffDir)) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(diffDir);
	} catch {
		return undefined;
	}
	let newestId: string | undefined;
	let newestMtime = 0;
	for (const name of entries) {
		if (!name.startsWith("ses_") || !name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		let mtime: number;
		try {
			mtime = statSync(join(diffDir, name)).mtimeMs;
		} catch {
			continue;
		}
		if (newestId === undefined || mtime > newestMtime) {
			newestId = id;
			newestMtime = mtime;
		}
	}
	return newestId;
}

/** S30/S34: the package ships no session id. Only an explicit override is
 *  resolved here; otherwise bridge-go harvests one from the OpenCode store at
 *  startup. */
function resolveSessionId(): { sessionId?: string; source: string } {
	const fromEnv = process.env.PI_FREE_BRIDGE_SESSION_ID?.trim();
	if (fromEnv) return { sessionId: fromEnv, source: "env" };

	const fromConfig = readBridgeConfig().sessionId?.trim();
	if (fromConfig) return { sessionId: fromConfig, source: "config" };

	const harvested = harvestSessionId();
	if (harvested) return { sessionId: harvested, source: "harvested" };

	return { source: "none" };
}

function resolveLiveIds(): { liveIds: Set<string>; source: string } {
	const fromConfig = readBridgeConfig().liveIds;
	if (Array.isArray(fromConfig) && fromConfig.length > 0) {
		return { liveIds: new Set(fromConfig), source: BRIDGE_CONFIG_PATH };
	}
	return { liveIds: new Set(SNAPSHOT_LIVE_FREE_IDS), source: "built-in snapshot (2026-10-14)" };
}

// ---------------------------------------------------------------------------
// bridge-go supervisor
// ---------------------------------------------------------------------------
//
// bridge-go is a Go-native replacement for the Bun relay. It runs as a
// standalone HTTP server on loopback and owns all gate injection (headers,
// session id, `<env>` block, tools gate, Bun TLS fingerprint via uTLS).
//
// The extension does NOT spawn bridge-go: the user (or postinstall) starts it
// separately. The extension only probes its /health endpoint to report a clear
// error if it isn't running.

const PACKAGE_VERSION = "0.1.0";

const BRIDGE_GO_DEFAULT_PORT = 8790;
const BRIDGE_GO_HOST = "127.0.0.1";
const BRIDGE_GO_SERVICE = "pi-free-bridge";

/** The bridge-go binary ships next to this file (see `package.json → files`). */
const BRIDGE_GO_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "bridge-go", "pi-free-bridge");

/** How long bridge-go may take to print its listening line. */
const BRIDGE_GO_START_TIMEOUT_MS = 5000;

type BridgeGoMode = "spawned" | "reused";

type BridgeGoOptions = {
	port: number;
	/** Only an explicit user override; when absent bridge-go harvests one. */
	sessionId?: string;
	sessionSource?: string;
	upstream: string;
	cwd: string;
	/** Proxy pool for the egress failover (S6). Explicit env wins over config. */
	proxy?: {
		static?: string[];
		source?: string;
		refreshMinutes?: number;
		force?: boolean;
	};
};

type BridgeGoResult = {
	url: string;
	mode: BridgeGoMode;
};

type BridgeGoState = BridgeGoResult & {
	key: string;
	child?: ChildProcess;
};

let bridgeGoState: BridgeGoState | undefined;
let bridgeGoPending: { key: string; promise: Promise<BridgeGoResult> } | undefined;

function parsePort(value: unknown): number | undefined {
	const port = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** S26: env override, then the persisted config key, then the default. */
function resolveBridgeGoPort(): number {
	return (
		parsePort(process.env.PI_FREE_BRIDGE_BRIDGE_GO_PORT) ??
		parsePort(readBridgeConfig().relayPort) ??
		BRIDGE_GO_DEFAULT_PORT
	);
}

function bridgeGoUrl(port: number): string {
	return `http://${BRIDGE_GO_HOST}:${port}/v1`;
}

function bridgeGoHealthUrl(port: number): string {
	return `http://${BRIDGE_GO_HOST}:${port}/health`;
}

/** Detect OS and arch for download. */
function detectPlatform(): { os: string; arch: string } {
	const osMap: Record<string, string> = { win32: "windows", linux: "linux", darwin: "darwin" };
	const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
	return { os: osMap[process.platform] ?? process.platform, arch: archMap[process.arch] ?? process.arch };
}

/** Resolve the persistent binary directory. */
function binaryDir(): string {
	return join(homedir(), ".pi", "agent", "pi-free-bridge", "bin");
}

/** Resolve the bridge-go binary path (preferred persistent location first). */
function resolveBinaryPath(): string | undefined {
	const binary = process.platform === "win32" ? "pi-free-bridge.exe" : "pi-free-bridge";
	const persistent = join(binaryDir(), binary);
	if (existsSync(persistent)) return persistent;

	const moduleBin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", binary);
	if (existsSync(moduleBin)) return moduleBin;

	const localBin = join(dirname(fileURLToPath(import.meta.url)), "bridge-go", binary);
	if (existsSync(localBin)) return localBin;

	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const directory = entry.replace(/^"|"$/g, "");
		if (!directory) continue;
		const candidate = join(directory, binary);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Resolve the bridge-go binary: PI_FREE_BRIDGE_BINARY, then resolveBinaryPath. */
function resolveBridgeGoBin(): string | undefined {
	const override = process.env.PI_FREE_BRIDGE_BINARY?.trim();
	if (override && existsSync(override)) return override;
	return resolveBinaryPath();
}

/** Get binary version by running --version. */
function getBinaryVersion(binaryPath: string): string | undefined {
	try {
		const out = execFileSync(binaryPath, ["--version"], { encoding: "utf-8", timeout: 5000 });
		const m = out.match(/v[0-9]+\.[0-9]+\.[0-9]+/);
		return m ? m[0] : out.trim();
	} catch {
		return undefined;
	}
}

/** Download binary from GitHub Releases. */
async function downloadBinary(targetPath: string, version: string, ctx?: any): Promise<void> {
	const { os, arch } = detectPlatform();
	const platformKey = `${os}_${arch}`;
	const ext = process.platform === "win32" ? "zip" : "tar.gz";
	const assetName = `pi-free-bridge_v${version}_${platformKey}.${ext}`;
	const url = `https://github.com/Deury08/pi-free-bridge/releases/download/v${version}/${assetName}`;
	const dir = dirname(targetPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const archivePath = join(dir, assetName);

	ctx?.ui?.notify?.(`Downloading pi-free-bridge ${version}...`, "info");

	await new Promise<void>((resolve, reject) => {
		https.get(url, (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode}: ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			let total = 0;
			const LIMIT = 50 * 1024 * 1024;
			res.on("data", (c: Buffer) => {
				total += c.length;
				if (total > LIMIT) {
					reject(new Error("Downloaded archive exceeds 50 MB"));
					res.destroy();
					return;
				}
				chunks.push(c);
			});
			res.on("end", () => {
				if (total <= LIMIT) {
					writeFileSync(archivePath, Buffer.concat(chunks));
					resolve();
				}
			});
		}).on("error", reject);
	});

	// extract
	if (ext === "zip") {
		execFileSync("powershell", ["-Command", "Expand-Archive", "-Path", archivePath, "-DestinationPath", dir, "-Force"], { stdio: "inherit" });
	} else {
		execFileSync("tar", ["-xzf", archivePath, "-C", dir], { stdio: "inherit" });
	}

	// move binary if needed
	const extracted = join(dir, process.platform === "win32" ? "pi-free-bridge.exe" : "pi-free-bridge");
	if (extracted !== targetPath && existsSync(extracted)) {
		// rename
		const fs = await import("node:fs");
		fs.renameSync(extracted, targetPath);
	}
	if (process.platform !== "win32") chmodSync(targetPath, 0o755);
	try { unlinkSync(archivePath); } catch {}
	ctx?.ui?.notify?.(`pi-free-bridge ${version} installed to ${targetPath}`, "info");
}

/** Ensure binary exists, downloading on demand. */
async function ensureBinary(pi?: any, ctx?: any): Promise<string> {
	let path = resolveBinaryPath();
	const version = PACKAGE_VERSION;
	if (path) {
		const v = getBinaryVersion(path);
		if (v && v.includes(version)) return path;
		const ok = await ctx.ui.confirm?.(`Update pi-free-bridge? (current ${v ?? "unknown"}, target v${version})`);
		if (!ok) return path;
	}
	const targetPath = join(binaryDir(), process.platform === "win32" ? "pi-free-bridge.exe" : "pi-free-bridge");
	await downloadBinary(targetPath, version, ctx);
	return targetPath;
}

/** Update ensureBridgeGo to use ensureBinary before spawn is handled in startBridgeGo */

function isAutoUpdateEnabled(cfg: BridgeConfig): boolean {
	if (cfg.autoUpdate === true) return true;
	if (process.env.PI_FREE_BRIDGE_AUTO_UPDATE === "1") return true;
	return false;
}

async function checkForUpdate(ctx?: any): Promise<{ available: boolean; version?: string }> {
	const cfg = readBridgeConfig();
	if (!isAutoUpdateEnabled(cfg)) return { available: false };
	const now = Date.now();
	const last = cfg.lastUpdateCheck ?? 0;
	if (now - last < 86400 * 1000) return { available: false };
	try {
		const res = await new Promise<any>((resolve, reject) => {
			https.get("https://api.github.com/repos/Deury08/pi-free-bridge/releases/latest", { headers: { "User-Agent": "pi-free-bridge" } }, (r) => {
				let data = "";
				r.on("data", (c) => (data += c));
				r.on("end", () => {
					try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
				});
			}).on("error", reject);
		});
		const tag = res?.tag_name;
		if (!tag || tag === `v${PACKAGE_VERSION}`) {
			writeBridgeConfig({ lastUpdateCheck: now });
			return { available: false };
		}
		writeBridgeConfig({ lastUpdateCheck: now });
		return { available: true, version: tag.replace(/^v/, "") };
	} catch {
		return { available: false };
	}
}

async function doUpdate(ctx: any, version: string): Promise<void> {
	const tag = version.startsWith("v") ? version : `v${version}`;
	const ok = await ctx.ui.confirm(`Nueva versión disponible (${tag}). ¿Actualizar?`);
	if (!ok) {
		writeBridgeConfig({ lastUpdateCheck: Date.now() });
		ctx.ui.notify("Actualización cancelada.", "info");
		return;
	}
	const targetPath = join(binaryDir(), process.platform === "win32" ? "pi-free-bridge.exe" : "pi-free-bridge");
	await downloadBinary(targetPath, tag.replace(/^v/, ""), ctx);
	writeBridgeConfig({ lastKnownVersion: tag });
	ctx.ui.notify("Actualizado. Reiniciá Pi.", "info");
}

function describeBridgeGoBin(): string {
	const path = resolveBridgeGoBin();
	if (!path) return "MISSING — run `npm install` or build from bridge-go/";
	const rel = path.includes("node_modules") ? "installed" : "from PATH";
	return `${path} (${rel})`;
}

/** Probe a port for our own bridge-go. `absent` means nothing is listening there. */
async function probeBridgeGo(port: number): Promise<"healthy" | "foreign" | "absent"> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 750);
	try {
		const res = await fetch(bridgeGoHealthUrl(port), { signal: controller.signal });
		if (!res.ok) return "foreign";
		const payload = (await res.json()) as { service?: unknown };
		return payload?.service === BRIDGE_GO_SERVICE ? "healthy" : "foreign";
	} catch {
		return "absent";
	} finally {
		clearTimeout(timer);
	}
}

function waitForBridgeGoListening(child: ChildProcess, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const expected = `pi-free-bridge listening on ${BRIDGE_GO_HOST}:${port}`;
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
				`pi-free-bridge: bridge-go did not start within ${BRIDGE_GO_START_TIMEOUT_MS / 1000}s` +
					(stderr.trim() ? ` — ${stderr.trim()}` : ""),
			);
		}, BRIDGE_GO_START_TIMEOUT_MS);

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
				`pi-free-bridge: bridge-go exited before listening (code ${code})` +
					(stderr.trim() ? ` — ${stderr.trim()}` : ""),
			);
		};
		const onError = (err: Error) => {
			fail(`pi-free-bridge: could not start bridge-go — ${err.message}`);
		};

		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.on("exit", onExit);
		child.on("error", onError);
	});
}

/** Kill the child when Pi exits. Signals are handled only when no one else owns
 *  them, so Pi's own Ctrl+C handling keeps working. */
function installBridgeGoExitHooks(child: ChildProcess): void {
	const kill = () => {
		if (!child.killed) child.kill();
	};

	process.once("exit", kill);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			kill();
			if (process.listenerCount(signal) === 0) {
				process.exit(signal === "SIGINT" ? 130 : 143);
			}
		});
	}
}

/** A piped child keeps the parent's event loop alive. bridge-go is a helper,
 *  not a reason for Pi to stay running, so its handles are detached once it is
 *  up; the exit hooks above still take it down. */
function detachBridgeGoHandles(child: ChildProcess): void {
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		(stream as unknown as { unref?: () => void } | null)?.unref?.();
	}
	child.unref();
}

/** Child environment. BRIDGE_GO_SESSION is only set for an explicit override;
 *  when it is absent bridge-go harvests an id from the OpenCode store (S31). */
function bridgeGoEnv(options: BridgeGoOptions): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PORT: String(options.port),
		UPSTREAM: options.upstream,
		CWD: options.cwd,
	};

	const proxy = options.proxy;
	if (proxy) {
		if (Array.isArray(proxy.static) && proxy.static.length > 0) {
			env.WARP_PROXY_STATIC = proxy.static.join(",");
		}
		if (proxy.source) env.WARP_PROXY_SOURCE = proxy.source;
		if (typeof proxy.refreshMinutes === "number" && proxy.refreshMinutes > 0) {
			env.WARP_PROXY_REFRESH_MINUTES = String(proxy.refreshMinutes);
		}
		if (proxy.force === true) env.WARP_PROXY_FORCE = "1";
	}

	if (options.sessionId) {
		env.BRIDGE_GO_SESSION = options.sessionId;
		env.BRIDGE_GO_SESSION_SOURCE = options.sessionSource ?? "env";
		// Pass harvested id via the env var bridge-go reads as priority 1.
		env.PI_FREE_BRIDGE_SESSION_ID = options.sessionId;
	} else {
		delete env.BRIDGE_GO_SESSION;
		delete env.BRIDGE_GO_SESSION_SOURCE;
	}
	return env;
}

async function startBridgeGo(options: BridgeGoOptions, key: string): Promise<BridgeGoState> {
	const url = bridgeGoUrl(options.port);
	const probe = await probeBridgeGo(options.port);

	if (probe === "healthy") {
		return { key, url, mode: "reused" };
	}
	if (probe === "foreign") {
		throw new Error(
			`pi-free-bridge: port ${options.port} is already used by another service; ` +
				`set PI_FREE_BRIDGE_BRIDGE_GO_PORT (or "relayPort" in ${BRIDGE_CONFIG_PATH}) to a free port.`,
		);
	}

	const bin = (await ensureBinary().catch(() => undefined)) ?? resolveBridgeGoBin();
	if (!bin) {
		throw new Error(
			"pi-free-bridge: bridge-go binary not found. " +
				"Run `npm install` (postinstall downloads it) or build from bridge-go/, " +
				"or set PI_FREE_BRIDGE_BINARY to the bridge-go executable.",
		);
	}

	const child = spawn(bin, ["-config", "config.json"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: bridgeGoEnv(options),
		cwd: join(dirname(fileURLToPath(import.meta.url)), "bridge-go"),
	});

	try {
		await waitForBridgeGoListening(child, options.port);
		child.stdout?.resume();
		child.stderr?.resume();

		if ((await probeBridgeGo(options.port)) !== "healthy") {
			throw new Error(`pi-free-bridge: bridge-go started but did not answer /health on ${url}`);
		}
	} catch (err) {
		if (!child.killed) child.kill();
		throw err;
	}

	installBridgeGoExitHooks(child);
	detachBridgeGoHandles(child);

	child.once("exit", () => {
		if (bridgeGoState?.child === child) bridgeGoState = undefined;
	});

	return { key, url, mode: "spawned", child };
}

function bridgeGoProxyOptions(): BridgeGoOptions["proxy"] {
	const proxy = readBridgeConfig().proxy;
	if (!proxy || typeof proxy !== "object") return undefined;

	const staticPool = Array.isArray(proxy.static)
		? proxy.static.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		: undefined;
	const source = typeof proxy.source === "string" && proxy.source.trim() !== "" ? proxy.source.trim() : undefined;
	const refreshMinutes =
		typeof proxy.refreshMinutes === "number" && proxy.refreshMinutes > 0 ? proxy.refreshMinutes : undefined;
	const force = proxy.force === true;

	if (!staticPool?.length && !source) return undefined;
	return { static: staticPool, source, refreshMinutes, force };
}

async function ensureBridgeGo(options: BridgeGoOptions): Promise<BridgeGoResult> {
	const proxyKey = options.proxy
		? JSON.stringify([
				options.proxy.static ?? [],
				options.proxy.source ?? "",
				options.proxy.refreshMinutes ?? 0,
				options.proxy.force === true,
			])
		: "";
	const key = `${options.port}\u0000${options.sessionId ?? ""}\u0000${proxyKey}`;

	if (bridgeGoState?.key === key) {
		if (bridgeGoState.mode === "spawned" || (await probeBridgeGo(options.port)) === "healthy") {
			return { url: bridgeGoState.url, mode: bridgeGoState.mode };
		}
		bridgeGoState = undefined;
	}
	if (bridgeGoPending?.key === key) return bridgeGoPending.promise;

	const promise = startBridgeGo(options, key)
		.then((state) => {
			bridgeGoState = state;
			return { url: state.url, mode: state.mode };
		})
		.finally(() => {
			if (bridgeGoPending?.promise === promise) bridgeGoPending = undefined;
		});

	bridgeGoPending = { key, promise };
	return promise;
}

async function stopBridgeGo(): Promise<void> {
	const state = bridgeGoState;
	bridgeGoState = undefined;
	bridgeGoPending = undefined;

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

const BRIDGE_GO_PORT = resolveBridgeGoPort();
const BRIDGE_GO_URL = bridgeGoUrl(BRIDGE_GO_PORT);

/** S29: one line for `/free-bridge-doctor`. */
function describeBridgeGoProcess(): string {
	if (!bridgeGoState) return "not started";
	return bridgeGoState.mode === "spawned"
		? `running on ${bridgeGoState.url} (spawned)`
		: `reused on ${bridgeGoState.url}`;
}

type BridgeGoHealth = {
	sessionId?: string;
	sessionSource?: string;
};

/** bridge-go's `/health` payload, or undefined when it is not answering. */
async function fetchBridgeGoHealth(port: number): Promise<BridgeGoHealth | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 750);
	try {
		const res = await fetch(bridgeGoHealthUrl(port), { signal: controller.signal });
		if (!res.ok) return undefined;
		const payload = (await res.json()) as {
			service?: unknown;
			ok?: unknown;
			sessionId?: unknown;
			sessionSource?: unknown;
		};
		if (payload?.service !== BRIDGE_GO_SERVICE || payload.ok !== true) return undefined;
		return {
			sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
			sessionSource: typeof payload.sessionSource === "string" ? payload.sessionSource : undefined,
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
		if (!liveIds.has(id)) {
			skipped.push(id);
			continue;
		}
		models.push({ id, name: (meta.name as string) || id, meta });
	}

	models.sort((a, b) => a.id.localeCompare(b.id));
	return { models, source: path, skipped };
}

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

		const declaredInput = (modalities.input ?? ["text"]).filter(
			(x) => x === "text" || x === "image",
		);

		const model: Record<string, unknown> = {
			id: m.id,
			name: m.name,
			api: API,
			provider: PROVIDER,
			baseUrl: BRIDGE_GO_URL,
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
// bridge-go owns all gate mutation on the wire (headers, session, `<env>`,
// tools). The Pi path is a pass-through: `gateStreamSimple` delegates to
// pi-ai's compat.streamSimple with baseUrl pointing at bridge-go.
// `gateRequestContext` is kept as the context-level reference implementation
// that `test/gate-tools.mjs` exercises.

const GATE_TOOL_NAMES = ["read", "bash"];

type GateTool = {
	name: string;
	description: string;
	parameters: { type: "object"; properties: Record<string, never> };
};

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
	toolChoice?: "none";
};

function resolveToolNames(messages: GateMessage[]): Set<string> {
	const tools = new Map<string, { name: string }>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
	}
	return new Set(tools.keys());
}

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
 *  Pi routes every request for this provider through the provider's
 *  `streamSimple`. bridge-go (reached at BRIDGE_GO_URL) owns every mutation
 *  the gate requires (headers, session, `<env>`, tools, Bun TLS fingerprint).
 *  The context is passed through untouched; the only job here is to delegate
 *  to pi-ai's compat.streamSimple. */
const gateStreamSimple = (async (
	model: unknown,
	context: GateContext,
	options?: Record<string, unknown>,
) => {
	// Ensure bridge-go is running before the first request. Pi's provider
	// composer runs this handler behind lazyStream, which awaits the result
	// before forwarding events, so starting bridge-go asynchronously is safe.
	try {
		const session = resolveSessionId();
		await ensureBridgeGo({
			port: BRIDGE_GO_PORT,
			sessionId: session.sessionId,
			sessionSource: session.source,
			upstream: UPSTREAM_URL,
			cwd: process.cwd(),
			proxy: bridgeGoProxyOptions(),
		});
	} catch (err) {
		console.error(`pi-free-bridge: bridge-go not ready — ${(err as Error).message}`);
		throw err;
	}

	const compat = await loadCompat();
	if (!compat) {
		throw new Error(
			`pi-free-bridge: cannot load ${COMPAT_MODULE}; the free-tier gate cannot be satisfied.`,
		);
	}

	return compat.streamSimple(model, context, options);
}) as unknown as ProviderConfig["streamSimple"];

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
		`  registry:   ${discovered.source}`,
		`  upstream:   ${UPSTREAM_URL}`,
		`  bridge-go:  ${BRIDGE_GO_URL} (port ${BRIDGE_GO_PORT})`,
		`  bridge-go bin: ${describeBridgeGoBin()}`,
		`  api:        ${API}   apiKey: ${API_KEY}`,
		`  session id: ${
			session.sessionId
				? `${session.sessionId} (from ${session.source})`
				: "harvested by bridge-go from the OpenCode store"
		}`,
		`  live ids:   ${live.source}`,
		`  excluded:   ${[...EXCLUDED_MODELS].join(", ")}`,
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
		console.error(
			`pi-free-bridge: no free models discovered (${discovered.source}); ` +
				"provider not registered.",
		);
		return;
	}

	pi.registerProvider(PROVIDER, {
		apiKey: API_KEY,
		api: API,
		baseUrl: BRIDGE_GO_URL,
		authHeader: true,
		models: buildPiModels(discovered.models),
		streamSimple: gateStreamSimple,
	});

	g[REG_KEY] = true;

	// Start bridge-go early so the first request does not pay the spawn cost.
	// A failure is reported once and retried by gateStreamSimple on the first
	// real request; it must never take Pi down at startup.
	if (process.env.PI_FREE_BRIDGE_DRY_RUN !== "1") {
		void ensureBridgeGo({
			port: BRIDGE_GO_PORT,
			sessionId: session.sessionId,
			sessionSource: session.source,
			upstream: UPSTREAM_URL,
			cwd: process.cwd(),
			proxy: bridgeGoProxyOptions(),
		}).catch((err) => {
			console.error(`pi-free-bridge: bridge-go not ready — ${(err as Error).message}`);
		});
	}

	// Keep the picker able to see the models this bridge just registered.
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
				const health = await fetchBridgeGoHealth(BRIDGE_GO_PORT);
				ctx.ui.notify(
					health?.sessionId
						? `pi-free-bridge session: ${health.sessionId} (from ${health.sessionSource})`
						: "pi-free-bridge session: resolved by bridge-go — " +
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

			ctx.ui.notify(
				`${persisted
					? `Session id set to ${next} and saved to ${BRIDGE_CONFIG_PATH}`
					: `Session id set to ${next} for this session only (could not write ${BRIDGE_CONFIG_PATH})`}`,
				persisted ? "info" : "warning",
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
					baseUrl: BRIDGE_GO_URL,
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

	pi.registerCommand("free-bridge-proxy", {
		description: "Test bridge-go connectivity: reachability, latency",
		handler: async (_args: string, ctx) => {
			const lines = ["pi-free-bridge proxy (bridge-go)"];
			const start = Date.now();
			const health = await fetchBridgeGoHealth(BRIDGE_GO_PORT);
			const latency = Date.now() - start;
			if (!health) {
				lines.push(`  bridge-go: DEAD — could not reach http://${BRIDGE_GO_HOST}:${BRIDGE_GO_PORT}/health`);
				ctx.ui.notify(lines.join("\n"), "error");
				return;
			}
			lines.push(`  bridge-go: ok (HTTP 200, ${latency} ms)`);
			lines.push(`  service:   ${health.sessionId ? "bridge-go" : "unknown"}`);
			lines.push(`  session:   ${health.sessionId ?? "MISSING"}`);
			lines.push(`  source:    ${health.sessionSource ?? "unknown"}`);
			lines.push(`  url:       ${BRIDGE_GO_URL}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("free-bridge-doctor", {
		description: "Diagnose and repair why the free OpenCode models are missing from the picker",
		handler: async (_args: string, ctx) => {
			const health = await fetchBridgeGoHealth(BRIDGE_GO_PORT);
			const lines = [
				"pi-free-bridge doctor",
				`  provider:     ${PROVIDER}`,
				`  registered:   ${discovered.models.length} free models from ${discovered.source}`,
				`  session id:   ${
					health?.sessionId
						? `${health.sessionId} (from ${health.sessionSource})`
						: "MISSING — run OpenCode once, or set PI_FREE_BRIDGE_SESSION_ID"
				}`,
				`  bridge-go bin: ${describeBridgeGoBin()}`,
				`  bridge-go port: ${BRIDGE_GO_PORT}`,
				`  bridge-go:    ${describeBridgeGoProcess()}`,
				`  upstream:     ${UPSTREAM_URL}`,
				`  live ids:     ${live.source}`,
				`  skipped:      ${discovered.skipped.length ? discovered.skipped.join(", ") : "none"}`,
				`  auto-update:  ${readBridgeConfig().autoUpdate === true ? "ON" : "OFF"}`,
			];

			const result = repairEnabledModels();
			if (result.status === "unchanged") {
				lines.push(`  scope:      ok — "${SCOPE_PATTERN}" is in enabledModels`);
			} else if (result.status === "added") {
				lines.push(
					`  scope:      repaired — appended "${SCOPE_PATTERN}" to enabledModels ` +
						`(${result.previousCount} -> ${scope.previousCount + 1} entries)`,
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

	pi.registerCommand("free-bridge-update", {
		description: "Check and install the latest pi-free-bridge release",
		handler: async (_args: string, ctx) => {
			const r = await checkForUpdate(ctx);
			// force: bypass interval by reading config and re-checking manually
			const cfg = readBridgeConfig();
			const forced = await (async () => {
				try {
					const res = await new Promise<any>((resolve, reject) => {
						https.get("https://api.github.com/repos/Deury08/pi-free-bridge/releases/latest", { headers: { "User-Agent": "pi-free-bridge" } }, (r2) => {
							let data = "";
							r2.on("data", (c) => (data += c));
							r2.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
						}).on("error", reject);
					});
					const tag = res?.tag_name;
					if (!tag || tag === `v${PACKAGE_VERSION}`) return { available: false };
					return { available: true, version: tag.replace(/^v/, "") };
				} catch {
					return { available: false };
				}
			})();
			if (!forced.available) {
				ctx.ui.notify(`Ya tenés la última versión (v${PACKAGE_VERSION})`, "info");
				return;
			}
			await doUpdate(ctx, forced.version!);
		},
	});

	pi.registerCommand("free-bridge-auto-update", {
		description: "Toggle auto-update checks",
		handler: async (_args: string, ctx) => {
			const cfg = readBridgeConfig();
			const current = cfg.autoUpdate === true ? "ON" : "OFF";
			ctx.ui.notify(`Auto-update: ${current}`, "info");
			const choice = await ctx.ui.confirm("Activar auto-update?");
			// simplified: confirm true=activar, false=desactivar
			const next = choice ? true : false;
			writeBridgeConfig({ autoUpdate: next });
			ctx.ui.notify(`Auto-update: ${next ? "ON" : "OFF"}`, "info");
		},
	});

	// background check
	if (readBridgeConfig().autoUpdate === true || process.env.PI_FREE_BRIDGE_AUTO_UPDATE === "1") {
		void checkForUpdate().then((r) => {
			if (r.available && r.version) {
				console.error(`pi-free-bridge: nueva versión disponible ${r.version}. Ejecutá /free-bridge-update`);
			}
		});
	}
}
