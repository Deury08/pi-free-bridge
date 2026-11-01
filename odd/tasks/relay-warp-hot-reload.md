# Feature: relay-warp-hot-reload

## Objective

The relay picks up WARP mode changes from the persisted config **without any process
restart**, so `/free-bridge-warp off|auto|on` takes effect on the next request — an
organic switch, no relay kill/respawn chain, no stale-relay reuse in this path.

## Problem

- The relay freezes `warpMode` at boot (`relay.mjs:465`: `RELAY_WARP_MODE` env baked at
  spawn). Changing the mode requires killing + respawning the relay
  (`index.ts`, `/free-bridge-warp` handler ~line 1732: `stopRelay()` + `ensureRelay()`).
- That restart chain already produced two live incidents (2026-11-01, ~00:45 and ~01:44):
  stale relays reused without comparing `warpMode`, ports held by old processes, users
  seeing `on` after an explicit `off`, and stuck requests when mode `on` and WARP dead.
- Config file = persisted truth. The relay should breathe it, not snapshot it.

## Why (user intent, verbatim)

User: "al cambiar eso debe cambiar automaticamente… lo correcto es que haga el switch
de manera organica". Restart-on-change is acceptable *only* if invisible; the chosen
design removes the restart entirely.

## Scope

Authorized files:

- `relay.mjs` — hot mode resolution
- `index.ts` — handler simplification + relay key/env changes
- `test/relay.test.mjs` — tests for the new helpers
- `README.md` — behavior section update

Out of scope: warp-minimal itself, session-id resolution, port logic, the stale-relay
release guard (`29c347a`, `11a2a6a`) — keep it; it still protects other restart paths.

## Design

1. **`relayEnv` (index.ts)**: stop always injecting `RELAY_WARP_MODE`.
   Only set it when `process.env.PI_FREE_BRIDGE_WARP_MODE` is a real user override
   (absolute precedence preserved: env wins and then the relay stays static, by design).
   Otherwise omit it so the relay resolves the mode from the config file.
2. **`ensureRelay` (index.ts)**: remove `warpMode` from the relay cache key
   (`port\0sessionId\0warpMode` → `port\0sessionId`). A mode change must NOT churn the
   relay. Keep `ensureWarp()` best-effort call for non-off modes (spawn supervisor).
3. **`relay.mjs`**:
   - New `RELAY_CONFIG_PATH` env (set by the extension from its `BRIDGE_CONFIG_PATH`).
   - New pure helper `resolveWarpModeHot(override, fileValue)` — exported for tests:
     normalized override → normalized file value → `"off"`.
   - In `forward()` (and `/health`), per request: refresh `config.warpMode` by reading
     the config file. Cheap (~1 KB JSON). On any read/parse failure, **keep the last
     known mode and never crash the request** (degrade, don't throw). Optional
     optimization: short mtime cache with a 250 ms TTL; keep it simple first.
4. **`/free-bridge-warp` handler (index.ts)**: write config, ensure warp when needed
   (existing consent flow untouched), then only notify — **remove
   `stopRelay()` + `ensureRelay()`**. The notify text must reflect hot reload
   (e.g. "takes effect on the next request").
5. **`/health`**: continues reporting the *effective* (hot-refreshed) mode, and add
   `warpModeSource: "env" | "config"` so diagnosis stops guessing who set the mode.
6. **README**: `off/auto/on` section — document per-request config read and that env
   override still pins the mode until unset.

## Constraints

- `[Bun]` runtime; no new dependencies; no changes to upstream/gate contract.
- Never fatal on a bad config file — the relay must keep serving with the last mode.
- Keep precedence: `PI_FREE_BRIDGE_WARP_MODE` env > config > `"off"`.
- Do not drop the stale-relay release guard or its identity checks (commits
  `29c347a`, `11a2a6a` land on top of the buggy reuse that made this feature urgent).
- Test-first (RED → GREEN → REFACTOR) for `resolveWarpModeHot` and the key/env logic.

## Checklist

- [x] T1 — `relay.mjs`: pure `resolveWarpModeHot(override, fileValue)` helper + unit
  tests (env wins; valid file value wins; empty/garbage → `"off"`) — *NOT YET STARTED*
- [x] T1 — observed RED for `resolveWarpModeHot` before implementation (helper missing)
- [x] T2 — `relay.mjs`: `RELAY_CONFIG_PATH` env wiring; per-request hot refresh of
  `config.warpMode` (health + forward); read failure keeps last mode
- [x] T3 — `index.ts`: `relayEnv` injects `RELAY_WARP_MODE` only on real env override;
  adds `RELAY_CONFIG_PATH`; `ensureRelay` key drops `warpMode`; key regression tests
- [x] T4 — `index.ts`: `/free-bridge-warp` handler drops restart; notify text updated
- [x] T5 — `index.ts`: `/health` readback gains `warpModeSource`
- [x] T6 — README: modes section documents hot reload + env precedence
- [x] T7 — full checks green; work-unit commits on the feature branch per task

## Verification (commands of record)

- `bun run test` / `node --test test/relay.test.mjs` — must pass in full
- E2E manual check (post-deploy): run `/free-bridge-warp` (no args) → `/health` shows
  current mode; `/free-bridge-warp off` then `/free-bridge-warp` again → mode flips
  with **unchanged relay pid** (proves no restart); `lastEgress` becomes `local`
  on the next request.

## Acceptance criteria

- Mode change via Pi applies on the next request without spawning a new relay.
- Relay pid survives a mode change (checked via `/health` `pid`).
- Env override still absolute; `/health` exposes `warpModeSource` to prove it.
- Malformed/missing config file never crashes or 502s the relay; warns once, keeps last
  mode.
- Full test suite green.

## Coordination notes (for the executing agent)

- Repo base when this plan was written: `11a2a6a` (fix(relay): release pid-less stale
  relay via port-owner identity guard). Branch: commit work units on top of it.
- The user's Pi runs the **installed copy** at
  `~/.pi/agent/git/github.com/Deury08/pi-free-bridge` (currently `0333549a`) — after
  merge, the installed copy must be updated/pulled or the user still sees the bug.
- Two prior incidents documented in Engram: topic `bugs/relay-warp-mode-stale-reuse`
  (obs 3142) — stale relay reused with old warpMode; manual clears of the running
  relay with a config stuck at `on` (~01:44 spawn reading `on`).
- Do not run real `/free-bridge-warp on` against the user's **live config** when
  testing — flip the mode back to `off` you find it in, unless the user asked
  otherwise. The user deactivated WARP and wants it off.
- Feature doc location: `odd/tasks/relay-warp-hot-reload.md` (this file). Update
  checkboxes + parity Engram topic `odd/relay-warp-hot-reload/tasks` after each task.

## Progress

- Plan created 2026-11-01 by orchestrator; author changed lines forecast: ~120
  (relay ~40, index ~35, tests ~35, README ~10). Under one delivery slice.
- Status: READY FOR EXECUTION — no task started.

## Log

- 2026-11-01 (delegated implementation worker): T1–T6 implemented test-first on
  `feat/bun-upgrades` (base `11a2a6a`), no commits (parent owns work-unit commits).
  RED observed for `resolveWarpModeHot` (missing export), `readFileWarpMode`, and
  the `relayEnv`/`relayKey` tests (not functions → then implemented). GREEN:
  `node --test test/relay.test.mjs` 49 pass / 0 fail (was 34). T2: `relay.mjs`
  resolves the mode per request via `RELAY_CONFIG_PATH`;
  `warpModeSource: "env" | "config"` in `/health`; read failure keeps the last
  known mode and warns once. T3: `relayEnv` injects `RELAY_WARP_MODE` only when
  `PI_FREE_BRIDGE_WARP_MODE` is a real override; cache key is `port\u0000sessionId`
  (`relayKey`, exported for tests). T4: `/free-bridge-warp` no longer calls
  `stopRelay()` + `ensureRelay()`; notify says "takes effect on the next request".
  T5: `fetchRelayHealth`/`RelayHealth` parse `warpModeSource` (old relays read as
  undefined, pinned by test). T6: README hot-reload + env-pinning paragraphs.
  T7 verification: `bun run test` (same script) 49/0, `node --test test/smoke.mjs`
  1/0, `node test/gate-tools.mjs` OK; no commits made.
