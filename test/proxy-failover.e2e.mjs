// End-to-end proof of the proxy failover and force paths
// (odd/tasks/proxy-failover.md T6, S1, S2-S4, S8, S11, S12).
//
// Run under Bun (the relay is a Bun process):  bun test/proxy-failover.e2e.mjs
//
// Three scenarios share one mock CONNECT-style proxy:
//   1. failover — the direct host (`direct.invalid`) never resolves, so the
//      relay can only answer through the proxy.
//   2. forced   — direct is genuinely healthy, yet the pool is preferred, and
//      the proxy hit counter proves the request went through it. This is the
//      e2e hook: the proxy path is exercised without burning the free quota.
//   3. direct   — no proxy configured; behavior must be the pre-feature one.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = join(here, "..", "relay.mjs");
const payload = "data: {\"choices\":[{\"delta\":{\"content\":\"proxied-ok\"}}]}\n\ndata: [DONE]\n\n";

const failures = [];
const check = (label, condition) => {
	console.log(`${condition ? "ok" : "FAIL"} - ${label}`);
	if (!condition) failures.push(label);
};

/** Boot a relay and resolve once it prints the startup line. */
async function startRelay(port, env) {
	const child = spawn("bun", [relayPath], {
		env: { ...process.env, PORT: String(port), ...env },
		stdio: ["pipe", "pipe", "inherit"],
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`relay on ${port} did not start`)), 8000);
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return child;
}

/** The SSE-ish POST both scenarios use. */
function post(port, headers = {}) {
	return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
	});
}

/** A real upstream answer, so `direct` is healthy when it is reachable. */
const upstream = createServer((req, res) => {
	req.on("data", () => {});
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(payload);
	});
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const healthyUpstream = `http://127.0.0.1:${upstream.address().port}/v1`;

let proxyHits = 0;
const proxy = createServer((req, res) => {
	proxyHits += 1;
	req.on("data", () => {});
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(payload);
	});
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

// ---------------------------------------------------------------------------
// Scenario 1 — failover: direct is unreachable, the pool answers.
// ---------------------------------------------------------------------------

const failoverPort = 8799;
let relay;
try {
	relay = await startRelay(failoverPort, {
		RELAY_SESSION: "ses_e2e_proxy_failover",
		RELAY_UPSTREAM: "http://direct.invalid/v1",
		RELAY_PROXY_STATIC: proxyUrl,
		RELAY_PROXY_TIMEOUT_MS: "3000",
	});

	const first = await post(failoverPort);
	const firstBody = await first.text();
	check("fallback: the proxy answered after direct failed (S2, S4)", first.status === 200);
	check("fallback: the body is piped through unchanged (S8)", firstBody === payload);
	check("fallback: the proxy was actually used", proxyHits === 1);

	const second = await post(failoverPort);
	await second.text();
	check("sticky: the next request reuses the healthy proxy (S3)", second.status === 200 && proxyHits === 2);

	const report = await (await fetch(`http://127.0.0.1:${failoverPort}/proxies`)).json();
	const byCandidate = new Map((report.candidates ?? []).map((entry) => [entry.candidate, entry]));
	check("test mode: the diagnostic endpoint answers (S11)", report.service === "pi-free-bridge-relay");
	check("test mode: the live proxy is reported ok (S11)", byCandidate.get(proxyUrl)?.ok === true);
	check("test mode: direct is reported dead (S11)", byCandidate.get("direct")?.ok === false);
	check(
		"test mode: the exposed preference is the sticky proxy (S3, S11)",
		Array.isArray(report.preference) && report.preference.length === 1 && report.preference[0] === proxyUrl,
	);
} catch (err) {
	check(`failover scenario completed: ${err?.message ?? err}`, false);
} finally {
	relay?.stdin.end();
	relay?.kill();
}

// ---------------------------------------------------------------------------
// Scenario 2 — forced pool: direct is healthy, yet the proxy serves it (S12).
// ---------------------------------------------------------------------------

const forcedPort = 8803;
try {
	relay = await startRelay(forcedPort, {
		RELAY_SESSION: "ses_e2e_forced_proxy",
		RELAY_UPSTREAM: healthyUpstream,
		RELAY_PROXY_STATIC: proxyUrl,
		RELAY_PROXY_FORCE: "1",
	});

	const hitsBefore = proxyHits;
	const forced = await post(forcedPort);
	const forcedBody = await forced.text();
	check("forced: the request still succeeds (S12)", forced.status === 200 && forcedBody === payload);
	check("forced: the proxy served it although direct was healthy (S12)", proxyHits === hitsBefore + 1);

	const health = await (await fetch(`http://127.0.0.1:${forcedPort}/health`)).json();
	check("forced: health reports the forced flag (S12)", health.proxyForced === true);
	check("forced: health names the proxy as the last egress (S12)", health.lastEgress === proxyUrl);
} catch (err) {
	check(`forced scenario completed: ${err?.message ?? err}`, false);
} finally {
	relay?.stdin.end();
	relay?.kill();
}

// ---------------------------------------------------------------------------
// Scenario 3 — per-request override: no config, just the header (S12).
// ---------------------------------------------------------------------------

const headerPort = 8805;
try {
	relay = await startRelay(headerPort, {
		RELAY_SESSION: "ses_e2e_header_force",
		RELAY_UPSTREAM: healthyUpstream,
		RELAY_PROXY_STATIC: proxyUrl,
	});

	const plain = await post(headerPort);
	await plain.text();
	const hitsAfterPlain = proxyHits;
	check("header: without the header the request stays direct (S2)", plain.status === 200);

	const forcedByHeader = await post(headerPort, { "x-free-bridge-force-proxy": "1" });
	const body = await forcedByHeader.text();
	check("header: the override sends one request through the pool (S12)", forcedByHeader.status === 200 && body === payload);
	check("header: the override really used the proxy (S12)", proxyHits === hitsAfterPlain + 1);
} catch (err) {
	check(`header scenario completed: ${err?.message ?? err}`, false);
} finally {
	relay?.stdin.end();
	relay?.kill();
}

// ---------------------------------------------------------------------------
// Scenario 4 — no proxy configured: the plain direct path (S1).
// ---------------------------------------------------------------------------

const directPort = 8801;
try {
	relay = await startRelay(directPort, {
		RELAY_SESSION: "ses_e2e_direct_only",
		RELAY_UPSTREAM: healthyUpstream,
		RELAY_PROXY_STATIC: "",
		RELAY_PROXY_SOURCE: "",
	});

	const response = await post(directPort);
	const text = await response.text();
	check("no proxy configured: the direct path still works unchanged (S1)", response.status === 200);
	check("no proxy configured: the body is piped through unchanged (S1)", text === payload);
} catch (err) {
	check(`direct-only scenario completed: ${err?.message ?? err}`, false);
} finally {
	relay?.stdin.end();
	relay?.kill();
	upstream.close();
	proxy.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall proxy-failover checks passed");
process.exit(0);
