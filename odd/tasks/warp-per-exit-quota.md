# warp-per-exit-quota — a quota ledger per WARP egress IP, with per-request routing

> Feature doc. Branch `feat/bun-precedence`. Owner authorization: "Doc + los dos lados".
> Split across two repositories: `pi-free-bridge` (this repo, control plane) and
> `warp-minimal` (Go, data plane, agnostic). Contract negotiated with the
> `warp-minimal` agent; evidence is `path:line` on both sides.

## Problem

A gate 429 parks exactly one egress today: the **local** IP (`localParkedUntil`,
`relay.mjs:1028`). A WARP 429 only bumps a streak and feeds one immediate swap
decision — nothing is remembered, nothing is persisted. With two live WARP exits
there is no way to say "this IP is burnt until 14:00, use the other one", because
the relay cannot choose an exit and does not know which IP served a request.

## Objective

WARP egresses behave like the local IP already does in `auto` mode: a burnt IP is
parked by IP, survives a restart, and every request from every session avoids it
until its reset. Rotating an exit is the last resort, not the reflex, because a
swap burns one enrollment (`pool.go` `replaceExit` → `RegisterDevice`).

## Approach

`warp-minimal` stays agnostic — facts and verbs only, no knowledge of 429s, quotas
or policy. The relay hides its choice in the proxy credential, which is the only
channel that survives CONNECT (measured, see L5).

```
Pi → relay.mjs (policy: ledger per IP) → proxy 8789 (Proxy-Authorization: <exit-id>) → exit → upstream
```

## Specs

S1. `warp-minimal` stays agnostic. It exposes facts about its connections and
verbs to change them. It never interprets a 429, never stores quota, never knows
`reset_at`. Owner: "yo quiero mantener el warp agnostico ... tu eres quien va a
pensar cuando hacer lo que necesitas ... un 429 del agente el no sabe porque solo
maneja trafico no tiene que manipularlo".

S2. Routing is per request, not a global pin. Owner chose the header channel:
"bueno entonces nos vamos por eader".

S3. The channel is `Proxy-Authorization: Basic base64("<exit-id>:")`. Measured on
Bun: a custom request header is inside TLS and never reaches the proxy; URL
credentials do arrive on CONNECT (L5).

S4. The relay owns the policy: which IP is burnt, until when, and when to rotate.
The ledger is global — an IP parked by one session is parked for all of them.

S5. The ledger is a JSON file, keyed by **egress IP**, not by exit id. An exit can
rotate and gain a new IP; an IP can come back. Each entry also carries `prefix64`
derived by the relay from the IP (never asked of `warp-minimal`, which has no /64
notion on the MASQUE pool).

S6. Reset extraction reuses `parkDurationMs` (`relay.mjs:513`): integer
`retry-after` seconds plus `PARK_MARGIN_MS`, and **no park at all** when the header
is missing or not an integer. Guessing the reset stays forbidden (S16 of the
earlier feature).

S7. A 429 must not poison the ledger unless it is attributable to the egress. The
vendor returns the same `retry-after` window for an unknown session id, a contract
violation and a spent quota (`relay.mjs:942`). The existing `classifyGate429`
(`relay.mjs:957`) decides: `session_suspect` (`env`/`config`) parks nothing.

S8. Silent fallback in `warp-minimal`: an unknown exit id and a valid-but-unusable
exit (draining, cooldown) take the same branch — plain `Acquire`, no error, and
**never a 407**, because Bun retries a 407 and the relay would see a proxy error
instead of the fallback.

S9. Rotation only when every exit is parked and the nearest `parked_until` is far
away. The threshold already exists in the swap decision (`relay.mjs:861-899`);
rotation burns one enrollment, so it is the last resort.

S10. The local park is persisted too. Today `localParkedUntil` is RAM-only, so a
relay restart un-parks a burnt local IP and spends one request on a known 429.

S11. Capability detection is **declared, never probed**. `GET /exits` must not be
sent to a proxy whose build is unknown: on a binary without that route the request
reaches the catch-all, and the catch-all defect (D7/D9) charges it to an exit, which
leaves rotation for **30 minutes**. So the proxy states the capability itself, in
`/health` — a real route on every build — as `"capabilities": {"exits": true}`.
The shape is nested so it can grow (`capabilities.swap`, `capabilities.prefer`)
without flat name collisions, and it is one spelling only: the flat
`exits_structured` was considered and dropped. The field must be
**absent** on builds without the route; an explicit `false` is not used, because
absence cannot be faked by an old binary. Absent reads as `legacy`: the relay sends
no extra request at all and preferred routing stays inert, so an old binary sees
exactly today's traffic. The declaration is read from the `/health` body the relay
already fetches before choosing, so a warm request path pays nothing for it.

S12. `/health` reports the ledger: parked egress count, the nearest reset, and
whether preferred routing is active or inert.

S13. `warp-minimal` adds `GET /exits` (structured array) and `GET /exit/<id>`,
returning `{id, ip, family, observed_at, state, served, streams, created_at,
cooldown_until, in_use_since}` with absolute epoch timestamps. The egress IP comes
from `https://1.1.1.1/cdn-cgi/trace` through that exit's own `DialContext`, parsing
`ip=`; never `Exit.IPv6` and never the peer endpoint. No `prefix64` field.

S14. Consumed contracts stay intact: `/health.exits` keeps its `"<id> (<state>,
served=N, streams=N)"` string form and `/recycle` keeps `recycling: true`. The
relay parses the first (`warpExitSnapshot`) and depends on the second
(`seenRecycling` → `isRotationConfirmed`). New structure goes to new endpoints.

S15. Tests pin every rule: relay side covers park-by-IP, persistence across a
restart, no-park on `session_suspect`, no-credential on an older proxy, and the
local park surviving a restart; Go side covers prefer hit, miss on unknown id,
miss on draining, and the absence of a 407.

S16. Units never mix. Every timestamp the proxy publishes (`created_at`,
`cooldown_until`, `in_use_since`, `observed_at`) is epoch **seconds**; every clock
the relay reads is epoch **milliseconds**. The conversion happens once, at the
boundary where the payload is parsed, and a test fails if a value in one unit is
compared with a value in the other. `0` means "not applicable", never 1970.

S17. Freshness is a precondition for preferring. An exit's address may only be
preferred when `observed_at` is present and no older than 120 s, because the proxy
caches the trace 45 s per exit and an aged address is evidence about a tunnel that
may no longer look like that. Past 120 s the exit still exists and still counts; it
simply cannot be preferred. **The cache does not expire on failure**: after one
successful trace the proxy serves the last known `ip` with its ORIGINAL
`observed_at` forever, even while the trace keeps failing. So `ip` absent means
"never observed" and nothing else, while `ip` present with a frozen `observed_at`
means "tunnel with no egress" — the common death case. Staleness is the death
signal; absence is not.

S18. `state` is eligibility, never proof of liveness (answers D3, D6). `healthy`
means enrolled + tunnel non-nil + no cooldown + not draining + `streams == 0`,
evaluated by `stateLocked()` under `Pool.mu`; the same predicate feeds
`/health.healthy` and `/exits.state`, so the two views cannot disagree within one
instant and cross-checking them buys nothing. There is no health check on that path:
a tunnel that dies silently keeps reporting `healthy`. The only reachability signal
is `observed_at` freshness — a dead tunnel's trace stops renewing, so its address
ages. Liveness therefore comes from S17, and a `healthy` exit with a stale address
ranks below a `healthy` exit with a fresh one.

S19. Transport, stated so it cannot be misread: this deploy runs MASQUE.
`stackFamily` maps `""`, `masque`, `ipv6` and `warp` to MASQUE, and the live
`/health` publishes the **effective** label (`stackLabel`, derived from the same
`useMasque` that selects the pool), so `"stack":"masque"` proves the MASQUE pool
ran. The WireGuard pool is **compiled and selectable**, not dead code: it is chosen
by any *unrecognised* `stack` value, so a typo in that key silently moves the
deployment to WireGuard and the only alarm is `/health.stack` reading `"wireguard"`.
Never write "the deploy is IPv6 end to end" or "WireGuard is dead code".

S20. The ladder has exactly **two rounds and one terminal**. Round 1 is free: the
relay may attempt each eligible exit it already has, **at most once each**, in the
order `chooseWarpExit` ranks them, parking the egress of every attributable 429
(S4, S7) before moving to the next. No enrollment is spent in round 1. Round 2 is
paid: only when round 1 has run out of eligible exits, the relay triggers **one**
rotation and then attempts the exits the pool offers **after** the replacement —
whatever the pool actually publishes, never an assumed count.

S21. Round 2 spends an enrollment only on evidence that the exit is the cause.
If any 429 in round 1 classified as `session_suspect` (`classifyGate429`), the
cause is not the egress: no rotation, the original 429 is delivered. The same
`warpSwapDecision` that already decides whether a swap is worth its enrollment
gates round 2, so a long `retry-after` never buys a rotation that cannot help.

S22. The client sees **exactly one 429 per request**, and it is the terminal one.
The delivered response is the original rebuilt byte-exact with `forwardedHeaders`
(S13), `retry-after` included; an intermediate 429 from an inner rung is never
shown. Nothing retries after delivery: the terminal decision is final for that
request.

S23. Every rung is observable. `/health` reports how many round-1 cross-exit
attempts were made, how many round-2 rotations ran, and how many requests ended
in a terminal 429, so a ladder that is quietly burning enrollments is visible in
the same place the ledger already is.

S24. The ladder terminates by construction. A request spends at most one attempt
per eligible exit in round 1 plus one attempt per exit the pool publishes after a
single rotation, and round 2 happens at most once; no path loops, and no path
re-enters round 1 after a terminal delivery.

S25. The proxy stays agnostic to the ladder. It never learns that a retry
exists: it publishes facts (`/health`, `/exits`, the credential it was given) and
exposes verbs (`/recycle`, `/swap`), and the relay decides which verb, when, and
how many times. No round counter, no retry budget, no ladder state, no `reset_at`
interpretation ever crosses into the proxy. Round 2 is the relay asking for a
rotation and then *reading* what the pool publishes afterwards; the proxy is not
told why, and must not be able to tell.

## Defects found in review

These are defects, not footnotes: each one either produces silently wrong state or
routes traffic using evidence that does not hold.

| ID | Defect | How it was found | Pinned by | Status |
|---|---|---|---|---|
| D1 | The proxy publishes epoch **seconds** while the relay compares against `Date.now()` **milliseconds**. The comparison does not throw: a park reads as long expired, or as alive for fifty thousand years. | reading the peer's live JSON against the code | a test that fails when the two units are mixed | open until T2/T4 land |
| D2 | The freshness threshold was 600 s while the proxy caches the trace 45 s, so a ten-minute-old address could be preferred as if it were current. | the same review | a test on the 120 s boundary | open until T2/T4 land |
| D3 | ~~`/health` reports `healthy: 1` while `/exits` lists two exits in `state: "healthy"`~~ — **RETRACTED, this was a reporting error, not a defect.** The peer compared captures of different instants of the same run without marking them. `active` is the current population (`len(p.exits)`: an enrolling exit is not in the slice yet) while `pool_size` is the target; `healthy` counts `stateLocked() == "healthy"`, the same predicate and the same lock `/exits` uses, so the two cannot differ in one instant. Measured over 24 samples every ~400 ms: agreement in all 24. | the peer's measurement after being challenged | none needed | retracted; S18 rewritten around the real issue |
| D6 | `healthy` is **eligibility, not reachability**. Nothing health-checks an exit on that path, so a silently dead tunnel keeps reporting `healthy`; what actually changes is that its trace stops renewing and its address ages. Routing on `state` alone would prefer a corpse and then blame quota for the 429. | the peer's reading of `stateLocked()` | the S17 freshness gate, plus a test that a stale address is not preferred and ranks below a fresh one | handled by S17; `state` was never meant to carry this |
| D7 | **Pre-existing, active in the live binary.** `proxyRequest` read only `r.URL.Host`; on an **origin-form** request (`GET /...`, what any browser, probe or misaimed health check sends) that field is empty and the real host lives in `r.Host`, so the code built `":80"`, the dial failed with `missing port in ":80"`, and `Pool.Fail` charged the **exit**: 30-minute cooldown plus replacement. One single `GET /` takes a healthy exit out of rotation; with `pool_size: 1` that is a full outage. Fixed in the peer's tree (commit `4c84e19`: origin-form falls to `r.Host`, a hostless request returns **400 and never touches the pool**, and a real dial failure against a well-formed target still marks the exit, guarded by a test that passes before and after). **The live 8789 binary does not have the fix**, so the risk is active until the owner deploys. | the peer's red test `dialled ":80", want "example.com:80"` | reproduced red before the fix | **active on the live binary; needs a deploy decision from the owner** |
| D7a | Measured with a throwaway logging proxy: Bun validates the URL before touching the proxy, so the relay **cannot** produce it. `http://:80/` and `http://:/x` are rejected by Bun itself (`fetch() URL is invalid`) and nothing reaches the proxy; empty string and `https://` likewise. So the cooldown came from another client speaking plain HTTP with no `Host` (a raw `GET / HTTP/1.0` leaves host empty and defaults port 80), most likely the peer's own probe. | `/tmp/bun-wire-probe.mjs`, 7 cases, loopback only | none needed | closed as "not the relay"; still reachable by any local process |
| D8 | A malformed URL does not fail loudly in Bun: `http:///v1/messages` is sent to the proxy as `POST http://v1/messages`, i.e. the first path segment becomes the host. A misbuilt URL therefore leaves towards an invented destination instead of raising. | the same probe | none | accepted; the relay always builds upstream URLs from validated config |
| D9 | **My own capability probe was the same trap.** `warpExitsCapability` sent `GET <proxy>/exits`; against a binary without that route the request lands in the catch-all and, with D7's bug, costs an exit 30 minutes. Caught before it was ever pointed at the live proxy; replaced by a declared capability in `/health` (S11), so the relay sends no probe at all. | reading the probe against the peer's D7 diagnosis | a test asserting no request to `/exits` unless the capability is declared | fixed by S11 |
| D4 | `::ffff:1.2.3.4` canonicalises to the IPv6 form instead of collapsing to IPv4. Harmless for a real trace, unhandled if one ever appears. | a manual check of the canonicaliser | none | accepted, documented |
| D5 | Two concurrent traces on different exits were never measured against a live pool. The design is safe by construction (a mutex per exit, separate QUIC sessions) but it is unverified. | the peer's own report | none | open, low risk |

D6 is the one that matters: D1 and D2 are fixed in the wiring, D5 is a measurement
gap, D3 never existed, but D6 means the field the relay sees is weaker than its
name — and D7 means the pool can lose an exit to a malformed request.

## Tasks

| ID | Task | Specs | Route | Commit |
|---|---|---|---|---|
| T1 | Ledger module: read/write/prune the JSON by IP, derive `prefix64` | S5, S6 | relay | f92c990 |
| T2 | Park WARP egresses from a 429, honouring `classifyGate429` | S4, S7 | relay | pending |
| T3 | Persist the local park and load it on start | S10 | relay | f92c990 |
| T4 | Per-request routing: exit choice → proxy credential, with capability detection | S2, S3, S8, S9, S11 | relay | f92c990 |
| T5 | `/health` reports the ledger and whether routing is live | S12 | relay | f92c990 |
| T6 | `warp-minimal`: `GET /exits`, `GET /exit/<id>`, credential read, silent fallback, no 407 | S1, S8, S13, S14, S15 | warp-minimal (peer) | peer's tree |
| T7 | Two-round ladder: free cross-exit rung, one gated rotation, terminal 429 | S20, S21, S22, S23, S24 | relay | pending |

## Log

L1 (owner, verbatim): "quiero saber si tenemos todo lo necesario para optener la
ip que usa el war, la idea es que cada 429 que de el modelo porque ya no hay uso
tiene una hora de reinicio, lo dice el mensaje que llega, la idea es capturar eso
como se hace con la ip local en modo automatico pero guardarlo en un archivo la ip
con el tiempo, asi si llegan 2 ips del warp y hay una quemada usar la que esta
limpia segun nuestra lista y asi asemos los swap y los recicle, dime si entiendes
y si falta algo departe del warp par que esto sea posible"

L2 (owner): "recuerda es el warp minimal el que usa el relay" — the subject is
`Deury08/warp-minimal`, not the desktop client.

L3 (owner): "quiero mantener el warp agnostico ..." — verbatim in S1.

L4 (owner): "bueno entonces nos vamos por eader" — channel decided after the two
alternatives (global pin, rotation only) were explained.

L5 (evidence, measured 2026-11-14, Bun + a local logging proxy, one distinct
origin per case so no tunnel is reused):

| case | what the proxy saw on CONNECT |
|---|---|
| bare proxy URL | `host`, `proxy-connection` |
| `http://warp-2:s3cret@127.0.0.1:8899` | `proxy-authorization: Basic d2FycC0yOnMzY3JldA==` = `warp-2:s3cret` |
| path in the proxy URL | nothing extra; discarded |
| custom `X-Warp-Exit-Prefer` header on the fetch | **not visible** (inside TLS) |
| `http://warp-5@127.0.0.1:8899` | `Basic d2FycC01Og==` = `warp-5:` |

L6 (owner): "la manera de manejar el mensaje del 429 ya esta aplicado en el modo
automaticco con la ip local" — confirmed in code: `parkDurationMs` +
`localParkedUntil`; the gap is per-IP scope and persistence, not parsing.

L7 (owner): "Doc + los dos lados" — implementation authorized on both repositories.

L8 (evidence, `warp-minimal` @ HEAD, read-only audit by the peer agent): the pool
keeps N simultaneous MASQUE tunnels (`pool.go` `Acquire`: "Exits are SHARED");
`statusLocked()` publishes `exits` as strings and never serialises timestamps;
`Swap` always burns a new enrollment; `recycling` is overwritten to `true` in the
recycle handler; `prefix64` has no source on the MASQUE pool.

L9 (evidence, 2026-11-14): the slice for T1/T3/T5 was written by a worker that
died on a model quota before self-verifying. Two defects were found on review and
fixed by hand: `proxyUrlWithExit` trimmed an exit id, so `"warp-2\n"` was
normalised into a valid credential instead of being refused; and one assertion
expected IP keys in insertion order while `serializeQuotaLedger` sorts them
lexicographically (`198.51.100.9` precedes `203.0.113.7`). Suite 233 -> 267, 0
fail.

L10 (operational constraint, owner): "importante tanto el relay como el warp los
estamos usando y dependemos de ellos". The live relay (pid 59356) runs
`relay.mjs` from the main working tree, so unverified edits there would run on the
next respawn. Work therefore moved to the worktree
`../pi-free-bridge-warp-quota` on branch `feat/warp-per-exit-quota`, and the live
tree was returned to `4854b15`. The running proxy is the installed binary
`~/.pi/agent/pi-free-bridge/warp/warp-minimal`, not the Go source tree.

L11 (owner): "El túnel es IPv6 puro". Consequences: the ledger key must canonicalise
IPv6 spellings (pinned by a test: two spellings of one address are one entry), and
`https://1.1.1.1/cdn-cgi/trace` — an IPv4 literal — may have no route inside an
IPv6-only netstack.

L12 (evidence, real deploy on 127.0.0.1:8790, read-only binary in /tmp):
`GET /exits` and `GET /exit/<id>` answer 200 with the agreed shape, an unknown id
answers 404, `POST /exits` answers 405, and `/health.exits` is byte-identical in
form. But `ip`, `family` and `observed_at` are **absent**: the trace dial logs
`DIAL 1.1.1.1:443 -> 1.1.1.1 proto=ipv4` and never answers, which is L11's
prediction confirmed. `created_at` is machine-clock epoch and both processes run on
the same host. Until the trace resolves over IPv6 there is no `ip`, so T2 and T4
stay blocked.

L13 (evidence, peer agent, real pool, `internal/warp/facts.go` commit 8142681):
TWO INDEPENDENT PLANES, and "the tunnel is pure IPv6" is true in only one of them.
- **Transport** (host → the Cloudflare MASQUE peer): **IPv4**.
  `defaultMasqueEndpoint = "162.159.198.1:443"`; `masque.go:91-98` prefers `epV4`
  with the comment "the endpoint's /103::6 may be unreachable from WISP v6", so
  `epV4 + ":443"` is the normal path and `[epV6]:443` the fallback. The live log
  reads `WARP masque tunnel up: endpoint=162.159.198.2:443`.
- **Egress** (what leaves from inside the tunnel): **IPv6 only**. `traceTargets`
  dials `[2606:4700:4700::1111]:443` first and falls back to `1.1.1.1:443`.

The real failure was a direct rejection, not NAT64: `trace: request: resolve
1.1.1.1:443: IPv4 address rejected in ipv6-only stack`. Any doc that says the peer
is IPv6, or that the deploy is IPv6 end to end, is wrong and will make the next
reader break the trace again.

Also from L13: the two real exits do not share a /64
(`2a09:bac5:3057:aa::/64` vs `2a09:bac1:2040:10::/64`); `ip`, `family` and
`observed_at` are `omitempty` and absent when the trace never worked, but a
previously observed address is served aged rather than removed, so freshness is
judged by the relay against `observed_at`; and the proxy caches the trace 45 s per
exit. Peer tests burned 6 enrollments in total across throwaway pools.

L14 (evidence, peer agent, 24 samples measured on a real pool): **D3 is retracted
and D6/D7 replace it.**
- `pool.go statusLocked()`: `active` = `len(p.exits)` (an exit that is still
  enrolling is not in the slice yet), `pool_size` = configured target, `healthy` =
  count of `stateLocked() == "healthy"`. `pool_size`/`active` were never two truths
  about one thing; the peer's earlier report mixed instants of one run. Measured
  every ~400 ms: `act=1 hlth=1 ps=2 exits=1` for 4 samples, then `act=2 hlth=2 ps=2
  exits=2` for 20. Agreement in all 24, as the shared lock implies.
- `stateLocked()` returns draining / cooldown / starting (`Tunnel() == nil`) /
  in_use (`streams > 0`) / healthy, and **no health check is on that path**. A dead
  tunnel keeps saying `healthy`. The only liveness signal available is `observed_at`
  freezing, which is exactly what S17 gates on.
- `traceTargets` option (b) also works: `cloudflare.com/cdn-cgi/trace` resolved to
  `2606:4700::6810:85e5` and returned an egress v6 address. It was rejected anyway
  because it depends on resolver ordering and puts DNS in the observation path;
  option (a) is deterministic. No IPv4 `ip=` and no repeated `ip=` across exits were
  ever observed.
- Final JSON, one instant, `active:2 healthy:2 pool_size:2` matching two exits:
  `2a09:bac1:2040:10::11:220` (`2a09:bac1:2040:10::/64`) and
  `2a09:bac5:3053:323c::501:16` (`2a09:bac5:3053:323c::/64`) — third independent
  confirmation that the /64s differ.
- Enrollments burned in total: **9** (6 + 2 for the fill measurement + 1 for the
  cloudflare.com measurement). No `/recycle` or `/swap` was ever called. Ports 8790
  and 8791 are down.

L15 (evidence, own measurement, `/tmp/bun-wire-probe.mjs`, loopback logging proxy,
nothing live touched): the `dial :80` in D7 is **not the relay**. Bun rejects an
empty-host URL before it ever opens a proxy connection (`http://:80/`,
`http://:/x`, `""` and `https://` all throw `fetch() URL is invalid` / `must not be a
blank string`, and zero bytes reach the proxy), so the relay cannot emit
`CONNECT :80`. The cooldown came from a client speaking plain HTTP with no `Host`,
where host defaults to empty and port to 80. Also measured: `http:///v1/messages`
is NOT rejected — Bun sends `POST http://v1/messages`, turning the first path
segment into the host (D8), so a misbuilt URL leaves towards an invented
destination instead of raising.

L16 (evidence, peer agent, `path:line`): **transport corroborated, and two of my
phrasings were wrong.**
- `cmd/warp-minimal/main.go:51` `defaultStack = "ipv6"`; `main.go:217-223`
  `stackFamily`: `""`, `masque`, `ipv6`, `warp` → masque, **everything else →
  wireguard**. Default is MASQUE, but a typo in `stack` (`"Masque"`, `"masque "`)
  silently selects WireGuard.
- `main.go:117` `stackLabel, useMasque := stackFamily(cfg.Stack)` feeds both the
  published label and the pool choice (`:122` `NewPool` vs `:129` `NewWGPool`), so
  `/health.stack` publishes the EFFECTIVE stack and cannot report masque while
  running wireguard. The live `"stack":"masque"` on pid 20704 therefore proves
  `NewPool` ran — stronger than reading the config file.
- The MASQUE pool only creates MASQUE exits (`pool.go:528` `RegisterDevice`,
  `pool.go:534` `NewMasqueTunnel`); no branch inside it builds an `exitWG`.
- **"WireGuard is dead code" is wrong and must not appear in the docs.** `wg_exit.go`,
  `wg_pool.go` and `wg_registrar.go` live in the same package, are always compiled and
  are referenced from `main.go:128-136`. Only `exitWG.HealthCheck` (`wg_exit.go:101`)
  truly has zero callers, and the trace in `facts.go` reimplements the approach
  independently instead of calling it.
- **Correction to an earlier note of mine**: `pool_size` and the per-exit cooldown are
  ALIVE in the MASQUE pool (`Exit.Cooldown`, `stateLocked()` → `"cooldown"`, the 30
  minutes observed live in D7). Only the `/64` block cooldown (`wg_pool.go:160`
  `blockKey`, `blockCooldowns` `:212-215`) is WireGuard-only.

Safe phrasing for the docs: "the transport is MASQUE (`stackFamily` maps
`ipv6`/`masque`/`warp` to masque, and the MASQUE pool enrols with `NewMasqueTunnel`);
the WireGuard pool is still compiled and selectable with an unrecognised `stack`, but
does not run in this deploy, and its `HealthCheck` has no callers."

L17 (own work, after the worker died on quota a second time): T2/T4 finished inline.
The worker had already landed the prefer path and the park (268 → 282 tests, all
passing, with the tests named after the rules), so what remained was D9.
- **The probe was the bomb.** `warpExitsCapability` did `GET <proxy>/exits`; on a
  binary without that route — the owner's live 8789 — it lands in the catch-all and
  D7 charges the request to an exit: 30 minutes out of rotation per diagnostic read.
  It was never pointed at the live proxy.
- Fixed by removing the probe entirely: the declaration is read from the `/health`
  body that `readWarpSnapshot` already fetches (`relay.mjs:2720`) right before the
  exit is chosen, so a warm request path pays nothing and an old binary sees no extra
  traffic. On a cold cache (`/health` diagnostics) one `/health` read is made; never
  `/exits`.
- Test-first evidence: four capability tests went red (`278 pass / 4 fail`) before the
  change and green after (`282 pass / 0 fail`). One existing test also had to be
  corrected because it encoded the retired belief that "200 + JSON array from
  `/exits`" was the contract; now an array body is `legacy`, and the fake proxy
  declares the capability the way a real binary must.
- New guard test, named for the danger: "a /health without the declaration is legacy
  and /exits is never asked" — it asserts the URL set contains no `/exits` at all.

L18 (evidence, peer agent, commit `fcca89e` on `feat/warp-exit-facts`): the
declaration exists and is **not hardcoded**. `healthHandler` type-asserts the pool to
`exitFacts`, the same capability the `/exits` route registration depends on, so the
declaration cannot drift from the reality it describes. Literal `/health` on a build
with the route: `{"active":2,"capabilities":{"exits":true},"cooling_down":0,
"exits":["warp-... (healthy, served=0, streams=0)"],"healthy":2,"ok":true,
"pool_size":2,"recycling":false,"service":"warp-minimal","stack":"masque"}`.
Without the route the key does not exist at all — no `false`, no `null`. The
`/health.exits` `[]string` guardian test still passes. Red before green:
`/health.capabilities missing`.

Consequence for the relay, verified rather than assumed: nothing of this is
deployed. The live 8789 predates both `4c84e19` (catch-all fix) and `fcca89e`, so
the relay reads `legacy` there — which is the correct answer, and means the feature
is inert on the live service until the owner deploys. The end-to-end run must
therefore use a binary built from `feat/warp-exit-facts` on the probe port, or it
would validate nothing about the prefer path.

L19 (user, verbatim): «otra cosa, cuando llegue el 429 a la pantalla del cliente osea
despues de la escalera, podemos tener retri?»

L20 (user, verbatim, the design): «bueno la idea mia es si se quema a usar b si no
queda ninguna reclicle y lo mmismo a yluego b es lo que ya hay pero cualdo llegue el
429 al cliente reclicle y peticion denuevo a y luego b recicle a y luego b y llega el
ultimo 429, osea escalera interna, llega al cliente el 429 recile + retri y luego
escalera inerna nuevamente y ahi no hace el rety cuando llega al cliente el segundo
429»

L21 (decision, asked and answered): round 2 is **automatic** — the relay rotates and
retries on its own, and the client sees a single terminal 429. The cost was stated
before choosing: one enrollment per request that reaches round 2.

L22 (user, constraint): «pero el proxy debe ser agnostico a eso». So S25: the ladder
is relay policy end to end. The proxy keeps only facts and verbs, and never learns
that a retry exists.

L23 (evidence, live production after the owner restarted both processes): relay
`/health` on 8788 reports `warpExits:"structured"`, `preferredRouting:true`,
`preferredExit:"warp-18e7d77fcab7a02a"`, `warpExitsDetail.usable:2`,
`quotaLedger.parked:1` (the local egress). Proxy `/health` on 8789 reports
`capabilities:{exits:true}`, `stack:masque`, `pool_size:2`, `healthy:2`, and `/exits`
serves two real egress addresses in distinct /64s — `2a09:bac5:3053:323c::501:1a` and
`2a09:bac5:3057:323c::501:12`. The proxy's `served` counter reads 1 on exactly the
exit the relay named and 0 on the other, so the credential channel works end to end
in production. D7 is closed in production by the deployed binary.
