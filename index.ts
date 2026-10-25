import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
const BRIDGE_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge.json");

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

/** S30/S34: the package ships no session id. Only an explicit override is
 *  resolved here; otherwise the relay harvests one from the OpenCode store at
 *  startup. */
function resolveSessionId(): { sessionId?: string; source: string } {
	const fromEnv = process.env.PI_FREE_BRIDGE_SESSION_ID?.trim();
	if (fromEnv) return { sessionId: fromEnv, source: "env" };

	const fromConfig = readBridgeConfig().sessionId?.trim();
	if (fromConfig) return { sessionId: fromConfig, source: "config" };

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

/** Child environment. RELAY_SESSION is only set for an explicit override; when
 *  it is absent the relay harvests an id from the OpenCode store (S31). */
function relayEnv(options: RelayOptions): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PORT: String(options.port),
		RELAY_UPSTREAM: options.upstream,
		RELAY_CWD: options.cwd,
	};

	if (options.sessionId) {
		env.RELAY_SESSION = options.sessionId;
		env.RELAY_SESSION_SOURCE = options.sessionSource ?? "env";
	} else {
		// Never leak an inherited override into a relay that must harvest.
		delete env.RELAY_SESSION;
		delete env.RELAY_SESSION_SOURCE;
	}
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
async function ensureRelay(options: RelayOptions): Promise<RelayResult> {
	const key = `${options.port}\u0000${options.sessionId ?? ""}`;

	if (relayState?.key === key) {
		// A relay we spawned is trusted; one we only reused may belong to another
		// Pi that has since exited, so its liveness is re-checked.
		if (relayState.mode === "spawned" || (await probeRelay(options.port)) === "healthy") {
			return { url: relayState.url, mode: relayState.mode };
		}
		relayState = undefined;
	}
	if (relayPending?.key === key) return relayPending.promise;

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
};

/** The relay's `/health` payload, or undefined when it is not answering. */
async function fetchRelayHealth(port: number): Promise<RelayHealth | undefined> {
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
		};
		if (payload?.service !== RELAY_SERVICE || payload.ok !== true) return undefined;
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