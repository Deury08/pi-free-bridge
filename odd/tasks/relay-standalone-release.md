# Relay standalone release

Ship `relay.mjs` as a per-OS binary built by GitHub Actions, so running it
requires neither Bun nor an OpenCode install on the target machine.

## Specs

S1 — «quiero una release que ccompile a cada sistema operativo el relay asi no
se va a necesitar bun». The release artifact is a compiled executable per
target; the target machine must not need Bun, Node, or the Pi extension.

S2 — «creo que tampoco opencode para correr». Running the relay must not require
opencode. It already does not (the session id is generated; nothing shells out),
and the release must keep it that way: no new dependency on an OpenCode install.
The catalog/identity derivation stays optional and degrades to the embedded
defaults when no install is present.

S3 — «esa compilacion e giup ations». GitHub Actions performs the build and
publishes the artifacts.

S4 — The binary must work with no config file present. Today the model list is
read from `~/.pi/agent/pi-free-bridge.json`; a self-contained run needs embedded
defaults. A present config file or env var still overrides them.

S5 — The compiled binary must still pass the gate: same headers, same `<env>`
block, same `tools` array, same Bun TLS fingerprint. Nothing in the release may
change what goes on the wire.

## Tasks

- T1 (S4) — Embed the default model list and add flags/env for port, upstream,
  warp proxy, wire mode and models; config file overrides, embedded default
  answers when absent. relay.mjs + tests.
- T2 (S1, S3) — `.github/workflows/release.yml`: matrix over
  `bun-windows-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`,
  `bun-darwin-arm64`; `bun build --compile --target=…`; upload to a GitHub
  Release on tag `v*`. Commit on branch `feat/relay-release`.
- T3 (S1, S2) — README section: download, run, flags, and an explicit statement
  that neither Bun nor opencode is required.
- T4 (S5) — CI smoke: run the built binary, confirm `/health` answers 200 and
  reports `wireMode`, for the host platform at least.
- T5 — Verify the gate still answers 200 from the compiled binary through warp,
  with a known-good control in the same run.

## Log

L1 (user): «si mergeamos y quiero una release que ccompile a cada sistema
operativo el relay asi no se va a necesitar bun y creo que tampoco opencode para
correr»

L2 (user): «esa compilacion e giup ations»

L3 (assistant, evidence): `master` merged and pushed at `ce7e7e2`; 194 tests.
The relay never depended on opencode. The blocking gap for S4 is the model list
in `~/.pi/agent/pi-free-bridge.json`.

L4 (measured, earlier): the gate accepts both the v1 and the v2 header sets
(answered every turn with `wireMode: v2` and `warp429Streak: 0`). S5 is a
regression guard, not an open question.

L5 (user): «documentacion actualizada siempre ayudando a la persona a instalar
facil, recuerda cada sistema operativo deve instalar bien y facil»

L6 (measured — S4 corrected): `liveIds` appears **zero** times in `relay.mjs`.
The relay never read the model list; that belongs to the Pi extension. Every
setting already has a default (`DEFAULT_PORT`, `DEFAULT_UPSTREAM`, the warp
proxy, a generated session id). **S4's premise was wrong and no embedding is
needed.** T1 was dropped for that reason.

L7 (measured — blocking bug found by running the artifact): the compiled binary
printed "listening" and exited within seconds without answering `/health`.
Cause: the S26 lifetime rule resumes stdin and exits when it closes, which is
right when the extension owns the pipe and wrong for a standalone run.
`RELAY_STDIN_LIFETIME=off` detaches it; the default is unchanged. After the fix
the binary answers `/health` with `sessionSource: "service"` and a generated
`ses_…` id, with no config file present — S2 is now a fact, not an assumption.

L8 (state): `feat/relay-release` holds three commits (254 authored lines):
the spec, the release workflow for five targets, the stdin fix, and the
per-OS README guide. 194 tests pass. The relay wire was not touched.

L9 (state — why it is not pushed): `assess` reports `nativeRisk: "high"`, reason
`shell_source` on `.github/workflows/release.yml`, so the native review is due.
It first stopped with `managed_assets_outdated`; the emitted `gentle-ai sync
--agent pi` was run and succeeded. The retried review reached the START consent
prompt, which was answered **declined** for this candidate
(`lineage_created: false`, `mutation_performed: false`). Nothing was mutated.

L10 (open decision, owner's): the push is blocked by RDD until one of these is
chosen — (a) retry the review and approve the consent prompt, (b) run
`gentle-ai review mode disable` for this repo and push regardless, (c) keep the
branch local. The workflow cannot be exercised at all until a `v*` tag reaches
GitHub, so the review covers the only part of the change with no runtime proof.

L11 (note for whoever resumes): a `v*` tag publishes a public GitHub Release on
Deury08/pi-free-bridge. Creating the tag is a separate publishing decision and
has not been taken.

## Menu design (agreed with the owner, implemented on `feat/relay-download`)

The owner wants fewer entries in Pi's command autocomplete. Seven commands become
three; everything else lives in one flat menu.

Registered commands:
- `/free-bridge` — opens the menu, takes no arguments
- `/free-bridge-warp-recycle` — direct, for incidents, also a menu item
- `/free-bridge-doctor` — direct only, not in the menu

Menu order, exactly as the owner specified:
1. Instalar / actualizar relay
2. Estado del relay
3. WARP: on / off
4. Reciclar WARP
5. Cable: v1 / v2
6. Modelos
7. Refrescar sesión

Rules: flat, no nested submenus. Items that toggle (WARP, Cable) show current
state and switch on select. Recycle and its command call one shared
`runWarpRecycle(ctx)`; duplicating the logic is not acceptable.

Removed from registration: `free-bridge-session`, `free-bridge-refresh`,
`free-bridge-models`, `free-bridge-warp`, `free-bridge-wire`,
`free-bridge-doctor` stays as a command but leaves the menu.

Deliberate trade-off, recorded so it is not re-litigated: `/free-bridge recycle`
by argument is rejected — the owner wants the menu only, no arguments. Recycling
during an incident therefore costs the direct command (kept for exactly that).
