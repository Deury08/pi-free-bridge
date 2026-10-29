// End-to-end proof of the proxy failover path (odd/tasks/proxy-failover.md T6).
//
// Run under Bun (the relay is a Bun process):  bun test/proxy-failover.e2e.mjs
//
// The direct host (`direct.invalid`) never resolves, so attempt #1 always fails.
// The mock proxy ignores the target and answers with a fake SSE payload, so the
// relay can only succeed through the proxy. That isolates exactly the behavior
// the feature adds: direct-first, fall back to the pool, pipe the answer back.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = join(here, "..", "relay.mjs");
const payload = "data: {\"choices\":[{\"delta\":{\"content\":\"proxied-ok\"}}]}\n\ndata: [DONE]\n\n";

let proxyHits = 0;

const proxy = createServer((req, res) => {
	proxyHits += 1;
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(payload);
	});
});

await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const port = 8799;
const relay = spawn("bun", [relayPath], {
	env: {
		...process.env,
		PORT: String(port),
		RELAY_SESSION: "ses_e2e_proxy_failover",
		RELAY_UPSTREAM: "http://direct.invalid/v1",
		RELAY_PROXY_STATIC: proxyUrl,
		RELAY_PROXY_TIMEOUT_MS: "3000",
	},
	stdio: ["pipe", "pipe", "inherit"],
});

const failures = [];
const check = (label, condition) => {
	console.log(`${condition ? "ok" : "FAIL"} - ${label}`);
	if (!condition) failures.push(label);
};

try {
	// Wait for the startup line so the first POST cannot race the listener.
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("relay did not start")), 8000);
		relay.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});

	const post = () =>
		fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});

	const first = await post();
	const firstBody = await first.text();
	check("fallback: the proxy answered after direct failed (S2, S4)", first.status === 200);
	check("fallback: the body is piped through unchanged (S8)", firstBody === payload);
	check("fallback: the proxy was actually used", proxyHits === 1);

	const second = await post();
	await second.text();
	check("sticky: the next request reuses the healthy proxy (S3)", second.status === 200 && proxyHits === 2);

	// S11: the test mode reports reachability for every configured candidate.
	const probe = await fetch(`http://127.0.0.1:${port}/proxies`);
	const report = await probe.json();
	const byCandidate = new Map((report.candidates ?? []).map((entry) => [entry.candidate, entry]));
	check("test mode: the diagnostic endpoint answers (S11)", probe.status === 200);
	check("test mode: the live proxy is reported ok (S11)", byCandidate.get(proxyUrl)?.ok === true);
	check("test mode: direct is reported dead because its host does not resolve (S11)", byCandidate.get("direct")?.ok === false);
	check(
		"test mode: the exposed preference is the sticky proxy the relay is using (S3, S11)",
		Array.isArray(report.preference) && report.preference.length === 1 && report.preference[0] === proxyUrl,
	);
} catch (err) {
	check(`e2e completed without error: ${err?.message ?? err}`, false);
} finally {
	relay.stdin.end();
	relay.kill();
	proxy.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// S1: with no proxy configured the relay takes the plain direct path.
// ---------------------------------------------------------------------------

const upstream = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(payload);
	});
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const directPort = 8801;
const directRelay = spawn("bun", [relayPath], {
	env: {
		...process.env,
		PORT: String(directPort),
		RELAY_SESSION: "ses_e2e_direct_only",
		RELAY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1`,
		RELAY_PROXY_STATIC: "",
		RELAY_PROXY_SOURCE: "",
	},
	stdio: ["pipe", "pipe", "inherit"],
});

try {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("direct relay did not start")), 8000);
		directRelay.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});

	const response = await fetch(`http://127.0.0.1:${directPort}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
	});
	const text = await response.text();
	check("no proxy configured: the direct path still works unchanged (S1)", response.status === 200);
	check("no proxy configured: the body is piped through unchanged (S1)", text === payload);
} catch (err) {
	check(`direct-only scenario completed: ${err?.message ?? err}`, false);
} finally {
	directRelay.stdin.end();
	directRelay.kill();
	upstream.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall proxy-failover checks passed");
process.exit(0);
