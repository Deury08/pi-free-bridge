/** The model registry, read from whichever OpenCode source still maintains it.
 *
 *  OpenCode v1 wrote `~/.cache/opencode/models.json`. v2 keeps the same data in
 *  SQLite instead, under `kv.models-dev:v2:catalog`, wrapped as
 *  `{ updatedAt, digest, body }` where `body` is a JSON string. Both were
 *  sampled on 2026-11-12: the file carried 143 models and the SQLite row
 *  11.3 MB refreshed the same day.
 *
 *  The cost shape differs, which is the trap: the file declares
 *  `{ input: 0, output: 0 }` while v2 nests `{ text: { input: { price: 0 } } }`.
 *  `isFree` tests the declared numbers, so feeding a v2 cost straight in would
 *  classify every model as paid and register nothing, silently.
 */

/** Flatten one v2 cost into the registry's numbers.
 *
 *  Returns the input unchanged when it is not a v2 cost or cannot be read
 *  honestly: a half-converted cost would make `isFree` answer a question about
 *  numbers that are not there. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export function normalizeV2Cost(cost) {
	if (!cost || typeof cost !== "object") return cost;

	const text = cost.text;
	if (!text || typeof text !== "object") return cost; // already flat, or a shape we do not know

	const price = (side) => {
		if (typeof side === "number") return side;
		if (side && typeof side === "object" && typeof side.price === "number") return side.price;
		return undefined;
	};

	const input = price(text.input);
	const output = price(text.output);
	if (input === undefined || output === undefined) return cost;

	const flat = { input, output };
	const cacheRead = text.input && typeof text.input === "object" && text.input.cache
		? text.input.cache.read
		: undefined;
	if (typeof cacheRead === "number") flat.cache_read = cacheRead;
	return flat;
}

/** Convert a `kv.models-dev:v2:catalog` body into the registry shape the
 *  extension already reads, `{ opencode: { models } }`.
 *
 *  Only `opencode` survives: every other provider in that body is noise for
 *  this extension, and carrying 11 MB of it forward costs more than it says. */
export function v2CatalogToRegistry(bodyText) {
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

	const models = parsed.opencode?.models;
	if (!models || typeof models !== "object" || Array.isArray(models)) return undefined;

	const converted = {};
	for (const [id, meta] of Object.entries(models)) {
		if (!meta || typeof meta !== "object") continue;
		converted[id] = { ...meta, cost: normalizeV2Cost(meta.cost) };
	}
	return { opencode: { models: converted } };
}

/** The `kv` key holding the model catalog in v2. */
export const V2_CATALOG_KEY = "models-dev:v2:catalog";

/** Unwrap one `kv` row: `{ updatedAt, digest, body }` where `body` is the JSON
 *  string `v2CatalogToRegistry` reads. `updatedAt` is what lets the caller tell
 *  a fresh catalog from a stale file. */
export function parseV2CatalogRow(rowValue) {
	if (typeof rowValue !== "string") return undefined;

	let wrapper;
	try {
		wrapper = JSON.parse(rowValue);
	} catch {
		return undefined;
	}
	if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return undefined;
	if (typeof wrapper.body !== "string") return undefined;

	const data = v2CatalogToRegistry(wrapper.body);
	if (!data) return undefined;

	const updatedAt = typeof wrapper.updatedAt === "number" && Number.isFinite(wrapper.updatedAt)
		? wrapper.updatedAt
		: 0;
	return { data, updatedAt };
}

/** Whether a registry can name every id the surface advertises.
 *
 *  This is the staleness test that matters: the registered set is the
 *  intersection of the registry and the advertised ids, so a registry that
 *  cannot name an advertised model is stale in the one way that changes the
 *  outcome. An empty `wanted` asks nothing and accepts the registry as it is. */
export function coversRegistry(data, wanted) {
	if (!wanted || wanted.size === 0) return true;
	const models = data?.opencode?.models;
	if (!models || typeof models !== "object") return false;
	for (const id of wanted) {
		if (!Object.hasOwn(models, id)) return false;
	}
	return true;
}

/** Read the `kv` row v2 keeps in place of `models.json`.
 *
 *  Only called when the file cannot answer: the body is 11.3 MB, and parsing it
 *  on every start cost ~0.3 s and ~87 MB of RSS on Pi's startup path (measured
 *  against the baseline). Freshness alone did not justify that -- the fresher
 *  store bought one extra free model -- so the file answers unless it is
 *  missing, unreadable, or stale in the way `coversRegistry` defines. */
function readV2Catalog(dbPath) {
	if (!existsSync(dbPath)) return undefined;
	try {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite");
		if (typeof DatabaseSync !== "function") return undefined;

		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const row = db.prepare("select value from kv where key = ?").get(V2_CATALOG_KEY);
			return parseV2CatalogRow(row?.value)?.data;
		} finally {
			db.close();
		}
	} catch {
		// Node without node:sqlite, a v1 database with no kv table, a lock.
	}
	return undefined;
}

/** The registry to use, and where it came from.
 *
 *  One implementation for every caller on purpose: the extension registers from
 *  it and the smoke test verifies against it, so drift between "what decides"
 *  and "what is checked" cannot hide -- which is exactly how a stale file could
 *  keep passing verification while registering something else.
 *
 *  A registry that exists but cannot be parsed keeps its reason: a truncated
 *  file is not a missing one, and the doctor tells the operator which to fix. */
export function readRegistry({ shareDir, filePaths, wanted } = {}) {
	const path = filePaths.find((p) => existsSync(p));
	let file;
	let unreadable;
	if (path) {
		try {
			file = JSON.parse(readFileSync(path, "utf-8"));
		} catch (err) {
			unreadable = `registry unreadable: ${err?.message ?? err}`;
		}
	}

	if (file && coversRegistry(file, wanted)) return { data: file, source: `registry-file: ${path}` };

	const kv = readV2Catalog(join(shareDir, "opencode.db"));
	if (kv) return { data: kv, source: `v2-catalog: ${V2_CATALOG_KEY}` };
	if (file) return { data: file, source: `registry-file: ${path}` };
	return unreadable ? { source: unreadable } : undefined;
}
