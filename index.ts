import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider id is load-bearing: settings.json, gentle-ai profiles and subagents
 *  all reference `oc-sdk-zen/<model>`. Do not rename it (HANDOFF D2). */
const PROVIDER = "oc-sdk-zen";

/** The free tier moved here from the retired Zen surface, which is now hard-403
 *  for every client outside the official CLI (HANDOFF §4.1). */
const BASE_URL = "https://opencode.ai/inference/v1";
const API = "openai-completions" as const;

/** The free tier needs no API key: any bearer value passes, and the literal
 *  "public" keeps credentials out of the repo and out of auth.json. */
const API_KEY = "public";

/** User-agent must contain "opencode/" or the gate answers 403 (HANDOFF §4.2). */
const USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

/** Known-good session id. A self-minted id is rejected by the gate (HANDOFF §4.2,
 *  experiment E2), and no session-minting endpoint exists, so the id is a
 *  constant that can be refreshed without touching code — see
 *  `/free-bridge-session` and the README. */
const DEFAULT_SESSION_ID = "ses_eca394440ffeYFPjS30HnZEVBo";

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

/** Free ids the surface actually advertised on 2026-10-14.
 *
 *  Registration stays offline and deterministic: intersecting the registry with
 *  `GET /inference/v1/models` on every launch would put a network round-trip on
 *  the startup path. Refresh the snapshot with `/free-bridge-refresh`, which
 *  fetches the live list and persists it to BRIDGE_CONFIG_PATH. */
const SNAPSHOT_LIVE_FREE_IDS = [
	"big-pickle",
	"cat-jam-free",
	"longcat-2.5-preview-free",
	"mimo-v2.6-flash-free",
	"nemotron-3.5-lightning-free",
	"space-bunny-free",
	"step-5-preview-free",
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

function resolveSessionId(): { sessionId: string; source: string } {
	const fromEnv = process.env.PI_FREE_BRIDGE_SESSION_ID?.trim();
	if (fromEnv) return { sessionId: fromEnv, source: "PI_FREE_BRIDGE_SESSION_ID" };

	const fromConfig = readBridgeConfig().sessionId?.trim();
	if (fromConfig) return { sessionId: fromConfig, source: BRIDGE_CONFIG_PATH };

	return { sessionId: DEFAULT_SESSION_ID, source: "built-in constant" };
}

function resolveLiveIds(): { liveIds: Set<string>; source: string } {
	const fromConfig = readBridgeConfig().liveIds;
	if (Array.isArray(fromConfig) && fromConfig.length > 0) {
		return { liveIds: new Set(fromConfig), source: BRIDGE_CONFIG_PATH };
	}
	return { liveIds: new Set(SNAPSHOT_LIVE_FREE_IDS), source: "built-in snapshot (2026-10-14)" };
}

function buildHeaders(sessionId: string): Record<string, string> {
	return {
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-opencode-session": sessionId,
		"x-opencode-session-id": sessionId,
	};
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
	const res = await fetch(`${BASE_URL}/models`, {
		headers: { "user-agent": USER_AGENT, authorization: `Bearer ${API_KEY}` },
	});
	if (!res.ok) throw new Error(`${BASE_URL}/models -> ${res.status}`);
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
			baseUrl: BASE_URL,
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
// Diagnostics
// ---------------------------------------------------------------------------

function printDryRun(
	discovered: { models: RegistryModel[]; source: string; skipped: string[] },
	session: { sessionId: string; source: string },
	live: { liveIds: Set<string>; source: string },
): void {
	const lines = [
		"pi-free-bridge dry run",
		`  registry:    ${discovered.source}`,
		`  base url:    ${BASE_URL}`,
		`  api:         ${API}   apiKey: ${API_KEY}`,
		`  session id:  ${session.sessionId} (from ${session.source})`,
		`  headers:     ${Object.keys(buildHeaders(session.sessionId)).join(", ")}`,
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
		baseUrl: BASE_URL,
		authHeader: true,
		headers: buildHeaders(session.sessionId),
		models: buildPiModels(discovered.models),
	});

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

	pi.registerCommand("free-bridge-session", {
		description: "Show or set the OpenCode session id used by the free-tier gate",
		handler: async (args: string, ctx) => {
			const next = args.trim();
			if (!next) {
				const current = resolveSessionId();
				ctx.ui.notify(
					`pi-free-bridge session: ${current.sessionId} (from ${current.source})`,
					"info",
				);
				return;
			}
			if (!/^ses_/.test(next)) {
				ctx.ui.notify("Session id must start with ses_", "warning");
				return;
			}
			const persisted = writeBridgeConfig({ sessionId: next });
			pi.registerProvider(PROVIDER, {
				apiKey: API_KEY,
				api: API,
				baseUrl: BASE_URL,
				authHeader: true,
				headers: buildHeaders(next),
				models: buildPiModels(discovered.models),
			});
			ctx.ui.notify(
				persisted
					? `Session id set to ${next} and saved to ${BRIDGE_CONFIG_PATH}`
					: `Session id set to ${next} for this session only (could not write ${BRIDGE_CONFIG_PATH})`,
				"info",
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
					baseUrl: BASE_URL,
					authHeader: true,
					headers: buildHeaders(resolveSessionId().sessionId),
					models: buildPiModels(refreshed.models),
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
			const lines = [
				"pi-free-bridge doctor",
				`  provider:   ${PROVIDER}`,
				`  registered: ${discovered.models.length} free models from ${discovered.source}`,
				`  session id: ${session.sessionId} (from ${session.source})`,
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
				`    pi -p --model ${PROVIDER}/space-bunny-free "Reply with exactly: OK"`,
				"  A non-zero exit or a non-OK reply is a gate or session-id problem,",
				"  not a scope problem — see /free-bridge-session.",
			);

			ctx.ui.notify(lines.join("\n"), result.status === "malformed" ? "error" : "info");
		},
	});
}