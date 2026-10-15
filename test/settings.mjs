// Test for the `enabledModels` scope repair in index.ts, without touching the
// real ~/.pi/agent/settings.json.
//
// Run: node test/settings.mjs
//
// Background (see README "El picker está acotado por `enabledModels`"): Pi scopes
// the model picker to `enabledModels` in its global settings. A non-empty list
// means "show ONLY these". The bridge registers its models at runtime, so a
// list that omits `oc-sdk-zen/*` hides every free model while `pi --list-models`
// still reports all seven — the two are different code paths.
//
// The repair is append-only and idempotent, and it is a byte-level splice rather
// than a JSON round-trip: this file belongs to Pi and to the user's editor, so
// every byte outside the array must survive untouched. It deliberately does NOT
// act when the list is absent or empty: an empty list makes the picker unscoped
// (show everything), so adding the glob there would *narrow* the picker instead
// of repairing it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Never let a test write the real settings.json. The kill switch lives inside
// repairEnabledModels, so it covers the activation path and /free-bridge-doctor.
process.env.PI_FREE_BRIDGE_SELF_REPAIR = "0";

const mod = await import("../index.ts");
const { ensureEnabledPattern, repairEnabledModels } = mod;
assert.equal(typeof ensureEnabledPattern, "function", "ensureEnabledPattern must be exported");
assert.equal(typeof repairEnabledModels, "function", "repairEnabledModels must be exported");

const PATTERN = "oc-sdk-zen/*";
const REAL_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");
const tmp = mkdtempSync(join(tmpdir(), "pi-free-bridge-settings-"));

const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");
const parse = (r) => JSON.parse(r.text);

// Captured BEFORE any test runs, so the exit guard can prove this run left the
// real settings.json byte-identical.
function realFingerprint() {
	try {
		return md5(REAL_SETTINGS);
	} catch {
		return null;
	}
}
const fingerprintBefore = realFingerprint();

/* ------------------------------------------------------------------ */
/* 1. Already healthy: no write payload at all.                         */
/* ------------------------------------------------------------------ */
{
	const input = JSON.stringify({ defaultProvider: "oc-sdk-zen", enabledModels: ["opencode-go/glm-5.3", PATTERN] });
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "unchanged", "a healthy list must not be rewritten");
	assert.equal(r.text, undefined, "unchanged must not carry a text payload");
}

/* ------------------------------------------------------------------ */
/* 2. Absent / empty list: leave it alone (picker is already unscoped). */
/* ------------------------------------------------------------------ */
{
	assert.equal(ensureEnabledPattern(JSON.stringify({ defaultProvider: "x" }), PATTERN).status, "unchanged");
	assert.equal(ensureEnabledPattern(JSON.stringify({ enabledModels: [] }), PATTERN).status, "unchanged");
}

/* ------------------------------------------------------------------ */
/* 3. Missing glob: append it, every other key survives unchanged.      */
/* ------------------------------------------------------------------ */
{
	const input = JSON.stringify({
		defaultModel: "space-bunny-free",
		defaultProvider: "oc-sdk-zen",
		enabledModels: ["opencode-go/glm-5.3", "opencode-go/kimi-k3"],
		extensions: ["-builtin:codemode"],
		packages: ["npm:gentle-pi", "..\\..\\pi-free-bridge"],
		theme: "Gentleman-Cute",
		images: { blockImages: false },
	});
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "added");
	assert.equal(r.previousCount, 2);

	const out = parse(r);
	assert.deepEqual(out.enabledModels, ["opencode-go/glm-5.3", "opencode-go/kimi-k3", PATTERN]);
	assert.equal(out.defaultModel, "space-bunny-free");
	assert.equal(out.defaultProvider, "oc-sdk-zen");
	assert.deepEqual(out.extensions, ["-builtin:codemode"]);
	assert.deepEqual(out.packages, ["npm:gentle-pi", "..\\..\\pi-free-bridge"]);
	assert.equal(out.theme, "Gentleman-Cute");
	assert.deepEqual(out.images, { blockImages: false });
}

/* ------------------------------------------------------------------ */
/* 4. D6 — only enabledModels may differ. Comparing the whole object    */
/*    catches damage to any key, including ones not named above.        */
/* ------------------------------------------------------------------ */
{
	const input = JSON.stringify({
		defaultModel: "space-bunny-free",
		enabledModels: ["a/b", "c/d"],
		fullscreenScrollbar: "auto",
		hideThinkingBlock: true,
		lastChangelogVersion: "1.2.0",
		tuiMode: "fullscreen",
		images: { blockImages: false },
	});
	const before = JSON.parse(input);
	const after = parse(ensureEnabledPattern(input, PATTERN));

	assert.deepEqual(Object.keys(after), Object.keys(before), "the key set must not change");
	for (const key of Object.keys(before)) {
		if (key === "enabledModels") continue;
		assert.deepEqual(after[key], before[key], `unrelated key ${key} was modified`);
	}
	assert.deepEqual(after.enabledModels, ["a/b", "c/d", PATTERN]);
}

/* ------------------------------------------------------------------ */
/* 5. D1 — CRLF survives. A JSON round-trip would rewrite the whole     */
/*    file to LF; the splice must add one line in the file's own EOL.   */
/* ------------------------------------------------------------------ */
{
	const input =
		'{\r\n  "theme": "x",\r\n  "enabledModels": [\r\n    "opencode-go/glm-5.3",\r\n    "opencode-go/kimi-k3"\r\n  ]\r\n}\r\n';
	const expected =
		'{\r\n  "theme": "x",\r\n  "enabledModels": [\r\n    "opencode-go/glm-5.3",\r\n    "opencode-go/kimi-k3",\r\n    "oc-sdk-zen/*"\r\n  ]\r\n}\r\n';
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "added");
	assert.equal(r.text, expected, "the repair must be byte-identical to appending one CRLF line");
	assert.equal((r.text.match(/\r\n/g) ?? []).length, (input.match(/\r\n/g) ?? []).length + 1);
	assert.ok(!/[^\r]\n/.test(r.text), "no bare LF may be introduced");
}

/* ------------------------------------------------------------------ */
/* 6. LF files stay LF, and the indentation of the array is matched.    */
/* ------------------------------------------------------------------ */
{
	const input = '{\n  "enabledModels": [\n\t\t"opencode-go/glm-5.3"\n  ]\n}\n';
	const expected = '{\n  "enabledModels": [\n\t\t"opencode-go/glm-5.3",\n\t\t"oc-sdk-zen/*"\n  ]\n}\n';
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "added");
	assert.equal(r.text, expected, "tabs and LF must both be preserved");
}

/* ------------------------------------------------------------------ */
/* 7. D2 — integers above 2^53 are not silently rounded.                */
/* ------------------------------------------------------------------ */
{
	const input = '{\n  "lastChangelogVersion": 12345678901234567890,\n  "enabledModels": [\n    "a/b"\n  ]\n}\n';
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "added");
	assert.ok(
		r.text.includes("12345678901234567890"),
		`the big integer was altered: ${r.text}`,
	);
}

/* ------------------------------------------------------------------ */
/* 8. D3 — duplicate keys and integer-like keys are not collapsed.      */
/*    JSON.parse keeps only the last duplicate, so a round-trip would    */
/*    silently drop data; the splice leaves them in the raw text.       */
/* ------------------------------------------------------------------ */
{
	const input = '{\n  "theme": "first",\n  "theme": "second",\n  "enabledModels": [\n    "a/b"\n  ]\n}\n';
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "added");
	assert.equal((r.text.match(/"theme"/g) ?? []).length, 2, "a duplicate key must survive");
	assert.ok(r.text.includes('"theme": "first"'), "the first duplicate must survive");

	const intKeys = '{\n  "10": "ten",\n  "2": "two",\n  "enabledModels": [\n    "a/b"\n  ]\n}\n';
	const r2 = ensureEnabledPattern(intKeys, PATTERN);
	assert.equal(r2.status, "added");
	assert.ok(r2.text.indexOf('"10"') < r2.text.indexOf('"2"'), "integer-like key order must not be rewritten");
}

/* ------------------------------------------------------------------ */
/* 9. A single-line array gets the entry inline.                        */
/* ------------------------------------------------------------------ */
{
	const r = ensureEnabledPattern('{"enabledModels":["a/b","c/d"]}', PATTERN);
	assert.equal(r.status, "added");
	assert.equal(r.text, `{"enabledModels":["a/b","c/d", "${PATTERN}"]}`);
}

/* ------------------------------------------------------------------ */
/* 10. Escapes inside entries must not fool the array scanner.          */
/* ------------------------------------------------------------------ */
{
	const input = '{\n  "theme": "quote \\" and ] bracket",\n  "enabledModels": [\n    "a/b",\n    "c]d"\n  ]\n}\n';
	const r = ensureEnabledPattern(input, PATTERN);
	assert.equal(r.status, "added");
	assert.deepEqual(parse(r).enabledModels, ["a/b", "c]d", PATTERN]);
}

/* ------------------------------------------------------------------ */
/* 11. Idempotence: repairing twice must be a no-op the second time.    */
/* ------------------------------------------------------------------ */
{
	const first = ensureEnabledPattern(JSON.stringify({ enabledModels: ["opencode-go/glm-5.3"] }), PATTERN);
	assert.equal(first.status, "added");
	const second = ensureEnabledPattern(first.text, PATTERN);
	assert.equal(second.status, "unchanged", "the repair must be idempotent");
	assert.equal(second.text, undefined, "the second pass must not write");
	assert.deepEqual(parse(first).enabledModels, ["opencode-go/glm-5.3", PATTERN]);
}

/* ------------------------------------------------------------------ */
/* 12. Fail-closed on malformed input: never emit a write payload.      */
/* ------------------------------------------------------------------ */
{
	for (const [label, raw] of [
		["truncated JSON", "{ not json"],
		["empty string", ""],
		["JSON array at top level", "[1,2,3]"],
		["top-level null", "null"],
		["enabledModels is a string", JSON.stringify({ enabledModels: "oc-sdk-zen/*" })],
		["enabledModels is an object", JSON.stringify({ enabledModels: { a: 1 } })],
		["enabledModels is null", JSON.stringify({ enabledModels: null })],
		["enabledModels is a number", JSON.stringify({ enabledModels: 7 })],
		["enabledModels holds a non-string", JSON.stringify({ enabledModels: [1, null] })],
		["array literal is unterminated", '{ "enabledModels": ["a", '],
	]) {
		const r = ensureEnabledPattern(raw, PATTERN);
		assert.equal(r.status, "malformed", `${label} must be reported as malformed`);
		assert.equal(r.text, undefined, `${label} must not produce a write payload`);
	}
}

/* ------------------------------------------------------------------ */
/* 13. D5 — the real write path, against a temp file.                   */
/* ------------------------------------------------------------------ */
{
	const path = join(tmp, "write-path.json");
	const original = '{\n  "theme": "t",\n  "enabledModels": [\n    "a/b"\n  ]\n}\n';
	writeFileSync(path, original, "utf-8");

	delete process.env.PI_FREE_BRIDGE_SELF_REPAIR;
	try {
		const r = repairEnabledModels(path);
		assert.equal(r.status, "added", "the real write path must report the repair");
		assert.equal(r.previousCount, 1);
		assert.equal(readFileSync(path, "utf-8"), ensureEnabledPattern(original, PATTERN).text);

		// Second run: unchanged, and the bytes on disk do not move.
		const after = md5(path);
		const second = repairEnabledModels(path);
		assert.equal(second.status, "unchanged");
		assert.equal(md5(path), after, "an unchanged result must not touch the file");
	} finally {
		process.env.PI_FREE_BRIDGE_SELF_REPAIR = "0";
	}
}

/* ------------------------------------------------------------------ */
/* 14. D4 — the kill switch is inside repairEnabledModels, so it        */
/*    covers every caller rather than one call site.                    */
/* ------------------------------------------------------------------ */
{
	const path = join(tmp, "kill-switch.json");
	const original = '{\n  "enabledModels": [\n    "a/b"\n  ]\n}\n';
	writeFileSync(path, original, "utf-8");

	process.env.PI_FREE_BRIDGE_SELF_REPAIR = "0";
	const r = repairEnabledModels(path);
	assert.equal(r.status, "unchanged", "the kill switch must suppress the repair");
	assert.equal(readFileSync(path, "utf-8"), original, "the file must be byte-identical");
}

/* ------------------------------------------------------------------ */
/* 15. D5 — error branches of the write path.                           */
/* ------------------------------------------------------------------ */
{
	delete process.env.PI_FREE_BRIDGE_SELF_REPAIR;
	try {
		const missing = repairEnabledModels(join(tmp, "does-not-exist.json"));
		assert.equal(missing.status, "malformed");
		assert.match(missing.reason, /could not read/);

		// A directory is readable on some platforms but is never writable as a
		// file, so either branch is a legitimate outcome; both must fail closed.
		const asDir = repairEnabledModels(tmp);
		assert.equal(asDir.status, "malformed");
		assert.match(asDir.reason, /could not read|could not write/);
	} finally {
		process.env.PI_FREE_BRIDGE_SELF_REPAIR = "0";
	}
}

/* ------------------------------------------------------------------ */
/* 16. D7 — this run left the real settings.json untouched.             */
/* ------------------------------------------------------------------ */
{
	const r = ensureEnabledPattern(readFileSync(REAL_SETTINGS, "utf-8"), PATTERN);
	assert.notEqual(r.status, "malformed", "the real settings.json must parse");
	assert.equal(realFingerprint(), fingerprintBefore, "the real settings.json changed during this test run");
}

/* ------------------------------------------------------------------ */
/* 17. Scanner edge cases: a file we cannot safely locate the array in is */
/*     refused rather than corrupted.                                  */
/* ------------------------------------------------------------------ */
{
	// A literal "enabledModels" inside another string is not the real key. The
	// scanner finds it, then fails to find ":" after it and gives up. The file
	// is valid and would benefit from a repair, but we refuse: a false negative
	// that reports a reason beats a false positive that corrupts a config we do
	// not own. /free-bridge-doctor surfaces the reason for a manual edit.
	const plain = ensureEnabledPattern('{"note":"enabledModels","enabledModels":["a/b"]}', PATTERN);
	assert.equal(plain.status, "malformed", "a decoy literal must not be mistaken for the key");
	assert.equal(plain.text, undefined);

	// An escaped literal cannot match, so the real key is found and repaired.
	const escaped = ensureEnabledPattern('{"note":"the \\"enabledModels\\" key","enabledModels":["a/b"]}', PATTERN);
	assert.equal(escaped.status, "added");
	assert.deepEqual(parse(escaped).enabledModels, ["a/b", PATTERN]);

	// A nested array of the same name would win the naive first-match search.
	const nested = ensureEnabledPattern('{"a":{"enabledModels":["x"]},"enabledModels":["a/b"]}', PATTERN);
	assert.equal(nested.status, "malformed", "a nested decoy array must not be spliced");

	// Whitespace between the key, the colon and the bracket is legal JSON and
	// must still be located.
	const spaced = ensureEnabledPattern('{ "enabledModels" : [ "a/b" ] }', PATTERN);
	assert.equal(spaced.status, "added");
	assert.deepEqual(parse(spaced).enabledModels, ["a/b", PATTERN]);
}

console.log("settings: OK — enabledModels repair is an append-only byte splice and is idempotent");
