// Tests for the health-recovery helpers used by `startBridgeGo` (index.ts).
//
// Run: node --test test/health-recovery.test.mjs
//
// The launcher used to die with "bridge-go started but did not answer /health"
// when (a) a fresh binary answers slower than one 750 ms window (Windows AV
// cold start) or (b) a stale hung pi-free-bridge instance from a previous
// session keeps holding the port. These helpers classify /health, retry, find
// the stale owner, verify its identity, and kill it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

import {
	delay,
	HEALTH_PROBE_ATTEMPTS,
	HEALTH_PROBE_GAP_MS,
	HEALTH_PROBE_TIMEOUT_MS,
	findPortListenerPid,
	isBridgeGoPid,
	killStaleBridgeGo,
	parseNetstatListener,
	probeBridgeGoHealth,
} from "../health-recovery.mjs";

/** Start an HTTP server on an ephemeral port; resolves { server, url, close }.
 *  `close()` awaits the close AND destroys the sockets undici keeps alive with
 *  its connection pool — without that teardown the event loop never drains and
 *  node --test hangs. */
async function startHttpServer(handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		server,
		port,
		url: `http://127.0.0.1:${port}/health`,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

// ---------------------------------------------------------------------------
// probeBridgeGoHealth — classification
// ---------------------------------------------------------------------------

test("probe: healthy when service matches", async () => {
	const { url, close } = await startHttpServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"ok":true,"service":"pi-free-bridge"}');
	});
	try {
		assert.equal(await probeBridgeGoHealth(url, "pi-free-bridge", { attempts: 1 }), "healthy");
	} finally {
		await close();
	}
});

test("probe: foreign when service differs or status is not ok", async () => {
	const { url, close } = await startHttpServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"ok":true,"service":"something-else"}');
	});
	try {
		assert.equal(await probeBridgeGoHealth(url, "pi-free-bridge", { attempts: 1 }), "foreign");
	} finally {
		await close();
	}

	const errored = await startHttpServer((req, res) => {
		res.writeHead(500);
		res.end();
	});
	try {
		assert.equal(await probeBridgeGoHealth(errored.url, "pi-free-bridge", { attempts: 1 }), "foreign");
	} finally {
		await errored.close();
	}
});

test("probe: absent when nothing answers", async () => {
	// A socket nobody listens on: connection refused → absent.
	assert.equal(await probeBridgeGoHealth("http://127.0.0.1:1/health", "pi-free-bridge", { attempts: 1 }), "absent");
});

// ---------------------------------------------------------------------------
// probeBridgeGoHealth — retry
// ---------------------------------------------------------------------------

test("probe: defaults are 3 attempts with 750 ms timeout and 500 ms gap", async () => {
	assert.equal(HEALTH_PROBE_ATTEMPTS, 3);
	assert.equal(HEALTH_PROBE_TIMEOUT_MS, 750);
	assert.equal(HEALTH_PROBE_GAP_MS, 500);
});

test("probe: absent wins only after all attempts (retry gaps elapsed)", async () => {
	const started = Date.now();
	const result = await probeBridgeGoHealth("http://127.0.0.1:1/health", "pi-free-bridge");
	const elapsed = Date.now() - started;
	assert.equal(result, "absent");
	// 2 inter-attempt gaps must have been waited out at minimum.
	assert.ok(elapsed >= HEALTH_PROBE_GAP_MS * 2, `elapsed ${elapsed}ms < ${HEALTH_PROBE_GAP_MS * 2}ms`);
});

test("probe: respects a fast gap between attempts", async () => {
	const started = Date.now();
	await probeBridgeGoHealth("http://127.0.0.1:1/health", "pi-free-bridge", { attempts: 3, gapMs: 10 });
	assert.ok(Date.now() - started < 600, "fast gap should not take the full retry window");
});

test("probe: timeout param is honored", async () => {
	const started = Date.now();
	await probeBridgeGoHealth("http://10.255.255.1:1234/health", "pi-free-bridge", {
		attempts: 1,
		timeoutMs: 300,
	});
	assert.ok(Date.now() - started < 5000, "single 300 ms-timeout attempt should not hang");
});

// ---------------------------------------------------------------------------
// parseNetstatListener + findPortListenerPid
// ---------------------------------------------------------------------------

test("parseNetstatListener: finds the LISTENING pid on the port, ignores noise", () => {
	const out = [
		"",
		"  Proto  Local Address          Foreign Address        State           PID",
		"  TCP    0.0.0.0:12345          0.0.0.0:0              LISTENING       999",
		"  TCP    127.0.0.1:8790         127.0.0.1:52001        ESTABLISHED     999",
		"  TCP    127.0.0.1:8790         0.0.0.0:0              LISTENING       4242",
		"  TCP    127.0.0.1:8791         0.0.0.0:0              LISTENING       555",
		"  TCP    [::]:8790              [::]:0                 LISTENING       111",
		"",
	].join("\n");
	assert.equal(parseNetstatListener(out, 8790), 4242);
	assert.equal(parseNetstatListener(out, 8791), 555);
	assert.equal(parseNetstatListener(out, 9999), 0);
	assert.equal(parseNetstatListener("", 8790), 0);
});

	test("findPortListenerPid: returns the pid of the current test process listening on an ephemeral port", async () => {
		const server = http.createServer(() => {});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		try {
			// On Windows netstat reports the owning pid of the listener, which is
			// this very process.
			assert.equal(findPortListenerPid(port), process.pid);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

// ---------------------------------------------------------------------------
// isBridgeGoPid + killStaleBridgeGo
// ---------------------------------------------------------------------------

test("isBridgeGoPid: false for a node process and for garbage input", () => {
	assert.equal(isBridgeGoPid(process.pid), false);
	assert.equal(isBridgeGoPid(0), false);
	assert.equal(isBridgeGoPid(-1), false);
	assert.equal(isBridgeGoPid(Number.NaN), false);
});

test("killStaleBridgeGo: kills a spawn we own", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
		stdio: "ignore",
	});
	try {
		await new Promise((resolve) => child.on("spawn", resolve));
		assert.ok(child.pid > 0);
		assert.equal(killStaleBridgeGo(child.pid), true);
		const exited = await Promise.race([
			new Promise((resolve) => child.on("exit", () => resolve(true))),
			delay(5000).then(() => false),
		]);
		assert.equal(exited, true, "stale process should be gone within 5s of the kill");
	} finally {
		if (child.exitCode === null && !child.killed) child.kill();
	}
});
