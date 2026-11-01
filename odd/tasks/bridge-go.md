# bridge-go — minimal Go egress bridge for OpenCode free tier

> Branch: `invest/bun-comparison` (based on `feat/proxy-failover`)
> Spec doc for implementing a native Go binary that replaces the Bun relay.
> No Bun dependency; self-contained static binary per platform.

---

## Specs

**S1** Transport: HTTP client that passes OpenCode free-tier gate.
- S1.1 Use `refraction-networking/utls` with exact Bun ClientHello (`bunClientHello` from opencode2api):
  - BoringSSL cipher suites (17), X25519MLKEM768 first key share, ALPN only `http/1.1`.
- S1.2 Header ordering/canonicalization matching Bun fetch (`BunTransport` from opencode2api).
- S1.3 UA strings per lane:
  - v2 `/inference`: `opencode/latest/2.1.1/cli`
  - v1 `/zen`: `opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`

**S2** Gate contract (port from `relay.mjs`):
- S2.1 Inject `<env>\nWorking directory: <cwd>\n</env>` as system prompt prefix.
- S2.2 Inject `read` tool (gate requirement) and alias client tools to `bridge_*` with collision suffixes.
- S2.3 Session affinity: synthetic `ses_<hex>` per auth holder, TTL 30 min, sent on `x-opencode-session` family headers.
- S2.4 Stream handling: SSE passthrough for streaming; aggregate to single JSON for non-streaming.
- S2.5 Error semantics: real upstream 429 → `rate_limit_error`; param errors → 400; auth → 401/403; stream faults → 502 `upstream_stream_error`. Never mask as fake quota.

**S3** Smart egress chain (user-designed fallback):
- S3.1 **Local IP first**: attempt request via local interface (plain `http.Transport` with S1.1–S1.3).
- S3.2 On **local 429 (rate_limit_error)** or **local 503 with upstream body** → mark local IP cooldown 30 min, proceed to WARP.
- S3.3 On **local network error** (dial timeout, TLS failure, no route) → treat as firewall/red local, proceed to WARP without cooldown.
- S3.4 **WARP pool** (opt-in, config `warp.enabled`):
  - S3.4.1 Use `gvisor.dev/gvisor` netstack + `golang.zx2c4.com/wireguard/device` (userspace, no root/TUN).
  - S3.4.2 Pool size configurable (default 2), each exit = distinct /64 IPv6.
  - S3.4.3 Acquire lease per attempt; release on body close; `Fail(lease, reason)` on transport/first-event timeout → exit cooldown 30 min.
  - S3.4.4 Upstream 429/403 on exit → exit cooldown 30 min, rotate to next exit.
  - S3.4.5 Exhausted pool (all exits cooldown/failed) or registration failure (UDP 2408 blocked) → proceed to S3.5.
- S3.5 **Local IP with backoff**: retry local IP after WARP exhaustion, respecting local cooldown from S3.2.
- S3.6 If both local (cooled) and WARP (exhausted) fail → return last error (503 if upstream, 502 if transport).

**S4** CLI / Config / Delivery:
- S4.1 `bridge-go` binary: `bridge-go -config config.json` (listen addr, upstream URL, warp block).
- S4.2 Config schema (subset of opencode2api + egress chain):
  ```json
  {
    "listen": "127.0.0.1:8788",
    "upstream": "https://opencode.ai/inference/v1",
    "egress": {
      "strategy": "local_warp_local",
      "local_cooldown_minutes": 30,
      "warp": { "enabled": true, "pool_size": 2, "stack": "ipv6" }
    },
    "retry": { "max_attempts": 6 },
    "health_path": "/health"
  }
  ```
- S4.3 Health endpoint: `GET /health` → `{ok:true, sessionId:"ses_...", localCooldown:false, warpPoolSize:2, warpActive:1}`.
- S4.4 Cross-compile targets: `windows/amd64`, `windows/arm64`, `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`.
- S4.5 Release workflow: GitHub Actions matrix → zips + `checksums.txt`; Pi package `postinstall` downloads matching binary.
- S4.6 License: MIT (vendor `internal/httpx` + `internal/warp` from opencode2api with attribution).

**S5** Pi integration (no code change in Pi):
- S5.1 `pi-free-bridge` installs `bridge-go` binary to `node_modules/.bin/`.
- S5.2 Provider `oc-sdk-zen` points to `http://127.0.0.1:8788/v1`.
- S5.3 `/free-bridge-doctor` checks binary presence + `/health` OK; Bun relay stays as documented fallback.

---

## Tasks

| ID | Spec | Route | Description |
|----|------|-------|-------------|
| T1 | S1.1–S1.3 | inline | Vendor `internal/httpx` (bun_dial.go, bun.go, client.go) from opencode2api with MIT notice. Unit test: ClientHello matches captured Bun pcap. |
| T2 | S2.1–S2.5 | inline | Implement gate contract: prompt injector, tool aliaser, session manager, SSE handler, error mapper. Unit tests per rule. |
| T3 | S3.1–S3.3 | inline | Local-first transport with cooldown state (in-memory map `ip -> cooldownUntil`). Distinguish network error vs upstream 503. |
| T4 | S3.4 | inline | Vendor `internal/warp` (pool, registrar, exit, freebind_*). Wire into egress chain behind strategy flag. |
| T5 | S3.5–S3.6 | inline | Fallback coordinator: attempt sequence Local→WARP→Local with cooldown respect; configurable `max_attempts`. |
| T6 | S4.1–S4.3 | inline | CLI flags, config parsing, `/health` endpoint, graceful shutdown. |
| T7 | S4.4–S4.5 | CI | GitHub Actions release matrix (6 targets), zips, checksums, registry.json. |
| T8 | S4.6 | inline | LICENSE + NOTICE with opencode2api attribution. |
| T9 | S5.1–S5.3 | inline | Update `pi-free-bridge` package.json `postinstall` to fetch binary; update `relay.mjs` as fallback doc; doctor endpoint. |
| T10 | — | verify | End-to-end: Pi → bridge-go → OpenCode free tier (deepseek-v4.1-flash-free) returns 200. Load test: 50 concurrent, verify egress chain rotation on injected 429. |

---

## Log

L1: User request — "quiero que habras una branch para investigar algo" → created `invest/bun-comparison`.
L2: Investigated oc2cpa (obsolete) and opencode2api (working uTLS bypass). Live proof: Go+uTLS = 200, Go plain = 429, Bun = 200.
L3: Confirmed OpenCode runs on Bun in all channels; npm package is just installer for Bun binaries.
L4: User insight: "lo realmente bueno es no atarnos a bun seria poder hacer las peticiones directas desde pi... la idea principal seria no depender de bun aunque lo dejemos".
L5: User designed smart egress chain: Local IP → (429/503) → WARP pool → (exhausted) → Local with backoff. Proxies path failed per other agent.
L6: This spec written to capture S1–S5 and T1–T10 for implementation when authorized.
