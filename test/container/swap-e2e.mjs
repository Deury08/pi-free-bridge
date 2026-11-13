// Container end-to-end for the update path, on real Linux with real processes.
// The "relay binary" is a Node script: a healthy one answers /health and says
// which build it is, a broken one exits on start. Nothing here touches port
// 8788 — it is the container's 8899.
//
// Two phases:
//   1. install a healthy binary, then update with a broken one;
//   2. the same, starting from a LEGACY config (`relayBin` naming `.v0.4.0`),
//      which is the state every install before the two-name layout is in.
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = process.argv[2] ?? process.env.PFB_ENTRY ?? fileURLToPath(new URL("../../index.ts", import.meta.url));
const mod = await import(entry);
const name = "relay-linux-x64";
const port = 8899;

const binary = (marker, healthy) => `#!/usr/bin/env node
const http = require("node:http");
${healthy ? `const s = http.createServer((q, r) => r.end(JSON.stringify({ ok: true, marker: "${marker}", pid: process.pid })));
s.listen(${port}, "127.0.0.1");` : `process.exit(1);`}
`;

const health = async () => {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
		return await res.json();
	} catch {
		return undefined;
	}
};

const failures = [];

/** Drive one install/update against a directory, with a real process for the relay. */
const runSwap = async (dir, { version, expectHealthy }) => {
	const current = join(dir, name);
	let child;
	const startRelay = async () => {
		try {
			if (child) child.kill("SIGKILL");
		} catch {}
		child = spawn(current, [], { stdio: "ignore" });
		for (let i = 0; i < 25; i += 1) {
			const body = await health();
			if (body?.ok) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	};
	if (expectHealthy) {
		// First install: the staged file is already healthy.
	}
	const result = await mod.swapRelayBinary({
		dir,
		name,
		downloaded: join(dir, `${name}.tmp`),
		version,
		timeoutMs: 3000,
		previous: current,
		stopRelay: async () => {
			const body = await health();
			if (body?.pid) {
				try {
					process.kill(body.pid, "SIGKILL");
				} catch {}
				await new Promise((r) => setTimeout(r, 150));
			}
			return true;
		},
		startRelay,
		askContinue: async () => "rollback",
	});
	return { result, child, stop: () => child?.kill("SIGKILL") };
};

const stage = (dir, marker, healthy) => {
	writeFileSync(join(dir, `${name}.tmp`), binary(marker, healthy));
	chmodSync(join(dir, `${name}.tmp`), 0o755);
	return dir;
};

// --- phase 1: install, then a broken update --------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "e2e-plain-"));
	writeFileSync(join(dir, name), binary("GOOD-1", true));
	chmodSync(join(dir, name), 0o755);
	const first = await (async () => {
		const started = spawn(join(dir, name), [], { stdio: "ignore" });
		for (let i = 0; i < 25; i += 1) {
			if ((await health())?.ok) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		return started;
	})();
	void first;

	stage(dir, "BROKEN-2", false);
	const { result, stop } = await runSwap(dir, { version: "0.5.0", expectHealthy: false });
	const listed = readdirSync(dir).sort();
	const body = await health();
	console.log("phase1 dir:", listed.join(" "));
	if (result.ok !== false || result.rolledBack !== true) failures.push(`phase1 result: ${JSON.stringify(result)}`);
	if (listed.join(" ") !== "failed.log relay-linux-x64") failures.push(`phase1 layout: ${listed.join(" ")}`);
	if (!readFileSync(join(dir, name), "utf8").includes("GOOD-1")) failures.push("phase1 kept the wrong bytes");
	if (body?.marker !== "GOOD-1") failures.push(`phase1 health: ${JSON.stringify(body)}`);
	stop();
}

// --- phase 2: legacy config, then a broken update ---------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "e2e-legacy-"));
	const legacy = join(dir, `${name}.v0.4.0`);
	writeFileSync(legacy, binary("GOOD-LEGACY", true));
	chmodSync(legacy, 0o755);
	// The config lives outside the binary directory, as it does in real installs.
	const configPath = join(mkdtempSync(join(tmpdir(), "e2e-config-")), "pi-free-bridge.json");
	writeFileSync(configPath, `${JSON.stringify({ relayBin: legacy }, null, 2)}\n`);
	const read = () => JSON.parse(readFileSync(configPath, "utf8"));
	const write = (patch) => writeFileSync(configPath, `${JSON.stringify({ ...read(), ...patch }, null, 2)}\n`);
	const deps = { read, write, exists: (path) => existsSync(path) };

	// Resolving must not touch the config: declining an install changes nothing.
	const resolved = mod.resolveRelayBin(dir, name, deps);
	if (read().relayBin !== legacy) failures.push("resolving wrote the config");

	// The migration happens only after consent.
	const previous = mod.migrateRelayBinConfig(dir, name, deps);
	const canonical = join(dir, name);
	if (resolved !== canonical || previous !== canonical) failures.push("migration did not resolve to the canonical name");
	if (read().relayBin !== canonical) failures.push(`config still stale: ${read().relayBin}`);

	const started = spawn(legacy, [], { stdio: "ignore" });
	for (let i = 0; i < 25; i += 1) {
		if ((await health())?.ok) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	void started;

	stage(dir, "BROKEN-LEGACY", false);
	const { result, stop } = await runSwap(dir, { version: "0.5.1", expectHealthy: false });
	const listed = readdirSync(dir).sort();
	const body = await health();
	console.log("phase2 dir:", listed.join(" "));
	console.log("phase2 config:", read().relayBin);
	if (result.rolledBack !== true) failures.push(`phase2 result: ${JSON.stringify(result)}`);
	if (listed.join(" ") !== "failed.log relay-linux-x64") failures.push(`phase2 layout: ${listed.join(" ")}`);
	if (!readFileSync(canonical, "utf8").includes("GOOD-LEGACY")) failures.push("phase2 kept the wrong bytes");
	if (body?.marker !== "GOOD-LEGACY") failures.push(`phase2 health: ${JSON.stringify(body)}`);
	stop();
}

console.log(failures.length === 0 ? "E2E: PASS" : `E2E: FAIL — ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
