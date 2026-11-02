# Feature: warp rotates IP on 429

## Objective
The relay drives a warp exit rotation right after a 429 observed on the warp egress, so
a burnt IP is replaced before the next request instead of accumulating stale 429s.

## Problem / Why (context: engram #3158)
- Current counting only looks at the response DELIVERED to the client. In mode `auto`,
  a warp 429 falls back to a local success; the delivered status is `200` via local,
  and `bumpWarp429Streak` resets the streak on any success -> the 429 is never counted.
- Only a warp-egress success should reset the streak. Local outcomes say nothing about
  the exit IP.
- The 502 "rate limited on every egress" path skips counting/recycling entirely.
- Default threshold of 3 conflicts with the requested behavior: rotate when a 429 occurs.

## Scope
- `relay.mjs`: `bumpWarp429Streak`, `maybeRecycleWarp`, `forward()` chain accounting,
  `RECYCLE_THRESHOLD` default 3 -> 1; README env table row.
- `test/relay.test.mjs`: update pure-helper expectations for the new semantics.
- NOT in scope: touching the live warp-minimal service, the running relay process, or
  `~/.pi/agent/pi-free-bridge.json`. Turning warp on happens in Pi via /free-bridge-warp.

## Tasks
- [ ] T1 Helper semantics: `bumpWarp429Streak` ignores local egress entirely; warp 429
      bumps; only warp success resets. [log: relay.mjs L411-417]
- [ ] T2 Chain accounting: count OBSERVED warp responses inside the `forward()` loop
      (before fallback), then run the recycle check after the loop so 502 paths also
      trigger it. Keep `maybeRecycleWarp` recycle-side logic unchanged.
- [ ] T3 Threshold default 1 with unchanged `RELAY_WARP_RECYCLE_THRESHOLD` override;
      cooldown stays 5 min; update README row.
- [ ] T4 Update tests for new semantics; `node --test` green.
- [ ] T5 Simulation (no real warp): mock gate + mock warp `/recycle`, spawn relay on a
      scratch port; verify recycle fires on delivered `on`-mode 429s and on the
      auto-mode warp-429 -> local-200 fallback case (the old code missed this);
      verify /health counters.
- [ ] T6 Work-unit commit (conventional commit, no AI attribution).

## Route
Inline: logic concentrated in relay.mjs (preparation done via codegraph_explore),
test file is a mechanical second edit. Writer trigger rests on the T1/T2 subtlety being
single-file; observed context kept within inline budget.

## Acceptance
- Auto mode: warp 429 + local fallback success leaves streak at 1 (was reset before).
- On mode: first delivered warp 429 triggers exactly one POST /recycle (cooldown wide).
- Local-only traffic never rotates the exit.
- All of this verified in simulation; live relay untouched until the user restarts it.

## Verification evidence
- node --test: 53/53 pass (new semantics covered for bumpWarp429Streak).
- Simulation (mock gate + mock warp forward proxy, bun 1.3.12, NO real warp touched):
  - A on-mode: one warp 429 delivered -> 1 recycle immediately, streak reset.
  - B auto-mode: warp 200 elevates; then warp 429 -> local 200 fallback delivered;
    the fallback success no longer erases the streak -> 1 recycle (old code: 0).
  - C off-mode: local 429 only -> 0 recycles, streak untouched.
- Regression contrast (same sim against git HEAD relay.mjs): A recycles=0 (streak 1),
  B recycles=0 forever — confirms both bugs fixed.
- Relay spawn contract unchanged (PORT/RELAY_CONFIG_PATH/RELAY_UPSTREAM/RELAY_WARP_PROXY/
  PI_FREE_BRIDGE_SESSION_ID); bun's fetch honors the proxy option (probe ok).
