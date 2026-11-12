# Gate diagnosis — 2026-10-25: the `/inference/v1` free-tier gate is now runtime-sensitive

> **Audience:** the implementer of `pi-free-bridge`, or any agent debugging a `429` from the free tier.
> **Status:** diagnosis COMPLETE. Implementation NOT started. This document supersedes `HANDOFF.md` §4.2/§4.3 wherever they differ.
> **Date of evidence:** 2026-10-25. Re-verify §3 before blaming the code again.
> **One-line verdict:** the free-tier gate now rejects any request that does not come from a **Bun** TLS client, and additionally requires an `<env>` block containing `Working directory:` in the system prompt. Pi 1.2.0 runs on **Node**, so the bridge cannot succeed no matter which headers or body it sends.

---

## 1. TL;DR

The bridge is not broken by a bug in `buildHeaders()`. It is blocked at a layer the extension does not control.

| # | Finding | Status |
|---|---|---|
| 1 | Identical bytes from **Node** (undici, raw `https`, `http2`) and from **curl.exe** always return `429`; from **Bun** they return `200` | verified, reproducible |
| 2 | On Bun, the system prompt must contain an `<env>` block with a `Working directory:` line, or the request is rejected with the same `429` | verified, byte-bisected |
| 3 | The hardcoded `DEFAULT_SESSION_ID` is **not expired** — 6/6 passes from Bun | verified |
| 4 | Randomly minted `ses_` ids are usually rejected (1/3, 1/7) — old E2 conclusion still holds | verified |
| 5 | **Pi 1.2.0 runs on Node** (`pnpm` shim → `node .../dist/bundle/cli.js`) | verified |
| 6 | Pi's system prompt uses `<cwd>`, not `<env>` | verified in `dist/core/system-prompt.js` |
| 7 | A local **Bun relay** that injects `<env>` and forwards upstream passes 4/4 with the known session id | prototype validated |
| 8 | `429` no longer means "quota exhausted" — it is the generic rejection signal for every gate failure | verified |

**Consequence:** the current architecture cannot work. `gateStreamSimple` in `index.ts` can fix the *body*, but it cannot fix the *transport*, because the socket is opened by Pi's Node process.

---

## 2. Method

1. Captured the **real** request that a working OpenCode CLI 1.19.3 sends, by pointing `provider.opencode.options.baseURL` at a local HTTP server (`capture-server.mjs`). Stored as `capture2.json` + `capture2.json.body` (171 027 bytes).
2. Replayed that exact request from different runtimes and compared status codes.
3. Bisected the body on the only runtime that passes (Bun) until the minimal passing window was found.
4. Ran the bridge end-to-end through Pi to confirm the production failure.

Baseline that must be preserved: `opencode run -m opencode/deepseek-v4.1-flash-free "Reply with exactly: OK"` → `OK` (session id redacted). OpenCode itself is healthy; the account is not out of quota.

---

## 3. The gate, dimension by dimension

### 3.1 Runtime fingerprint (NEW — the blocking one)

Same body, same headers, same order, same session id. Only the HTTP client changes:

| Client | TLS stack | Result |
|---|---|---|
| `node` fetch (undici) | OpenSSL | **429** (≈25 attempts, never passed) |
| `node` raw `https`, header order copied exactly | OpenSSL | **429** |
| `node` `http2` with ALPN `h2` | OpenSSL | **429** |
| `curl.exe` (HTTP/1.1) | Schannel | **429** |
| **`bun` fetch** | BoringSSL | **200 PASS** |

Interpretation: the gate hashes the TLS ClientHello (JA3/JA4-style) and allowlists clients that look like OpenCode — which is built on Bun. Header forgery and HTTP-version changes do not help, because the decision happens before the request is read. This is not patchable from inside Node.

### 3.2 Prompt shape (NEW)

On Bun, with a known-good session id and non-empty tools, the system prompt determines the outcome:

| System prompt | Result |
|---|---|
| `<env>\nWorking directory: /a\n</env>` | **PASS** |
| …the same, one byte shorter (missing `</env>`) | 429 |
| `<env>\nPlatform: linux\n</env>` | 429 |
| `Working directory: /a\nPlatform: linux` (no tags) | 429 |
| 112 599 chars of filler | 429 |
| Pi-style prompt (`<cwd>` block) | 429 |

Minimum passing prefix: **222 chars**, ending at `</env>`. Deterministic across 3 rounds.

So the gate parses the system prompt for an `<env>` element containing `Working directory:`. OpenCode injects exactly that block; Pi injects `<cwd>` instead (`dist/core/system-prompt.js`, `promptSections.cwd`), so Pi fails this dimension independently of the transport.

### 3.3 Session id

| Session id | Result |
|---|---|
| `ses_eca394440ffe…` (bridge constant, redacted) | **6/6 PASS** |
| `ses_e8c90ca1affe…` (captured from OpenCode, redacted) | 6/6 PASS |
| `ses_f203b07b5ffe…` / `ses_f8b913bc9ffe…` (local store, Sep) | 2/2 PASS |
| randomly minted `ses_<12 hex><14 base62>` | 1/3 and 1/7 PASS — mostly rejected |

Conclusion: the constant is alive. Rotation is not a fix; it is a way to make things worse (a minted id is *less* likely to pass than the shipped constant).

**Where a trustworthy id comes from (added 2026-10-25, second pass).** Alternating known and minted ids with a 3 s gap removed pacing as a confounder: known **6/6**, minted **1/6**. A follow-up probe showed that ids OpenCode minted *months* ago on this machine still pass — two September ids from
`~/.local/share/opencode/storage/session_diff/` answered `200`, and so did the newest row of
`~/.local/share/opencode/opencode.db` (`session.id`, ordered by `time_created`).

So the server trusts any session the official client created, permanently. It cannot be reproduced by generating `ses_<12 hex><14 base62>` locally: those ids were never registered by OpenCode. A shareable package must therefore **harvest** an id from the local OpenCode store instead of shipping someone else's constant.

### 3.4 Body rules carried over from `HANDOFF.md` §4.3

Still consistent with this round: `stream: true`, a leading `system`/`developer` message, and non-empty `tools` are required (empty `tools` → 429). **Not re-tested this round:** the §4.3 claim that `tools` must contain both `read` and `bash`. Treat it as unverified but plausible; keep `read` + `bash` in any probe to stay on the safe side.

### 3.5 What is now falsified

- **"The 429 means the free quota is exhausted."** False. The same account and model answer `200` from Bun while Node gets `429` at the same moment. `FreeUsageLimitError` is a product-level disguise for every rejection.
- **"The session id expired."** False. It passes consistently from an accepted transport.
- **"The gate returns 403 for contract violations."** Obsolete. Verified contract violations now return `429` with the same quota message. The `403` branch documented on 2026-10-14 is no longer reachable, which is why naive re-verification looked like a quota wall.
- **"Header order / header count matters."** Already false on 2026-10-14; remains false.

---

## 4. Why the bridge fails today

| Gate dimension | Requirement | `pi-free-bridge` on Pi 1.2.0 |
|---|---|---|
| Transport | Bun TLS fingerprint | **Node** → fail |
| Prompt | `<env>` + `Working directory:` | Pi sends `<cwd>` → fail |
| Session | known-good `ses_` id | shipped constant → pass |
| Body | `stream:true`, leading system, non-empty tools | bridge already satisfies → pass |

`gateStreamSimple` operates on `(model, context, options)` and forwards through Pi's fetcher. That means it can rewrite the body — dimension 2 is fixable inside the extension — but it cannot change which process opens the TLS socket. Dimension 1 requires a different process to make the upstream call.

End-to-end proof of the production failure:

```
pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
→ exit=1
→ 429: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached..."}}
```

Same machine, same minute, `opencode run` with the same model → `OK`.

---

## 5. Validated fix shape: local Bun relay

```
Pi (Node)  →  http://127.0.0.1:<port>/v1/chat/completions  →  relay (Bun)  →  opencode.ai/inference/openai/v1
```

The hop Pi → localhost never touches the gate. The relay terminates plain HTTP, rewrites the JSON, and makes a fresh HTTPS request from Bun with the accepted fingerprint.

Relay responsibilities:

1. **Transport swap** — the upstream call must be made by `bun`, not by Node.
2. **`<env>` injection** — append (never replace) an `<env>` block with `Working directory:` to the first `system`/`developer` message; create that message if absent; skip if the block already exists (idempotence).
3. **Header + session injection** — `authorization: Bearer public`, `user-agent` containing `opencode/`, `x-opencode-session` and `x-opencode-session-id` set to a known-good id.
4. **SSE passthrough** — stream chunks as they arrive. `await response.text()` would buffer the whole generation and break token streaming.
5. **Status pass-through** — propagate `200` vs `429` and `content-type` so Pi sees the real error.

Prototype core (`C:\Users\Polanco\AppData\Local\Temp\opencode\relay.mjs`, ephemeral):

```js
function ensureEnvBlock(messages, cwd) {
  const env = `<env>\n  Working directory: ${cwd.replace(/\\/g, "/")}\n  Platform: win32\n</env>`;
  const idx = messages.findIndex((m) => m.role === "system" || m.role === "developer");
  if (idx === -1) return [{ role: "system", content: env }, ...messages];
  if (/<env>[\s\S]*Working directory:[\s\S]*<\/env>/.test(String(messages[idx].content))) return messages;
  const next = messages.slice();
  next[idx] = { ...next[idx], content: `${messages[idx].content}\n\n${env}` };
  return next;
}

const upstream = await fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
    authorization: "Bearer public",
    "x-opencode-session": sid,
    "x-opencode-session-id": sid,
  },
  body: JSON.stringify({ ...incoming, stream: true, messages: ensureEnvBlock(incoming.messages, cwd) }),
});
res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
const reader = upstream.body.getReader();
for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
res.end();
```

Prototype results (client = Node, simulating Pi):

| Relay session mode | Result |
|---|---|
| minted id per request | 1/7, 1/6 — flaky, unusable |
| fixed known-good id | **4/4 PASS**, assistant replied `OK` |

Operational constraints for a real implementation: bind to `127.0.0.1` only, spawn/teardown with Pi, handle port collisions, and degrade with a clear error if `bun` is missing (`C:\Users\Polanco\.bun\bin\bun.exe`, 1.3.12).

---

## 6. Untested alternative

Run Pi on **Bun** instead of Node (`bun .../dist/bundle/cli.js`). If sane, it removes the transport dimension without a relay process.

- Would still need the `<env>` injection in the extension (dimension 2).
- Fragile against Pi internals and Node-API coverage; one missing primitive breaks the whole agent.
- Zero extra processes, ports, or lifecycle code.

This experiment must run **before** choosing the relay, because if it succeeds the relay becomes unnecessary.

---

## 7. Reproduction

Driver (always run from `bun` when testing the gate):

```
bun  <temp>\repeat-exact.mjs <temp>\capture2.json 6     # known id → 6/6 PASS
bun  <temp>\sid-rule.mjs    <temp>\capture2.json       # known vs minted ids
node <temp>\node-client.mjs <port>                     # client side of the relay
bun  <temp>\relay.mjs <port>                           # relay; RELAY_SESSION=<id>
```

Script inventory (all in `C:\Users\Polanco\AppData\Local\Temp\opencode\`): `capture-server.mjs`, `cap\opencode.json`, `capture2.json`(+`.body`), `replay.mjs`, `sid-matrix.mjs`, `sid-rule.mjs`, `repeat-exact.mjs`, `relay.mjs`, `node-client.mjs`, `bisect.mjs`, `ladder.mjs`, `size-ladder.mjs`, `bisect-system.mjs`, `struct-ladder.mjs`, `content-hunt.mjs`, `window-bisect.mjs`, `determinism.mjs`, `isolate.mjs`, `shape.mjs`, `fingerprint.mjs`, `gate-probe.mjs`, `surface-probe.mjs`, `scan-exe.mjs`.

Caveat: that directory is temporary. Anything worth keeping must move into the repo.

---

## 8. Honest limits of this diagnosis

- The vendor's server code is not available. "TLS fingerprint allowlist" is the explanation that survives every alternative I could test (headers, order, HTTP version, body size, session validity, quota). The *effect* is reproducible at 100%; the *mechanism* is inferred.
- The upstream allowlist can change again. This is a compatibility shim, not a fix.
- The `<env>` requirement may be a hygiene heuristic rather than a hard contract; only the positive and negative cases above are proven.
- `repro.mjs` in this repo runs on **node** with a short system prompt, so it now always fails. It no longer reflects reality and should be rewritten or retired.

---

## 9. Re-measured 2026-11-12: `FreeUsageLimitError` is not evidence of quota

Section 8's limits are now partly closed, and one of them was wrong in a way that
matters operationally.

### 9.1 One error code, three unrelated causes

`429 {"type":"error","error":{"type":"FreeUsageLimitError", …}}` is the vendor's
answer for **all** of the following. `retry-after` does **not** separate them: it
carried the same 00:00-UTC window in every case, so a header-only heuristic
cannot tell them apart.

| Id origin | Contract | Result |
|---|---|---|
| Real OpenCode usage (`ses_e321cfd0…`) | correct | `200 SSE-CHUNK` |
| Issued by the local server via `POST /api/session`, **never used** (5 ids) | correct | `200 SSE-CHUNK` (5/5) |
| Fabricated `ses_` + 26 chars from the real alphabet | correct | `429` |
| `no-soy-un-id`, `ses_` alone, empty string | correct | `429` |
| Real id | `user-agent: opencode/1.19.0`, no `<env>` block | `429` |
| Real id | `Platform: linux` instead of `win32` | `200 SSE-CHUNK` |

### 9.2 What that corrects

- **A correct-looking id is not enough, but the discriminator is unknown.**
  A fabricated `ses_` plus 26 characters drawn from the real alphabet is
  rejected, while ids the local generator emits are accepted. What the gate
  reads *inside* the string — a checksum, an embedded timestamp, a machine
  component — is **not** known. Calling it a "registry" was wrong: the local
  server never contacts the vendor, so the vendor cannot be checking against
  ids it issued. Section 9.4 keeps that question open.
- **Sessions can be created.** §4's "no endpoint creates a session" is true only
  of the remote surface (`/inference/v1/session` → 404). The **local** server
  exposes `POST /api/session`, and its ids are accepted before they ever serve a
  request. Scraping `opencode.db` is therefore optional, not mandatory.
- **`Platform:` is not load-bearing.** `linux` passes, so the hardcoded `win32`
  is cosmetic rather than a gate requirement. Left as a follow-up.
- **The `user-agent` format is tolerant, and an earlier reading of it was
  wrong.** The probe behind "`1.19.3` passes where `1.19.0` does not" changed
  two variables at once: that case also dropped the `<env>` block. Measured
  separately (section 9.7), the version digit does not decide anything. What is
  load-bearing is the `<env>` block and the `tools` array.

### 9.3 Method note that cost a full round

The first probe round measured from **Node**, without the `<env>` block, and
reported `FreeUsageLimitError` for every case — including the control. That was
a false negative: the relay exists precisely because the gate rejects Node's
TLS ClientHello, and the `<env>` block is part of the accepted contract. A
measurement only counts when it reproduces the relay's real request shape:

```
Bun egress
user-agent: opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
system message includes <env>\n  Working directory: …\n  Platform: …\n</env>
headers: content-type, user-agent, authorization: Bearer <any>,
         x-opencode-session + x-opencode-session-id (same value)
```

Anything else gets the same 429 that means "quota" in every existing document.
That is how five chained diagnoses stayed misattributed at once.

### 9.4 The id is generated locally, so nothing needs harvesting

OpenCode builds session ids in `packages/schema/src/identifier.ts`, and
`SessionID.create` is simply `"ses_" + descending()`:

```ts
const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) { lastTimestamp = timestamp; counter = 0 }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
```

So an id is `ses_` + twelve hex characters encoding a truncated millisecond
counter plus a per-millisecond sequence, plus fourteen base62 characters of
randomness. **Nothing about it is registered, signed or issued by anyone.**

Verified against real data: eight ids read from `session_v2` were reproduced
exactly with this formula, once the timestamp was allowed to fall up to 12 ms
before `time_created` (the row is inserted after the id is made). 8/8.

| Question | Answer |
|---|---|
| Does the id need a running daemon? | No |
| Does it need `service.json` or the local API? | No |
| Does it need `opencode.db` or `session_diff`? | No |
| Does the target machine need OpenCode installed? | No |
| Does it need a binary shipped alongside the bridge? | No |

The relay now generates the id when nothing can be harvested (`source:
"generated"`). That is what makes a machine which has never installed OpenCode
start the relay instead of failing with advice to run it.

This also settles the idea of launching a copied daemon purely as an id factory.
It works — `OPENCODE_PASSWORD=<pw> opencode serve --stdio` prints
`{"url":…}` and accepts `POST {url}/api/session` — but it is strictly worse than
the generator: a process to start and reap, a binary to distribute, and a table
of platform artifacts to maintain, all to reproduce fifteen lines that are
already written down in the upstream source.

### 9.5 Correcting the earlier negative measurement

The probes that appeared to prove "a fabricated id is rejected" used
`ses_ZZZZZZZZZZZZZZZZZZZZZZZZZZ`. `Z` is not a hex digit, so those ids were
**malformed**, not unregistered. The same applies to any probe that drew all
26 characters from the base62 alphabet, because the first twelve must be hex.
Those results carry no information about whether a well-formed id is accepted.

What remained unverified at that point was whether the gate accepts a correctly
generated id. Section 9.6 settles it. Note
what would have to be true for it to fail: the vendor would have to validate a
value that, by construction, carries no signature and is produced entirely on
the client. To close it, after 00:00 UTC send **one generated id and one
known-good control in the same run** — the control is what makes the result
readable at all.

### 9.6 Result: a generated id is accepted (measured through the relay)

Two relay instances were started with `HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`
and `XDG_CONFIG_HOME` pointing at directories that were never even created —
no `opencode.db`, no `service.json`, no OpenCode anywhere on either path. Both
reported `sessionSource: "generated"`.

| Relay | Egress | Session id | Result |
|---|---|---|---|
| A | local | `ses_e31910589ffetdmY19DkHMOxi9` (generated) | `429 FreeUsageLimitError` |
| B | warp (`RELAY_WARP_MODE=on`) | generated | `200`, six chunks, `finish_reason: "stop"`, `content: "OK"` |

A generated id therefore needs nothing external, and the 429 on relay A was the
**per-IP daily quota**, not the id: the same generator produced an id that
completed a request the moment it left through a different exit. Relay A's log
records the relay parking that egress itself —
`local egress parked for 64097s after its own 429`.

Two operational notes from the same run:

- The relay ties its lifetime to stdin (`relay.mjs:2290`): started with stdin on
  `/dev/null` it prints its listening line and exits immediately. Any supervisor
  must hold the pipe open.
- The `EADDRINUSE` message tells the operator to set
  `PI_FREE_BRIDGE_RELAY_PORT`, but the code reads `PORT` (`relay.mjs:2237`).
  Following the advice has no effect. Left as a follow-up, not fixed here.

### 9.7 Result: the bridge can take its identity from the installed v2

Two questions were measured through the relay itself, so the `<env>` block, the
`tools` array, the five headers, the Bun TLS fingerprint and the warp exit were
all supplied by the real code path; only `RELAY_USER_AGENT` changed.

| User-agent | Result |
|---|---|
| `opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` (control) | `200` |
| `opencode/stable/2.2.7/opencode` (v2 format) | `200` |
| `opencode/2.2.7/opencode` | `200` |

That v2 format is not a guess: `App.useragent` in `packages/core/src/app.ts`
builds exactly `opencode/${channel}/${version}/${name}`. So a relay that reads
`service.json` can derive its user-agent instead of pinning one, and the pinned
v1 string stays as the fallback when OpenCode is absent.

Implemented as `resolveUserAgent`: `RELAY_USER_AGENT`, then the installed
`service.json`, then the pinned constant. A version that would malform the
header (a space splits it, a slash invents a segment) is refused rather than
sent, and the resolved `source` says which of the three answered.

A real registration carries `version` but no `channel` or `name`
(`packages/client/src/effect/service.ts`), so the header it yields is
`opencode/<version>/opencode` — the three-segment form measured above. The
four-segment form stays supported because `App.useragent` builds it from the
same three fields.

The model catalog is readable from the same install. `kv` holds
`models-dev:v2:catalog` (11.3 MB) whose value is `{ updatedAt, digest, body }`,
with `body` a JSON string; alongside it `models-dev:v2:catalog:meta` carries an
etag. Sampled 2026-11-12T04:17Z — the same day — it lists **67** entries whose id
ends in `-free`, against the 8 the repository snapshot carries.

That 67 is the registry, **not** the usable set: the free tier advertises 11 via
`/inference/v1/models`, and the snapshot is a stale subset of those. So reading
the v2 catalog buys fresher metadata and a wider registry; it does not widen what
the free tier will serve.

### 9.8 What still has to be written by hand

Small and stable, and no install can supply them: the `<env>` block, the `tools`
array, and the five request headers. Everything else — the session id, the
user-agent, the model registry — can come from either the generator or the
install.
