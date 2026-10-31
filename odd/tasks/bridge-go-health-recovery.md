# bridge-go health recovery

## Objective

`startBridgeGo` no longer fails with `bridge-go started but did not answer /health`
when (a) a freshly spawned binary is slow to answer (Windows AV cold start) or
(b) a stale hung `pi-free-bridge` instance from a previous session keeps holding
the port.

## Problem

- `main.go` logs its "listening on" line **before** `ListenAndServe` binds, so
  when a stale hung instance already owns 8790, the new child prints the line
  and immediately exits with a bind error — while the launcher resolves on the
  printed lie and then probes the hung zombie, getting no answer.
- The post-listen probe is a single 750 ms fetch; a cold antivirus scan of a
  first-run exe can exceed that.

Root cause observed live on this machine on 2026-10-31 (port 8790 held, nothing
listening after the failed session-start).

## Scope

- `index.ts` — `startBridgeGo`, `probeBridgeGo` wiring only.
- New pure/platform helper module `health-recovery.mjs` (follows the
  `relay.mjs` convention: helpers exported for `node --test`).
- `package.json` `files` += `health-recovery.mjs`.

Out of scope: gate/egress changes, Go sources (currently modified by the user
for other work).

## Tasks

- [x] T1: RED tests `test/health-recovery.test.mjs` (probe classification,
      retry, netstat listener pid, pid identity guard, kill).
- [x] T2: `health-recovery.mjs` — GREEN.
- [x] T3: wire retry + bounded stale-kill-and-restart into `startBridgeGo`.
- [x] T4: package.json files entry.
- [x] T5: verify — tests green + E2E stale-instance recovery.
- [x] T6: work-unit commit.

## Route notes

Direct inline: single-file implementation already fully understood from the
diagnosis session; the helper module follows the established single-module
helper convention (`relay.mjs`).

## Acceptance

- probe retries (3 × 750 ms, 500 ms gap) before concluding `absent`.
- If `absent` persists and the port owner is a stale, identifiable
  `pi-free-bridge` process: kill it and restart once (bounded recursion).
- Port owner that is NOT `pi-free-bridge` is never killed; the pre-existing
  "foreign" error path stays untouched.

## Verification evidence

- T1→T2 RED/GREEN: wrote tests first (module missing → RED), implemented
  `health-recovery.mjs`, `node --test test/health-recovery.test.mjs` — 11/11
  pass (2026-10-31). First full run hung: undici keep-alive sockets kept the
  event loop alive; fixed with `closeAllConnections()` in the test fixture.
- T5 E2E stale recovery (2026-10-31, port 8790): real stale instance spawned →
  `findPortListenerPid` returned its pid → `isBridgeGoPid` true → kill →
  post-kill probe `absent` → fresh instance `healthy service=pi-free-bridge`.
  Happy-path post-listen retry verified earlier (listening 98 ms via stderr,
  probe 200).
- T5 suite: `relay.test.mjs` FAILS pre-existing — `relay.mjs` was removed in
  commit 2ebc5f3 and its test was left stale; unrelated to this change, flagged
  as follow-up, not fixed here.

## Next step

Close the review candidate on the work-unit commit (RDD, user-owned).
