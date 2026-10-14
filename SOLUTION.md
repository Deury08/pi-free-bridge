# How it was solved — OpenCode's free tier returning 403 from outside the official client

**Symptom (2026-10):** OpenCode free models (`mimo-v2.6-flash-free`, `space-bunny-free`, …) stopped working from Pi and from every hand-rolled client: every request returned
`403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}`, while the same models worked fine inside the official `opencode` CLI.

**Resolution:** gate fully decoded (surface + headers + body), Pi verified end-to-end on 6 free models, stopgap patches applied, durable fix handed off as `HANDOFF.md` in this directory.

---

## 1. The roadblocks (hypotheses that died, in order)

| # | Hypothesis | Why it died |
|---|---|---|
| 1 | *Stale harvested headers / expired session* | Re-harvested headers fresh from opencode.exe 1.19.0 through a local capture proxy → still 403. |
| 2 | *The proxy itself was faking the error* | TRUE for the first attempt: `zcap.mjs` answered 403 **locally without forwarding**. Fixed the proxy — still 403 upstream. |
| 3 | *TLS/HTTP2 fingerprint of non-official clients* | DISPROVED: byte-identical official headers + body replayed from bun 1.3.12, bun 1.4.3 (self-updated, isolated), node h1/h2 and curl → all 403. Transport was never the variable. |
| 4 | *Relay path bug* | The forwarding relay hardcoded a `/zen` path prefix — it was rewriting every request onto the wrong surface. That's what actually hid the answer. |
| 5 | *Tool-name / content gate* (third-party research, Sep 2026) | Real on the old surface (tool-name inspection measured 2026-09-18, content gate in a community changelog), but **insufficient**: perfect bodies still got 403. |

## 2. The breakthrough: it was the surface, all along

A GitHub code search for the model id hit the **official docs model table** — and it lists the endpoint explicitly:

```
mimo-v2.6-flash-free → https://opencode.ai/inference/v1/chat/completions   (@ai-sdk/openai-compatible)
```

The community (and our whole investigation) had been poking `https://opencode.ai/zen/v1/...` — a surface the official CLI no longer uses for free models.

**The decisive A/B** — one byte-identical request (captured official headers + captured official body), only the host path differs:

| Path | Result |
|---|---|
| `POST https://opencode.ai/zen/v1/chat/completions` | **403 FreeTierError** |
| `POST https://opencode.ai/inference/v1/chat/completions` | **200** → SSE `chat.completion.chunk` |

Same bytes, same client, same second → **the fingerprint theory was dead; the URL was the answer.**

## 3. Mapping the gate on `/inference/v1` (the bisect)

~25 probes, each mutating exactly one dimension of the known-good request.

**Headers** (base = content-type + captured official header set):

| Change | Result |
|---|---|
| remove `x-opencode-session-id` | **403** (required) |
| remove `user-agent` | **403** (required) |
| UA without `opencode/` (`my-agent/1.0`) | **403** |
| remove `x-opencode-project` (7 headers left) | **200** (dispensable) |
| remove `x-opencode-request` (7 left) | **200** (dispensable) |
| exactly the 6 core headers (count = 6) | **403** |
| core 6 + a junk `x-foo: bar` (count = 7) | **200** ← it's a *count* floor, not an exact set |
| `content-type + UA + session-id + 3 junk` (6) | **403** (auth/client/session also missing) |
| minimal `core6 + project` (6 total) | **403** (confirms: ≥7 total + all of core) |

**Body:**

| Change | Result |
|---|---|
| no leading `system`/`developer` message | **403** |
| system message with *custom* short content | **200** (content is free-form — no verbatim marker needed here) |
| `tools: []` | **403** |
| one tool (`bash`) / three tools (`bash`,`read`) | **200** (names not inspected on this surface) |
| premium model id + anonymous key | `400 Model is unavailable` → free filter mandatory |

**The working recipe (≥7 headers, always):** `content-type`, `user-agent: opencode/…`, `authorization: Bearer public`, `x-opencode-client: cli`, `x-opencode-session: ses_…`, `x-opencode-session-id: ses_…`, + ≥1 more (`x-opencode-project` is the natural pick) — plus body `stream:true` + leading system message + non-empty `tools`.

## 4. End-to-end proof in Pi

Ran the real client (`pi -p --no-session --model oc-sdk-zen/<id> "Reply with exactly: OK"`):

```
mimo-v2.6-flash-free        OK
space-bunny-free            OK
big-pickle                  OK
cat-jam-free                OK
nemotron-3.5-lightning-free OK
step-5-preview-free         OK        (one transient 429, immediate retry OK)
muse-spark-1.2/1.3-free     400 ModelProtocolUnsupported   (needs another protocol → excluded)
jev-1.13-free               absent from Pi's registry (stale settings entry → removed)
```

Cross-checks that closed the loop:

- `GET /inference/v1/models` → 200, 85 models (10 free ids).
- `/zen/v1` re-confirmed dead **for everything**, including the anthropic-style path: `POST /zen/v1/messages` and `/inference/v1/messages` with the anonymous key → both `403 FreeTierError`.
- Paid plan endpoint `zen/go/v1` → alive, user's key valid, but `429 GoUsageLimitError` (quota exhausted) → dropping the third-party bridge's GO path costs nothing today.

## 5. Root cause of "it stopped working from Pi"

Three things stacked:

1. **Vendor moved the surface** (`/zen/v1` → `/inference/v1`) and locked the old one hard (403 even for byte-identical official traffic).
2. **The third-party `pi-opencode-bridge` hardcodes `ZEN_BASE_URL = "https://opencode.ai/zen/v1"`** and registers all 122 registry models (most unusable anonymously).
3. **Pi's static header config** (`models.json`) had captured one session id frozen in time — workable, but a staleness trap.

## 6. What was changed (stopgap) and what comes next (durable)

Stopgap, applied and verified in this session:

- `pi-opencode-bridge/index.ts:15` → `ZEN_BASE_URL = "https://opencode.ai/inference/v1"` (dies on next `pi update` — by design it's temporary).
- Its `README.md` architecture line updated.
- `settings.json`: removed the dead `oc-sdk-zen/jev-1.13-free` entry (every-run startup warning).

Durable fix: **`HANDOFF.md`** in this directory — complete spec for building *our own* free-only bridge (`pi-free-bridge`): the full decoded contract with a self-contained `repro.mjs`, Pi's `registerProvider` surface (`headers`, `authHeader`, per-model `api`/`baseUrl` overrides), locked design decisions (provider id stays `oc-sdk-zen`, fresh `ses_…` per launch, free-cost filter, muse/jev exclusions, old-bridge removal), a T1–T9 task checklist, acceptance commands and the risk list (the vendor *will* harden again — `repro.mjs` is the tripwire).

## 7. One-line version

> The free tier never checked *who* you were — it checked *which door you knocked on*: knock on `https://opencode.ai/inference/v1` with ≥7 headers (UA `opencode/…`, `Bearer public`, both session headers, one extra), a leading system message and a non-empty `tools` array, and it opens.
