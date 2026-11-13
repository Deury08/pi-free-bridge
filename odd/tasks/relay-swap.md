# Relay swap: one current binary, one previous, one version everyone reads

Branch `feat/relay-swap`, cut from `master` @ `f813d9a` (0.5.1). The old scheme
named the binary after the release tag (`relay-linux-x64.v0.4.0`), so "rolling
back" meant guessing which old file to run and nothing recorded what actually
worked.

## Specs

S1. Layout, and nothing else in the directory:

```
bin/relay-linux-x64          the running binary, no version in the name
bin/relay-linux-x64.prev     the previous one, for rollback only
bin/relay-linux-x64.tmp      transient, only while a download is being placed
```

"Never more than those two plus a transient .tmp. `.prev` is overwritten on each
successful update."

S2. The relay reports its own version: a `version` field in `/health`, read from
`package.json` so there is one source of truth, and baked into the compiled
binary at build time (`--define BUILD_VERSION='"x.y.z"'`, measured to survive
`bun build --compile`). This is what makes mismatch detection possible for a
relay the extension did NOT install: someone running `bun relay.mjs`, an old
binary on PATH, a copied file.

S3. Update sequence, identical on every platform — no special case for Linux's
rename-while-running, because the relay restarts anyway:

1. download to `.tmp` and verify SHA256SUMS — nothing else is touched yet, so a
   bad download never leaves the relay down
2. stop the relay using the `pid` that `/health` already returns, with a timeout
3. if the running relay cannot be stopped in that timeout: abort, change
   nothing, say so
4. delete the old `.prev`, rename current -> `.prev`, rename `.tmp` -> current
5. start it and poll `/health`
6. if it does not answer: ASK the user — wait the same timeout again, or roll
   back. If nobody answers, roll back on your own rather than waiting forever.
   Rollback reverses the renames and starts `.prev` again.
7. after a rollback, DELETE the binary that failed and append one line to
   `bin/failed.log` with the version and the reason. Do not delete the evidence
   with the binary.

S4. Invariant, stated in the code: whatever is named `current` has answered
`/health` at least once, and so has `.prev`. A version that fails is never kept,
so `.prev` is always a known-good build. With no `.prev` (first install) there
is nothing to roll back to: report a clean failure and leave nothing installed.

S5. Mismatch check: the extension compares the relay's `/health` version against
a minimum it requires and, when it is lower, says so plainly ("el relay que
corre es X, esta extensión necesita Y") instead of surfacing a bare 404 from
`/models`.

S6. Tests: the swap sequence with a fake binary (success, failure-then-rollback,
failure-with-no-prev, unresponsive-relay-abort), the `failed.log` line, and
version parsing from `/health`. Nothing is ever spawned on port 8788.

S7. Constraints unchanged: no wire changes, no touching
`resolveWireMode`/`resolveWarpMode`, nothing on the live relay.

## Tasks

| ID | Spec | Route | State |
|----|------|-------|-------|
| T1 | S2 | inline | done — commit `ad35cf0` |
| T2 | S1, S3, S4 | inline | done — commit `ad35cf0` |
| T3 | S3, S6 | inline | done — commit `ad35cf0` |
| T4 | S3, S6 | inline | done — commit `ad35cf0` |
| T5 | S5 | inline | done — commits `ad35cf0`, `8bae10b` |
| T6 | S1 | inline | done — commit `ad35cf0` (the old versioned-name helper and `restartRelayWithConfiguredBin` are gone) |
| T7 | S5 | inline | done — commit `5ed4c62` |

## Log

L1 (owner design, relayed verbatim in the request): the layout, the
`/health` version, the seven-step sequence, the invariant, the mismatch check
and the test list above. Constraints: "no wire changes, no touching
resolveWireMode/resolveWarpMode, nothing on the human's live relay".

L2 (decision — migration): existing installs have `bin/relay-linux-x64.v0.4.0`
and a `relayBin` path in the bridge config. On the first new-scheme update that
versioned file IS the thing that answered `/health`, so it is treated as
`current` and renamed to `.prev` instead of being orphaned. Without this the
first update would have no rollback target even though a known-good binary was
right there.

L3 (decision — no-prev failure): the spec says "leave nothing installed". So the
failed `current` is removed, the config keeps pointing wherever it pointed
before, and an older binary that the config already names keeps working. That is
a clean failure, not a broken install.

L4 (decision — failed.log format): one line per failure,
`<ISO-8601>\t<version>\t<reason>`, appended. Written on both failure shapes
(rollback and no-prev), because in both the binary failed to answer and the log
is the only record of which build it was.

L5 (measured): `bun build --compile --define 'BUILD_VERSION="9.9.9"'` produces a
binary that prints `9.9.9`, so the version can be baked with one source of truth
(`package.json`) instead of being copied into `relay.mjs`.

L6 (slice boundary): `ad35cf0` is 420 authored lines (code + tests) in one
commit, past the ~400-line review unit. It was NOT split, and the reason is in
the feature itself: the swap writes `failed.log` with a version and the mismatch
message compares versions, so the two halves depend on the same new `version`
field. Splitting them would ship a commit whose tests fail on their own. Read it
as one unit: version first (relay.mjs + workflow), then the swap (index.ts), then
the tests that use both.

L7 (dead code removed with the rewire): `relayBinaryFilename` and
`restartRelayWithConfiguredBin` had no callers left once the installer used the
swap, so they are gone rather than left to describe the old design.

L8 (verified, not assumed): a compiled binary reports the baked version —
`bun build --compile --target=bun-linux-x64 --define BUILD_VERSION=0.5.1`
then `GET /health` answered `"version":"0.5.1"`. From source under Node the
fallback path had to use `fileURLToPath` because `import.meta.dir` is Bun-only;
without it the suite saw `unknown`, which is exactly the state the mismatch
check must not accept.
