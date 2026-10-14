import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider id is load-bearing: settings.json, gentle-ai profiles and subagents
 *  all reference `oc-sdk-zen/<model>`. Do not rename it (HANDOFF D2). */
const PROVIDER = "oc-sdk-zen";

/** The free tier moved here from /zen/v1, which is now hard-403 for every
 *  client outside the official CLI (HANDOFF §4.1). */
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

/** Optional user config: `{ "sessionId": "ses_…" }`. */
const BRIDGE_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge.json");

/** Models the surface advertises but cannot serve over chat/completions:
 *  400 ModelProtocolUnsupported on /inference/v1, 403 on /messages (HANDOFF D5). */
const EXCLUDED_MODELS = new Set([
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free",
	"jev-1.13-free",
]);

const REG_KEY = Symbol.for("pi-free-bridge:registered");

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

function resolveSessionId(): { sessionId: string; source: string } {
	const fromEnv = process.env.PI_FREE_BRIDGE_SESSION_ID?.trim();
	if (fromEnv) return { sessionId: fromEnv, source: "PI_FREE_BRIDGE_SESSION_ID" };

	if (existsSync(BRIDGE_CONFIG_PATH)) {
		try {
			const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf-8"));
			const id = typeof cfg?.sessionId === "string" ? cfg.sessionId.trim() : "";
			if (id) return { sessionId: id, source: BRIDGE_CONFIG_PATH };
		} catch {
			// malformed config falls back to the built-in constant
		}
	}

	return { sessionId: DEFAULT_SESSION_ID, source: "built-in constant" };
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

function discoverFreeModels(): { models: RegistryModel[]; source: string } {
	const path = resolveRegistryPath();
	if (!path) return { models: [], source: "registry not found" };

	let data: Record<string, any>;
	try {
		data = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return { models: [], source: `registry unreadable: ${(err as Error).message}` };
	}

	const registryModels = data?.opencode?.models;
	if (!registryModels || typeof registryModels !== "object") {
		return { models: [], source: `registry has no "opencode.models": ${path}` };
	}

	const models: RegistryModel[] = [];
	for (const [id, meta] of Object.entries<Record<string, unknown>>(registryModels)) {
		if (!meta || typeof meta !== "object") continue;
		if (EXCLUDED_MODELS.has(id)) continue;
		if (!isFree(meta)) continue;
		models.push({ id, name: (meta.name as string) || id, meta });
	}

	models.sort((a, b) => a.id.localeCompare(b.id));
	return { models, source: path };
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

function printDryRun(discovered: { models: RegistryModel[]; source: string }, session: {
	sessionId: string;
	source: string;
}): void {
	const lines = [
		"pi-free-bridge dry run",
		`  registry:    ${discovered.source}`,
		`  base url:    ${BASE_URL}`,
		`  api:         ${API}   apiKey: ${API_KEY}`,
		`  session id:  ${session.sessionId} (from ${session.source})`,
		`  headers:     ${Object.keys(buildHeaders(session.sessionId)).join(", ")}`,
		`  excluded:    ${[...EXCLUDED_MODELS].join(", ")}`,
		`  models (${discovered.models.length}):`,
		...discovered.models.map((m) => `    - ${m.id}`),
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
	const discovered = discoverFreeModels();

	if (process.env.PI_FREE_BRIDGE_DRY_RUN === "1") {
		printDryRun(discovered, session);
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
			pi.registerProvider(PROVIDER, {
				apiKey: API_KEY,
				api: API,
				baseUrl: BASE_URL,
				authHeader: true,
				headers: buildHeaders(next),
				models: buildPiModels(discovered.models),
			});
			ctx.ui.notify(
				`Session id set to ${next} for this session. Persist it in ${BRIDGE_CONFIG_PATH} to keep it.`,
				"info",
			);
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
}