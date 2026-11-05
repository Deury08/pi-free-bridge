# CHANGELOG

> Archived history from the GitHub releases (they were removed in 2026-11-02 —
> `pi install` pulls this repository directly from `master`, so binary releases
> were no longer needed). Content is verbatim from the GitHub release bodies.

## Unreleased

- **A targeted swap before the hard rotation**: a WARP `429` is now attributed to
  the exit that served it through the proxy's monotonic `served` counter, and the
  ladder replaces only that exit (`POST /swap`) plus one resend, falling back to
  the pool-wide `/recycle` only when the fresh exit refuses too. One enrollment
  instead of N, no stream cut, and the pool is never left without a healthy exit.
  Attribution is deliberately conservative: a doubtful map means no rotation at
  all rather than a swap aimed at an innocent exit, and the manual command stays
  as the forced escape. A `202` carrying `ok:false` is a refusal and spends
  nothing, a `409`/`404` is a real answer that is not insisted on, and a proxy
  without `/swap` (older binary, or the WireGuard stack answering `501`) is
  detected once, warned once, and the relay keeps rotating. `RELAY_WARP_SWAP=0`
  is the kill switch, `RELAY_WARP_SWAP_COOLDOWN_MS` is the swap's own cool-down
  (shorter than the recycle's, because replacing one exit is much cheaper than
  tearing the pool down), and `RELAY_WARP_SWAP_MIN_RETRY_AFTER_MS` decides how
  short a `retry-after` makes waiting cheaper than enrolling.

- **Manual WARP rotation, by the same path as the automatic one**: new
  `/free-bridge-warp-recycle` command, backed by a loopback `POST /warp/recycle`
  route on the relay. It exists because the only manual recovery a burnt exit had
  was a raw `POST /recycle` straight to the proxy, which skips the drain and tears
  down every stream multiplexed over the tunnel. The command now waits for
  in-flight deliveries, respects the cool-down, confirms the new exit through
  `/health`, and reports streak, recycles, result and remaining cool-down. The
  relay binds `127.0.0.1` only, so the route needs no token.
- **The relay can keep an event log on disk**: `RELAY_LOG_FILE` writes one JSON
  object per line for every WARP decision that costs something — a `429`
  observed, a rotation asked for or refused (with its reason), the resend, the
  local-egress parking, the final delivery. Until now every one of those
  diagnostics went to a pipe the parent drained, so an incident died with the
  turn that hit it. Off by default, rolls at 5 MB keeping one `.1`, and never
  records bodies, headers or prompts.

- **Rotation waits for in-flight WARP deliveries**: `/recycle` replaces the exit,
  and that kills every stream multiplexed over it. A response that already
  passed the gate completes on its own, so the relay now waits until nothing is
  being delivered over WARP before rotating — no clock on that wait, only a
  120s valve for a hung stream (well under Pi's 5-minute idle timeout). The
  `POST /recycle` goes *after* the wait: sending it first tears the tunnel down
  and makes the wait pointless. Only accepted responses (`status < 400`) are
  counted; a request still waiting for headers already gets its own `429` on the
  burnt IP and waiting for it would buy nothing. Both rotation paths wait — the
  resend and the `auto` streak rotation that fires when a warp 429 already fell
  back to a local success — and a client that already left aborts the rotation
  instead of costing every other tenant its retry.

- **Park a rate-limited local egress until its reset**: a `429` on the LOCAL
  egress means that physical IP spent its day and the relay cannot rotate it,
  so it now parks local until `retry-after` (read from that response, plus a 10s
  margin) instead of offering it first turn after turn. Local is
  deprioritised, never excluded — with WARP down the request still egresses
  local and gets its `429` rather than a `502`, and a rejected request costs no
  quota. `off` and `on` are unchanged, `/health` gains `localParkedForMs`, and
  the state is in-memory only.

- **`retry-after` forwarded on upstream errors**: a gate `429` carries the real
  seconds until the quota resets, and the relay used to drop it — only
  `content-type` was forwarded, so the client was left to guess midnight UTC
  (wrong for every other time zone). Status, `content-type` and `retry-after`
  now pass through; every other upstream header still stays upstream.

- **Resend once after a confirmed WARP exit rotation**: a response that would
  deliver a gate `429` now rotates the WARP exit and, only once that rotation is
  confirmed (`recycling` was observed during the poll, or `exits[]` changed
  against the pre-`POST` snapshot — `recycling: false` alone is not proof),
  resends the request exactly once through WARP. Only a non-error resend
  (`status < 400`) is delivered: any refused resend (`429`, `5xx`, other `4xx`
  such as `400`/`401`/`403`) logs its real status and delivers the original
  `429` byte-exact, as do an unconfirmed rotation and a timeout, and only ever
  before the first downstream byte. `off` is untouched (`sawWarp429`
  can never be true there), `/health` gains `warpResends` and
  `warpResendEnabled`, and `RELAY_WARP_RETRY_AFTER_RECYCLE=0` is the kill switch.
  The health path is warp-minimal's own, passed as `RELAY_WARP_HEALTH_PATH` from
  the shared config instead of being hardcoded.

- **`RELAY_WARP_RECYCLE_THRESHOLD` removed**: the recycle meter has exactly one
  correct value — rotate on the first warp-egress 429 — so the knob was dead
  configuration. The relay now rotates on the first observed warp 429; only
  `RELAY_WARP_RECYCLE_COOLDOWN_MS` remains as the burst-tolerance knob. The
  v0.2.0 note below claimed a default of 3; the shipped default was 1.
- **Gate quota model documented**: the free tier meters per egress IP and per
  UTC calendar day (`ipRateLimiter.ts` → `getRetryAfterDay`), returns
  `Retry-After` pointing at the next 00:00 UTC, has no idle decay, and gives a
  double daily allowance to IPs that are still "new"
  (`lifetimeCount < dailyLimit * 7`). Resting a burnt IP frees nothing; rotating
  it to a new one does.

## v0.3.0 — WARP network-error fallback (2026-11-01)

In warp mode "on", when the WARP fetch rejects with a network/socket error (not HTTP 429/403 quota error), fall back to the local egress before the first downstream byte so the client does not get a 502.

- Adds isNetworkError() helper
- Failover never happens after the first byte is delivered

Companion to warp-minimal v0.2.0 (MASQUE → WireGuard migration).

## v0.2.0 — Bun upgrades + WARP hot-reload + auto-recycle (2026-11-01)

### 🎯 Features
- **Hot-reload WARP mode**: `/free-bridge-warp off|auto|on` now applies on the next request **without restarting the relay** — relay pid survives the switch (verified via `/health`).
- **Auto-recycle exit on persistent 429s**: The opencode free gate counts quota per (session, egress IP). The relay counts consecutive warp-egress 429s (local 429s don't count; any success resets) and POSTs `/recycle` to the proxy at threshold (default 3, `RELAY_WARP_RECYCLE_THRESHOLD`) with a 5 min cooldown (`RELAY_WARP_RECYCLE_COOLDOWN_MS`). Degrades gracefully with one warning if `/recycle` not yet exposed by the proxy.
- **Supervisor auto-spawn**: `ensureWarp` falls back to the plugin-folder binary (`~/.pi/agent/pi-free-bridge/warp/warp-minimal.exe`) and passes `-config` automatically. Fixes "no proxy alive" 502 bursts when the proxy dies or Pi starts cold.
- **BOM tolerance**: Config files with UTF-8 BOM (Windows editors) now parse correctly in both relay and extension.
- **Stale-relay release**: Identity-guarded kill of old relays without pid (port-owner cmdline check), never blind.

### 🔧 WARP-minimal v7 alignment
- Multiplexed exits (shared pool, no cap of 2)
- Clean client-abort handling (no cooldown on local disconnect)
- Deadlock fixed (mutex in Acquire)
- Read deadline removed (no silent 30s stream kill)
- Persistent logging (`warp-minimal.log` next to binary) for 502 diagnosis
- `POST /recycle` endpoint for fresh exit IPs

### ✅ Verification
- **53 tests passing** (was 34), covering hot-reload helpers, key logic, auto-recycle streak, BOM tolerance
- E2E: 20/20 streaming SSE via warp, auto-recycle contract ready, supervisor spawns from plugin folder
- Hot-reload: pid stable across `/free-bridge-warp auto` ↔ `off`
- Supervisor: kill proxy → `ensureWarp` spawns from plugin folder → `warp=on`
- BOM config: real user file with BOM now reads correctly

### 📝 Notes
- WARP mode precedence unchanged: `PI_FREE_BRIDGE_WARP_MODE` env > config file > `off`
- 429 in `off` mode delivered byte-exact (no synthetic 502)
- `auto` mode sticky-elevation after warp-only success preserved
- Plugin folder for WARP binary: `~/.pi/agent/pi-free-bridge/warp/`

### 📦 Install
```bash
pi install git:github.com/Deury08/pi-free-bridge#master
```

## v0.1.1 (2026-10-31)

**Full Changelog**: https://github.com/Deury08/pi-free-bridge/compare/v0.1.0...v0.1.1

## v0.1.0 (2026-10-31)

## What's Changed
* feat: route the free tier through a Bun relay and harvest the session locally by @Deury08 in https://github.com/Deury08/pi-free-bridge/pull/1

## New Contributors
* @Deury08 made their first contribution in https://github.com/Deury08/pi-free-bridge/pull/1

**Full Changelog**: https://github.com/Deury08/pi-free-bridge/commits/v0.1.0
