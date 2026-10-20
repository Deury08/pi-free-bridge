#!/usr/bin/env node
/**
 * Refresh the advertised free-model list for pi-free-bridge.
 *
 * Writes ONLY the `liveIds` field of ~/.pi/agent/pi-free-bridge.json, preserving
 * any `sessionId` already there. pi-free-bridge reads that file on every Pi
 * startup, so the next launch picks up added or removed free models with no
 * slash command and no code change.
 *
 * Mirrors fetchLiveFreeIds() + discoverFreeModels() from index.ts.
 * Fail-loud: never overwrite the config when the registry or the surface cannot
 * be read, and never write an empty list.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://opencode.ai/inference/v1";
const API_KEY = "public";
const USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

const REGISTRY_PATHS = [
	join(homedir(), ".cache", "opencode", "models.json"),
	join(homedir(), ".config", "opencode", "models.json"),
];
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge.json");
const LOG_PATH = join(homedir(), ".pi", "agent", "pi-free-bridge-refresh.log");

/** The scheduled task must never hang: a stuck process would keep the task in
 *  "running" state forever and silently stop refreshing. */
const FETCH_TIMEOUT_MS = 20_000;

function log(message) {
	const line = `[${new Date().toISOString()}] ${message}`;
	console.log(message);
	try {
		appendFileSync(LOG_PATH, `${line}\n`, "utf-8");
	} catch {
		// A missing log must never break the refresh.
	}
}

function fail(message) {
	log(`ERROR ${message}`);
	process.exit(1);
}

// Kept in sync with EXCLUDED_MODELS in index.ts: the surface advertises these
// but they answer 400 ModelProtocolUnsupported over chat/completions.
const EXCLUDED_MODELS = new Set([
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free",
	"jev-1.13-free",
]);

/**
 * A model is free when every cost field it actually declares is zero. The
 * registry omits `cache_write` on most free models, so requiring all four
 * fields to equal 0 would classify most free models as paid.
 */
function isFree(meta) {
	const cost = meta.cost ?? {};
	const declared = Object.values(cost).filter(
		(value) => typeof value === "number" && Number.isFinite(value),
	);
	return declared.length > 0 && declared.every((value) => value === 0);
}

const registryPath = REGISTRY_PATHS.find((path) => existsSync(path));
if (!registryPath) fail(`registry not found in any of: ${REGISTRY_PATHS.join(", ")}`);

let registryModels;
try {
	registryModels = JSON.parse(readFileSync(registryPath, "utf-8"))?.opencode?.models;
} catch (err) {
	fail(`registry unreadable (${registryPath}): ${err.message}`);
}
if (!registryModels || typeof registryModels !== "object") {
	fail(`registry has no "opencode.models": ${registryPath}`);
}

const registryFree = new Set(
	Object.entries(registryModels)
		.filter(
			([id, meta]) =>
				meta &&
				typeof meta === "object" &&
				!EXCLUDED_MODELS.has(id) &&
				isFree(meta),
		)
		.map(([id]) => id),
);

const res = await fetch(`${BASE_URL}/models`, {
	headers: { "user-agent": USER_AGENT, authorization: `Bearer ${API_KEY}` },
	signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
});
if (!res.ok) fail(`GET ${BASE_URL}/models -> ${res.status}`);

const payload = await res.json();
const listed = payload.data ?? payload.models ?? [];
const nextLiveIds = listed
	.map((model) => (typeof model === "string" ? model : model?.id))
	.filter((id) => typeof id === "string" && registryFree.has(id))
	.sort((a, b) => a.localeCompare(b));

if (nextLiveIds.length === 0) {
	fail("the intersection came back empty; refusing to blank the model list");
}

let config = {};
if (existsSync(CONFIG_PATH)) {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		if (parsed && typeof parsed === "object") config = parsed;
	} catch {
		console.warn(`refresh-live-ids: ${CONFIG_PATH} is malformed; rewriting it`);
	}
}

const previous = Array.isArray(config.liveIds) ? config.liveIds : [];
writeFileSync(
	CONFIG_PATH,
	`${JSON.stringify({ ...config, liveIds: nextLiveIds }, null, 2)}\n`,
	"utf-8",
);

const before = new Set(previous);
const after = new Set(nextLiveIds);
const added = nextLiveIds.filter((id) => !before.has(id));
const removed = previous.filter((id) => !after.has(id));

console.log(
	`refresh-live-ids: ${nextLiveIds.length} free models advertised ` +
		`(${registryFree.size} free in the registry)`,
);
log(
	`OK ${nextLiveIds.length} free models ` +
		`(added: ${added.length ? added.join(", ") : "none"} | ` +
		`removed: ${removed.length ? removed.join(", ") : "none"})`,
);
console.log(`  added:   ${added.length ? added.join(", ") : "none"}`);
console.log(`  removed: ${removed.length ? removed.join(", ") : "none"}`);
console.log(`  written: ${CONFIG_PATH}`);