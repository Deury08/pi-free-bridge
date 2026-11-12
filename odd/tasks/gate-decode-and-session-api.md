# gate-decode-and-session-api

Decouple the bridge from OpenCode's private storage: obtain the session id from the
local server's own API, and stop letting one opaque error hide three unrelated causes.
Branch: `feat/gate-decode-and-session-api`.

## Specs

- **S1** — "mira los demas md y la carpeta con la copia de opencode 2 para ver como podemos mejorar este bridge": every improvement must be justified against the real OpenCode v2 source, not against the bridge's own docs.
- **S2** — "los enviaste por el bridge?": no measurement counts unless it uses the relay's real request shape — Bun egress, `user-agent: opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`, and a leading `system` message carrying the `<env>` block. Measured 2026-11-12: the same id scores 200 with that shape and 429 without it.
- **S3** — "creo qei es una forma de no decirte que el id es falso": a 429 must not be reported as "quota exhausted" when the evidence points at the session id or the contract. Measured: `FreeUsageLimitError` is returned for an unknown id, for a contract violation, and for a real daily quota; `retry-after` is identical in all three (aligned to 00:00 UTC), so it is not a discriminator.
- **S4** — "osea cosechados inventados": a fabricated `ses_` id is not a harvested one. Measured 2026-11-12 against the live gate: ids issued by the local server via `POST /api/session` score 200 (5/5), fabricated ones score 429. Provenance is load-bearing and must be reported.
- **S5** — "pero la mejora 2 no afecta el retri del warp": the first rotation must behave exactly as today. A stop condition may be added; a new rotation may not. Pure decision helpers only, no warp I/O changes.
- **S6** — "corrigelo los dos": both improvements ship together.
- **S7** — the local service must never be spawned by the relay. Absent or stale registration falls through to the existing harvest; `/free-bridge-doctor` names the manual command.

- **S8** — The session id is generated, not harvested. OpenCode builds it in `packages/schema/src/identifier.ts` as `ses_` + 12 hex (a truncated millisecond counter plus an intra-millisecond sequence) + 14 base62 random characters. Reproduced 8/8 against real ids in `session_v2`. When nothing can be harvested the relay generates one, so a machine with no OpenCode starts instead of refusing. No daemon, binary, store or local API is involved.

## Tasks

- T1 — Session id from the local service API, inserted between `pi-harvest` and the store harvest (S4, S7) — commit `feat(relay): mint the session id from the local OpenCode service`
- T2 — Classify and surface the 429 cause; `FreeUsageLimitError` no longer means "quota" by default (S2, S3) — commit `feat(relay): decode the gate 429 instead of reporting quota`
- T3 — **dropped**: the ladder stop condition collides with S12 (`needsWarpRecycle(9)` is deliberately `true`, "the count never expires into a blocker"). Dropping it keeps the retry byte-identical and satisfies S5 more strictly than amending it would. The diagnostic half of the intent lives in T2's `gate429` field (S5).
- T4 — Docs: `GATE-DIAGNOSIS.md` 429 decode table, `HANDOFF.md` contract re-measurement, `README.md` session source (S1, S3) — commit `docs: record the measured gate contract and the 429 decode`
- T5 — Suite green (170 existing + new) and the change reviewed against the four lenses (S6)

- T6 — Reproduce OpenCode's id generator as the final fallback (S8) — commit `feat(relay): generate the session id instead of requiring OpenCode`
## Log

- **L1** — "mira los demas md y la carpeta con la copia de opencode 2 para ver como podemos mejorar este bridge"
- **L2** — Approved Mejora 1 (session id via local API) over the alternatives.
- **L3** — "prueba con 10 cosechados" ... "osea cosechados inventados": the first probe round was a false negative. It ran from Node without the `<env>` block and reported `FreeUsageLimitError` for every case, including the control.
- **L4** — "los enviaste por el bridge?": no. The probes bypassed the relay, so the TLS and contract requirements were unmet. Re-measured with the exact relay shape, which produced the usable matrix.
- **L5** — Measured matrix (2026-11-12, `mimo-v2.6-flash-free`, `max_tokens: 16`, relay shape, Bun 1.4.4): tier A real id 200; tier B server-issued virgin ids 200 (5/5); tier C fabricated 429; `no-soy-un-id` 429; `ses_` alone 429; empty 429; real id with `user-agent: .../1.19.0` and no `<env>` block 429.
- **L6** — "pero la mejora 2 no afecta el retri del warp": answered with the current ladder (`needsWarpRecycle(streak) => streak > 0` rotates on every 429, so an unfixable 429 loops and spends enrollments). T3 adds only the stop.
- **L7** — "pergunta para la api local esto llama a opencode o algo asi, y si no esta abierto?": measured — the daemon had 2h uptime with no TUI open, and a closed port refuses in 9ms. Decision: never spawn (S7).
- **L8** — "corrigelo los dos": T1-T5 authorized.
- **L9** — T3 dropped by the operator's decision. `test/relay.test.mjs:740` already pins `needsWarpRecycle(9) === true` with the note "the count never expires into a blocker", and `relay.mjs:850` records S12's reasoning (a second 429 is a second signal; the rotation is guarded by single-flight, not a clock). No measurement refutes that, and the request itself said the retry must not change. The diagnosis survives in `/health.gate429`; the ladder stays byte-identical.
- **L10** — `Platform: win32` in the `<env>` block is not load-bearing: `Platform: linux` also returned 200 SSE-CHUNK (2026-11-12). Recorded as a follow-up, not fixed here.
- **L11** — Slice boundary: the feature landed as **one commit of 595 authored lines** (`401cbeb`) covering T1 and T2 together. A file-level split was not possible: `relay.mjs` carries both behaviours and `test/relay.test.mjs` covers both, so splitting by file would leave a commit that does not build. Splitting by hunk would have staged a half-populated module. Delivery decision: one PR at 595 lines, or split by concern (session API separated from the 429 decode) if the reviewer prefers two — the two halves touch disjoint functions, so the split is mechanical if wanted.
- **L12** — "pero si analisas el daemon para cosechar tu la id?" — steering the design away from spawning a copied daemon and toward reading the generator itself.
- **L13** — Decision: the generator beats the daemon. `OPENCODE_PASSWORD=<pw> opencode serve --stdio` was found to be a viable id factory (it prints `{"url":…}` and accepts `POST /api/session`, and only `--service` writes `service.json`), but it costs a process, a binary to distribute and a platform artifact table to reproduce fifteen lines already present upstream. Not implemented.
- **L14** — Correction: the earlier negative probe (`ses_ZZZZ…`) measured a *malformed* id, because `Z` is not hex, not an unregistered one. Recorded in `GATE-DIAGNOSIS.md` 9.5 so the wrong conclusion is not inherited.
