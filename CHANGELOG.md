# CHANGELOG

> Archived history from the GitHub releases (they were removed in 2026-11-02 —
> `pi install` pulls this repository directly from `master`, so binary releases
> were no longer needed). Content is verbatim from the GitHub release bodies.

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
