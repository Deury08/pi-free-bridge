// Health-probe classification, retry, and bounded stale-instance recovery for
// bridge-go. Pure/platform helpers exported for `node --test` (same convention
// as relay.mjs); index.ts wires them into startBridgeGo.
//
// Two failures motivated this module (2026-10-31, see
// odd/tasks/bridge-go-health-recovery.md):
//
// 1. A fresh binary may answer slower than one 750 ms window (Windows AV
//    cold-start of a first-run exe), so a single probe is fragile.
// 2. main.go logs its "listening on" line before ListenAndServe binds, so a
//    stale hung pi-free-bridge instance from a previous session makes the new
//    child print the line and immediately exit on a bind error — the launcher
//    then probes the hung zombie and gets nothing. The stale owner must be
//    identified and killed before restarting.
import { execFileSync } from "node:child_process";

/** How many times the post-listen health probe is attempted. */
export const HEALTH_PROBE_ATTEMPTS = 3;

/** Per-attempt fetch timeout in milliseconds. */
export const HEALTH_PROBE_TIMEOUT_MS = 750;

/** Pause between probe attempts in milliseconds. */
export const HEALTH_PROBE_GAP_MS = 500;

export function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Probe `url` expecting the given `service` name in the /health payload.
 *
 *  Returns "healthy" (ok + service match), "foreign" (something answered but
 *  it is not our bridge — treated as conclusive), or "absent" (nothing
 *  answered; retried up to `attempts` times). Single-shot callers pass
 *  `attempts: 1`; the default covers cold-start slowness. */
export async function probeBridgeGoHealth(url, service, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
	const attempts = opts.attempts ?? HEALTH_PROBE_ATTEMPTS;
	const gapMs = opts.gapMs ?? HEALTH_PROBE_GAP_MS;
	assertPositiveInteger("timeoutMs", timeoutMs);
	assertPositiveInteger("attempts", attempts);
	assertPositiveInteger("gapMs", gapMs);

	let result = "absent";
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (attempt > 1) await delay(gapMs);
		result = await probeOnce(url, service, timeoutMs);
		if (result !== "absent") return result;
	}
	return result;
}

function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`probeBridgeGoHealth: ${name} must be a positive integer, got ${value}`);
	}
}

async function probeOnce(url, service, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return "foreign";
		const payload = await res.json();
		return payload?.service === service ? "healthy" : "foreign";
	} catch {
		return "absent";
	} finally {
		clearTimeout(timer);
	}
}

/** Extract a LISTENING pid for a local port from `netstat -ano -p TCP` output.
 *
 *  Exposed for unit tests; findPortListenerPid builds the input. */
export function parseNetstatListener(out, port) {
	for (const line of String(out).split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		// Proto Local Foreign State PID (Windows netstat) — IPv6 rows may drop
		// the Foreign column down to 4 cols; skip anything unexpected.
		if (cols.length < 5 || cols[0] !== "TCP") continue;
		if (cols[3] !== "LISTENING") continue;
		const localPort = Number.parseInt(cols[1]?.match(/:(\d+)$/)?.[1] ?? "", 10);
		const pid = Number.parseInt(cols[4], 10);
		if (localPort !== port || !(pid > 0)) continue;
		return pid;
	}
	return 0;
}

/** PID of whatever is listening on a local port (any local address), or 0 when
 *  nothing is listening or the lookup fails. Best-effort by design: it backs
 *  the bounded stale-instance recovery, never correctness. */
export function findPortListenerPid(port) {
	if (!Number.isInteger(port) || port <= 0 || port >= 65536) return 0;
	try {
		if (process.platform === "win32") {
			const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8", timeout: 5000 });
			return parseNetstatListener(out, port);
		}
		const out = execFileSync("lsof", ["-t", "-i", `TCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 5000 });
		return Number.parseInt(out.trim(), 10) || 0;
	} catch {
		return 0;
	}
}

/** True when `pid` belongs to a running pi-free-bridge process. Guards the
 *  stale-kill: never terminate a port owner we cannot positively identify. */
export function isBridgeGoPid(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		if (process.platform === "win32") {
			const name = execFileSync(
				"powershell",
				["-NoProfile", "-Command", `(Get-Process -Id ${pid}).ProcessName`],
				{ encoding: "utf-8", timeout: 5000 },
			).trim();
			return name === "pi-free-bridge";
		}
		const comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
		return comm.includes("pi-free-bridge");
	} catch {
		return false;
	}
}

/** Kill a stale bridge-go instance (whole tree on Windows). Last-effort: the
 *  window between the identity check and the kill is accepted because the kill
 *  only runs against a pid that was just found listening on OUR reserved port. */
export function killStaleBridgeGo(pid) {
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
		} else {
			process.kill(pid, "SIGKILL");
		}
		return true;
	} catch {
		return false;
	}
}
