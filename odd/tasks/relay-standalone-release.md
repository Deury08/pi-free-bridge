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
