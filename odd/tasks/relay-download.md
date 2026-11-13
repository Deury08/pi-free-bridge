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

- T1 — S1, S2, S3 — command surface + flat menu, one shared `runWarpRecycle` — commit 1
- T2 — S4, S5, S6, S10 — downloader with checksum verify, atomic swap, rollback — commit 2
- T3 — S7 — checksum parser/verifier test, asset-mapping test, mismatch-refused test; suite stays 194 — commit 1 and 2
- T4 — S8 — README Spanish section — commit 2

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
