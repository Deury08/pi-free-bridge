# Feature: warp-auto-recycle

## Specs (Setched from session evidence, 2026-11-01)

- S1 The opencode free gate counts quota per (session, egress IP); a warp exit IP
  burnt its window shows as persistent 429 `FreeUsageLimitError` from warp while
  the local egress still answers 200 (verified by the warp-minimal owner).
- S2 User decision (ask_user_choice, 2026-11-01): "Sí, con N 429s consecutivos vía
  warp" — automatic recycle, not manual.
- S3 The relay counts consecutive 429s DELIVERED through the warp egress only;
  local-egress 429s never count; any success resets the streak.
- S4 The relay POSTs `/recycle` to the proxy (`RELAY_WARP_PROXY`) on the FIRST
  warp-egress 429 of a burst, then cools down (default 5 min,
  `RELAY_WARP_RECYCLE_COOLDOWN_MS`). The threshold knob was removed on
  2026-11-04: rotate-on-first is the only value that can recover the turn, so
  it is not configurable.
- S5 If the proxy does not expose `/recycle` yet, the relay degrades: one warning
  for the lifetime of the process, requests keep flowing exactly as before.
- S6 `/health` exposes `warp429Streak` and `warpRecycles` for live diagnosis.

## Tasks

- T1 (S3-S6): pure helpers `bumpWarp429Streak`/`needsWarpRecycle` + `maybeRecycleWarp`
  side effect wired after the egress loop; 3 unit tests (RED→GREEN observed); /health
  fields. Commit: this repo `feat/bun-upgrades`.
- Pending: warp-minimal exposes `POST /recycle` (warp-agent, D7a134b lineage);
  nothing blocks — the bridge degrades gracefully (S5) until it exists.

## Log

- L1 (2026-11-01, warp agent) verbatim key evidence: "el free gate de opencode
  cuenta por (session, IP de egress) ... Killing+restart del proxy (re-enroll →
  IPs NUEVOS) → warp pasa a 200 inmediatamente."
- L2 User selected option "Sí, con N 429s consecutivos vía warp" (auto-recycle).
- L3 Warp agent later suggested deferring; the user decision (L2) stands, so the
  bridge side ships with graceful degradation (S5) instead of waiting for the
  proxy endpoint.
- L4 (2026-11-04) User verbatim: "si asi mismo entonces arregla en la documentacion
  y es mas si esto no influye oes ino demas la quitas," — decision: the
  `RELAY_WARP_RECYCLE_THRESHOLD` knob is removed (dead config with a single
  correct value) and the docs are aligned to rotate-on-first. Supersedes the
  "default 3" wording in S4 and in the v0.2.0 CHANGELOG entry.
