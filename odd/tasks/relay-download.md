# relay-download — three commands plus a flat menu, and a relay binary that downloads itself

Feature branch `feat/relay-download`, cut from `feat/relay-release` at `e648a8a`.
Two work-unit commits: (1) command surface + menu, (2) downloader. Tests and docs ride with the unit they cover.

## Specs

**S1 — Command surface.** Exactly three commands are registered: `/free-bridge` opens the menu and takes **no arguments**; `/free-bridge-warp-recycle` is direct, for incidents, and is **also a menu item**; `/free-bridge-doctor` is **direct only, NOT in the menu**. Unregistered: `free-bridge-session`, `free-bridge-refresh`, `free-bridge-models`, `free-bridge-warp`, `free-bridge-wire`. No aliases at all — "aliases still appear in autocomplete, which is the whole problem".

**S2 — Menu order, dictated by the human, do not reorder:**
1. `Instalar / actualizar relay`
2. `Estado del relay`
3. `WARP: on / off`
4. `Reciclar WARP`
5. `Cable: v1 / v2`
6. `Modelos`
7. `Refrescar sesión`

**S3 — Menu shape.** Flat, no nested submenus. Toggles show current state and switch on select. Recycle and its command call ONE shared `runWarpRecycle(ctx)` — "duplicated logic is a defect".

**S4 — Downloader, mirroring `ensureWarpWithPrompt`.** Nothing at Pi startup, ever. When the relay must start and neither a binary nor Bun is available, ask yes/no and say what will be downloaded. If Bun exists, keep using it — "existing users notice nothing". Store under `~/.pi/agent/pi-free-bridge/bin/` with the version in the filename so rollback is just running the previous file. Verify the published SHA256SUMS before executing; refuse on mismatch. Update = download to temp → verify → atomic swap → restart → poll `/health` → roll back to the previous binary if health does not come up.

**S5 — Update safety.** Never update silently and never mid-request: "the prompt must say it restarts the relay".

**S6 — Real assets from run 43328430977 (v0.4.0).** `relay-windows-x64.exe`, `relay-linux-x64`, `relay-linux-arm64`, `relay-darwin-x64`, `relay-darwin-arm64`, plus `SHA256SUMS`. Platform detection must map to exactly those names.

**S7 — Tests (test-first where it applies).** One unit test for the checksum parser/verifier, one for the asset-name platform mapping, one proving a mismatch is refused. Existing suite must stay at **194 pass**.

**S8 — Docs.** README section in Spanish with the menu, the three commands, and this honest sentence: the checksum proves the download arrived intact, not that whoever published it was trustworthy.

**S9 — Untouchables.** Do not touch the wire headers, the `<env>` block, the `tools` array, `resolveWireMode`/`resolveWarpMode`, or the relay on port 8788.

**S10 — Packaging.** If `package.json` gains a module, add it to the `files` allowlist.

## Tasks

- [x] T1 — S1, S2, S3 — command surface + flat menu, one shared `runWarpRecycle` — `395201b`
- [x] T2 — S4, S5, S6 — downloader with checksum verify, atomic swap, rollback — commit 2
- [x] T3 — S7 — checksum parser/verifier, asset mapping, mismatch-refused, plus a
      registration test pinning S1; suite 194 -> 201 pass — commit 2
- [x] T4 — S8 — README Spanish section, and every stale reference to a removed
      command rewritten — commit 2
- [x] T5 — S10 — n/a: no new module was added, so the `files` allowlist is
      unchanged. The pure helpers live in `index.ts` and are exported, which is
      how this repo already exposes them (the suite imports `../index.ts`).

## Slice boundaries

`395201b` — slice 1: command surface and menu (`index.ts`, 393 authored lines).

## Log

L1 (the request as received, verbatim):

> Next feature, authorized by the human already ("armamos todo", plus a detailed menu design they dictated line by line). Branch `feat/relay-download` from `feat/relay-release` (not from master — the download feature builds on the release branch's docs). Keep the change under ~400 authored lines per slice; split into two commits if it grows: (1) the menu, (2) the downloader.
>
> SPEC A — command surface. The human wants fewer entries in Pi's autocomplete. Exactly three commands get registered:
>   /free-bridge                  opens the menu, takes NO arguments (they explicitly rejected argument forms)
>   /free-bridge-warp-recycle     direct, for incidents, ALSO a menu item
>   /free-bridge-doctor           direct only, NOT in the menu
> Unregister: free-bridge-session, free-bridge-refresh, free-bridge-models, free-bridge-warp, free-bridge-wire. No aliases — aliases still appear in autocomplete, which is the whole problem.
>
> Menu order, dictated by the human, do not reorder:
>   1. Instalar / actualizar relay
>   2. Estado del relay
>   3. WARP: on / off
>   4. Reciclar WARP
>   5. Cable: v1 / v2
>   6. Modelos
>   7. Refrescar sesión
> Flat, no nested submenus. Toggles show current state and switch on select. Recycle and its command call ONE shared `runWarpRecycle(ctx)` — duplicated logic is a defect.
>
> SPEC B — the downloader. Mirror the existing `ensureWarpWithPrompt`: nothing at Pi startup, ever. When the relay must start and neither a binary nor Bun is available, ask yes/no and say what will be downloaded. If Bun exists, keep using it — existing users notice nothing. Store under ~/.pi/agent/pi-free-bridge/bin/ with the version in the filename so rollback is just running the previous file. Verify the published SHA256SUMS before executing; refuse on mismatch. Update = download to temp → verify → atomic swap → restart → poll /health → roll back to the previous binary if health does not come up. Never update silently and never mid-request: the prompt must say it restarts the relay.
>
> REAL ASSETS from run 43328430977 (v0.4.0): relay-windows-x64.exe, relay-linux-x64, relay-linux-arm64, relay-darwin-x64, relay-darwin-arm64, plus SHA256SUMS. Platform detection must map to exactly those names.
>
> TESTS (test-first where it applies): a unit test for the checksum parser/verifier, one for the asset-name platform mapping, and one proving a mismatch is refused. Existing suite must stay at 194 pass.
>
> DOCS: README section in Spanish with the menu, the three commands, and one honest sentence: the checksum proves the download arrived intact, not that whoever published it was trustworthy.
>
> Constraints unchanged: do not touch the wire headers, the `<env>` block, the `tools` array, resolveWireMode/resolveWarpMode, or the relay on port 8788. If `package.json` gains a module, add it to the `files` allowlist. Report which spec items you covered and the commits when done.

L2 (evidence, authorization): the peer session recorded the menu design in
`odd/tasks/relay-standalone-release.md` under "Menu design (agreed with the
owner, not yet implemented)", including the verbatim seven-item order and the
recorded trade-off that `/free-bridge recycle` by argument is rejected. That
file change was uncommitted in the shared worktree when this feature branch was
cut; this session left it untouched.

L3 (state at cut): `feat/relay-release` is pushed at `e648a8a` and release
`v0.4.0` is published (run 43328430977, success, 5 binaries + SHA256SUMS).

L4 (implementation decisions, slice 1 — `395201b`):

- The three surviving commands register in this order: `free-bridge`,
  `free-bridge-warp-recycle`, `free-bridge-doctor`. The menu declares neither
  `args` nor `argumentHint`, which is what keeps it argument-free in
  autocomplete.
- `runWarpRecycle(ctx)` is one body with two callers (menu item 4 and the
  direct command). Its "warp is off" advice was rewritten to point at the menu
  item, since `/free-bridge-warp auto` no longer exists.
- Menu items 3 and 5 carry the current state in their label (`— ahora: auto`,
  `— ahora: v1`), so a toggle is never a guess. Both refuse to pretend when
  `PI_FREE_BRIDGE_WARP_MODE` or `RELAY_WIRE_MODE` pins the value.
- Menu item 7 `Refrescar sesión` maps to the old `free-bridge-refresh` body
  (re-fetch the live free-model list, persist it, re-register the provider).
  Setting a session id by hand is no longer reachable; the relay resolves it
  and «Estado del relay» reports which one and from where.
- Fallback when Pi exposes no `ctx.ui.select`: a numbered confirmation chain,
  so the menu is not a dead end on a minimal UI.

L5 (implementation decisions, slice 2):

- S10 does not apply. The pure helpers (`relayAssetName`, `parseChecksums`,
  `verifyRelayChecksum`, `relayBinaryFilename`) are exported from `index.ts`
  instead of a new module, matching how this repo already exposes testable
  helpers — the suite imports `../index.ts` and calls them through the module
  namespace. No new file means no `files` allowlist change.
- A configured binary wins over Bun in `startRelay`; `relayBin` is only ever
  set by an explicit install, so an existing Bun install behaves exactly as
  before. That is how "existing users notice nothing" is enforced rather than
  promised.
- The download happens only from menu item 1, after `ctx.ui.confirm`. The
  relay start path has no `ctx`, so a prompt there is not architected; its
  failure message now names the menu item instead of a removed command.
- Verification is a refusal, not a warning: digest mismatch AND an asset
  absent from `SHA256SUMS` both refuse, because an unlisted binary cannot be
  verified.
- Install is atomic: written to the temp dir, `chmod` if not Windows, then
  renamed onto the versioned target. The version lives in the filename, so
  rollback runs the previous file rather than restoring a copy.
- Rollback restores the previous `relayBin` (or none, meaning Bun), restarts,
  and reports honestly when even the rollback does not come up. The failed
  binary is left on disk and named in the message; nothing is deleted.
- RED was observed, not assumed: against `395201b` (index.ts without the
  downloader) the six new download tests fail with `is not a function`; after
  the change the suite is 201 pass, 0 fail. Baseline 194 preserved.
- Runtime proof for S1: the extension's default export was driven with a stub
  `pi` and registered exactly `free-bridge`, `free-bridge-warp-recycle`,
  `free-bridge-doctor`. That assertion is committed as a test.
