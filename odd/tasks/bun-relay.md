# bun-relay — restore the free tier by moving the upstream call out of Node

> Feature doc for the 2026-10-25 gate change. Diagnosis and evidence:
> `GATE-DIAGNOSIS.md`. This file tracks the implementation only.

## Problem

The `/inference/v1` free-tier gate now refuses any request whose TLS ClientHello
does not look like Bun, and additionally requires an `<env>` block containing
`Working directory:` inside the system prompt. Pi 1.2.0 runs on Node, so every
request the current bridge sends is rejected with `429 FreeUsageLimitError`
regardless of headers, body, tools or session id.

The extension cannot fix this alone: `gateStreamSimple` runs inside Pi's Node
process and the socket is opened there.

## Objective

Pi answers `OK` end-to-end again, with the extension transparent: the only
request mutation accepted on the Pi path is the gate-mandated `<env>` injection,
and the response reaches Pi byte-for-byte as the upstream sent it.

## Approach

```
Pi (Node) → http://127.0.0.1:<port>/v1/chat/completions → relay.mjs (Bun) → upstream
```

The extension becomes a **launcher**:

1. Spawns `relay.mjs` under Bun at init (or reuses a healthy one already listening).
2. Registers `oc-sdk-zen` with `baseUrl` pointing at the relay.
3. Keeps a thin `streamSimple` whose only job is to await relay readiness before
   delegating to Pi's own `compat.streamSimple`. It no longer rewrites the context.

The relay owns the gate: headers, session id, `<env>` injection, tools gate, Bun
transport, raw response pipe.

## Specs

- **S20** The Pi path is a **pass-through**: the relay must not parse or rewrite
  the response. Status, `content-type` and body bytes reach Pi unchanged.
- **S21** The only body mutation on the Pi path is `ensureEnvBlock`: append an
  `<env>` block containing a `Working directory:` line to the first
  `system`/`developer` message, prepend one when absent, and do nothing when a
  conforming block is already present (idempotent).
- **S22** The tools gate moves to the wire: when `tools` is absent/empty, inject
  minimal `read` + `bash` declarations and pin `tool_choice: "none"`; when it is
  present but lacks either name, append only the missing ones.
- **S23** `stream` is forced to `true` upstream (the gate rejects `false`).
- **S24** Gate identity is owned by the relay: `content-type`, `user-agent`
  containing `opencode/`, `authorization: Bearer public`, and
  `x-opencode-session` + `x-opencode-session-id` with the resolved session id.
- **S25** Session id precedence is unchanged (`PI_FREE_BRIDGE_SESSION_ID` >
  `~/.pi/agent/pi-free-bridge.json` > built-in constant). Changing it restarts the
  relay so no request carries the previous id.
- **S26** Relay lifecycle: bind `127.0.0.1` only; default port `8788`,
  overridable by `PI_FREE_BRIDGE_RELAY_PORT` or config key `relayPort`; a healthy
  relay already on that port is reused, a foreign service on it is a hard error
  with actionable text; the child exits when its stdin closes so a crashed Pi
  leaves no orphan.
- **S27** Bun is optional-but-required: resolve it from `PI_FREE_BRIDGE_BUN`, then
  `bun` on `PATH`, then `~/.bun/bin/bun.exe`. Missing Bun produces one clear error
  naming the fix, never a silent 429.
- **S28** No new runtime dependency; `relay.mjs` uses only Node/Bun built-ins and
  ships in `package.json → files`.
- **S29** Existing behavior is preserved: model discovery, snapshot, exclusions,
  picker scope repair, and `/free-bridge-session|refresh|models|doctor` keep
  working; `doctor` gains a relay line (bun path, port, running/reused, upstream).

## Tasks

- **R1** Write `test/relay.test.mjs` for the pure helpers (`ensureEnvBlock`,
  `ensureGateTools`, upstream path mapping) and observe RED. Route: delegated.
- **R2** Implement `relay.mjs`: helpers, `/health` marker, `/v1/*` forward, raw
  pipe, gate identity, stdin-close exit. Route: delegated.
- **R3** Rewire `index.ts`: relay supervisor, `baseUrl` → loopback, thin
  `streamSimple`, session-change restart, doctor line, `files` in package.json.
  Route: delegated.
- **R4** Update `README.md` (Spanish, per S14 of the previous doc) with the relay
  requirement, port, Bun resolution and troubleshooting. Route: delegated.
- **R5** Parent-run e2e: copy `index.ts` + `relay.mjs` into
  `~/.pi/agent/git/github.com/Deury08/pi-free-bridge`, run
  `pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"`,
  restore the clone afterwards. Route: inline.

## Acceptance

- `node --test test/relay.test.mjs` green; `node test/gate-tools.mjs` and
  `node test/settings.mjs` still green.
- e2e `pi -p` prints `OK` and exits 0.
- A byte-comparison test proves the Pi path response is unmodified (S20).
- No orphan process after Pi exits.

## Progress

| Task | Outcome | Evidence |
|---|---|---|
| R1 | done | `test/relay.test.mjs`: 19 helper tests (env block, tools gate, URL mapping); RED observed as `ERR_MODULE_NOT_FOUND` before `relay.mjs` existed |
| R2 | done | `relay.mjs`; local Bun run against a fake upstream: `/health` 200 marker, 429 status + body bytes passed through unchanged, `<env>`/tools/`stream:true` injected, stdin close exits 0 |
| R3 | done | `index.ts` points the provider at `http://127.0.0.1:8788/v1`, relay supervisor + session restart + doctor lines; `package.json` ships `relay.mjs` and has a `test` script |
| R4 | done | `README.md` gains the Bun-relay section (requirement, resolution order, port overrides, verification, busy port) |
| R5 | pending | parent-run e2e |

## Amendment — harvest the session id (S30–S37)

The relay works, but the package still ships one operator's session id as a
constant, so a fresh install sends a stranger's id and the gate answers 403.
The relay must discover an id from the machine it runs on, and the extension
must stop resolving one at all.

- **S30** The package ships **no** real session id: `DEFAULT_SESSION_ID` is
  deleted from `index.ts`, and the only `ses_` literals left in tracked files
  are synthetic test fixtures and README placeholders.
- **S31** Session resolution, highest precedence first: `RELAY_SESSION` (set by
  the extension only for an explicit override) → the newest session in
  `~/.local/share/opencode/opencode.db`
  (`select id from session order by time_created desc limit 5`, first row
  matching `/^ses_/`) → the newest `ses_*.json` by mtime in
  `~/.local/share/opencode/storage/session_diff/`. If none yields an id, the
  relay prints exactly one actionable stderr line ("run OpenCode once, or set
  `PI_FREE_BRIDGE_SESSION_ID`") and exits non-zero.
- **S32** `bun:sqlite` is imported dynamically inside the harvest function, the
  DB is opened read-only, and every failure (missing file, missing table, bad
  row, import error) is silent — the next source is tried instead.
- **S33** `GET /health` returns
  `{service, ok, sessionId, sessionSource}` where `sessionSource` is `env`,
  `config`, `opencode.db` or `session-diff`. The relay-reuse marker stays
  `service` + `ok` only, so an older relay is still recognised.
- **S34** `resolveSessionId()` returns `{sessionId?, source}` and consults only
  `PI_FREE_BRIDGE_SESSION_ID` and the config `sessionId`; there is no fallback
  constant. `/free-bridge-session` with no argument reads `/health` so it
  reports the id actually on the wire; `doctor` reports the effective id and
  source, or `MISSING — run OpenCode once, or set PI_FREE_BRIDGE_SESSION_ID`.
- **S35** `test/smoke.mjs` asserts the relay transport instead of the retired
  direct-upstream one: provider `baseUrl` and every model `baseUrl` equal
  `http://127.0.0.1:<port>/v1`, and the provider declares no `headers`.
- **S36** The harvest is testable without SQLite fixtures: `relay.mjs` exports
  `resolveSessionFromStore({ shareDir })`, and the tests build temp directories
  for both sources (newest-by-mtime wins, non-`ses_` names ignored, empty and
  missing store return undefined).
- **S37** `README.md` (Spanish) documents harvest precedence, `/health` fields,
  the actionable failure, and how to force an id — replacing the "built-in
  constant" text.

## Amendment tasks

- **R6** Add the harvest tests to `test/relay.test.mjs` and observe RED
  (`resolveSessionFromStore` not exported). Route: delegated.
- **R7** Implement harvest, `/health` fields and the fail-fast startup in
  `relay.mjs`. Route: delegated.
- **R8** Remove `DEFAULT_SESSION_ID` and make the extension override-only in
  `index.ts` (optional `sessionId`, `sessionSource`, env scrub, `/health`-based
  `session` and `doctor`). Route: delegated.
- **R9** Update `test/smoke.mjs` to the relay transport. Route: delegated.
- **R10** Rewrite the README session section and record S30–S37 here.
  Route: delegated.

## Amendment progress

| Task | Outcome | Evidence |
|---|---|---|
| R6 | done | RED: `SyntaxError: The requested module '../relay.mjs' does not provide an export named 'resolveSessionFromStore'`; GREEN: `node --test test/relay.test.mjs` → 24/24 pass (5 harvest tests on temp stores) |
| R7 | done | `relay.mjs`: `resolveSessionFromStore` + `resolveRelaySession`, `/health` carries `sessionId`/`sessionSource`, async `startServer` exits 1 with the actionable line when the store is empty |
| R8 | done | `index.ts`: no `DEFAULT_SESSION_ID`, override-only `resolveSessionId()`, `RELAY_SESSION` scrubbed from the child env when absent, `session`/`doctor` read `/health` |
| R9 | done | `node test/smoke.mjs` asserts the loopback `baseUrl` for provider and models, no provider `headers`; passes against the current registry (8 free models) |
| R10 | done | `README.md` session section rewritten (precedence, `/health`, failure, override); this amendment recorded |
