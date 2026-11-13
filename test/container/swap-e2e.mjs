// Container end-to-end for the update path, on real Linux with real processes.
// The "relay binary" is a Node script: GOOD answers /health and says so, BROKEN
// exits on start. Nothing here touches port 8788 — it is the container's 8899.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = process.argv[2] ?? process.env.PFB_ENTRY ?? fileURLToPath(new URL("../../index.ts", import.meta.url));
const mod = await import(entry);
const name = "relay-linux-x64";
const dir = mkdtempSync(join(tmpdir(), "e2e-"));
const current = join(dir, name);
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

// --- install 1: a healthy binary -------------------------------------------
writeFileSync(join(dir, `${name}.tmp`), binary("GOOD-1", true));
chmodSync(join(dir, `${name}.tmp`), 0o755);
const first = await mod.swapRelayBinary({
	dir,
	name,
	downloaded: join(dir, `${name}.tmp`),
	version: "0.5.1",
	timeoutMs: 3000,
	stopRelay: async () => true,
	startRelay,
	askContinue: async () => "rollback",
});
console.log("install1:", JSON.stringify(first));
console.log("install1 dir:", readdirSync(dir).sort().join(" "));
console.log("install1 health:", JSON.stringify(await health()));

// --- install 2: the update, with a broken download --------------------------
writeFileSync(join(dir, `${name}.tmp`), binary("BROKEN-2", false));
chmodSync(join(dir, `${name}.tmp`), 0o755);
const second = await mod.swapRelayBinary({
	dir,
	name,
	downloaded: join(dir, `${name}.tmp`),
	version: "0.5.0",
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
console.log("install2:", JSON.stringify(second));
console.log("install2 dir:", readdirSync(dir).sort().join(" "));
console.log("install2 health:", JSON.stringify(await health()));

// --- assertions ------------------------------------------------------------
const listed = readdirSync(dir).sort();
const failures = [];
if (listed.join(" ") !== "failed.log relay-linux-x64") failures.push(`layout: ${listed.join(" ")}`);
if (!readFileSync(current, "utf8").includes("GOOD-1")) failures.push("the surviving binary is not the good one");
const after = await health();
if (after?.marker !== "GOOD-1") failures.push(`health after rollback: ${JSON.stringify(after)}`);
if (!readFileSync(join(dir, "failed.log"), "utf8").includes("0.5.0")) failures.push("failed.log missing the failure");
console.log(failures.length === 0 ? "E2E: PASS" : `E2E: FAIL — ${failures.join("; ")}`);
if (child) child.kill("SIGKILL");
process.exit(failures.length === 0 ? 0 : 1);
