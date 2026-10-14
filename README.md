# pi-free-bridge

Free-models-only [OpenCode](https://opencode.ai) provider for [Pi](https://github.com/earendil-works/pi-coding-agent).

It registers **only** OpenCode's anonymous free tier under the provider id
**`oc-sdk-zen`** and injects the gate header contract itself, so it works after
`pi update` and does not depend on any third-party bridge.

## Install

```bash
pi install C:\Users\Polanco\pi-free-bridge
pi list
pi -p --model oc-sdk-zen/space-bunny-free "Reply with exactly: OK"
```

It replaces the third-party `pi-opencode-bridge`; **do not run both side by side**.
Remove the old one with `pi remove npm:pi-opencode-bridge`.

## What it registers

Seven models, discovered from the OpenCode registry
(`~/.cache/opencode/models.json`, key `"opencode"`), filtered to entries whose every
declared cost field is zero **and** that the surface actually advertises:

`big-pickle`, `cat-jam-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`,
`nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free`

Two filter traps, both measured, both worth keeping in mind:

- `cost.cache_write` is **absent** on most free models, so testing all four cost
  fields with `=== 0` classifies 36 of the 39 free registry models as paid. The
  filter treats every *declared* cost field.
- 32 of those 39 are no longer advertised by `/inference/v1/models`. Registering
  them would put permanently broken entries in the picker, so the set is
  intersected with the advertised list.

The advertised list is a dated snapshot in `index.ts` so that startup stays
offline and deterministic; `/free-bridge-refresh` re-fetches it, persists the
result to `~/.pi/agent/pi-free-bridge.json` and re-registers the provider.

Excluded on purpose:

- `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`,
  `jev-1.13-free` — the surface answers `400 ModelProtocolUnsupported` over
  chat/completions (and `403` on `/messages`). They stay out of the model picker
  so they cannot produce startup warnings.

Diagnostics:

| Command | Effect |
|---|---|
| `/free-bridge-models` | lists what got registered and where the registry came from |
| `/free-bridge-session` | shows the session id in use and its source |
| `/free-bridge-session ses_…` | switches to a new session id and persists it |
| `/free-bridge-refresh` | re-fetches the advertised model list and re-registers |

`PI_FREE_BRIDGE_DRY_RUN=1` prints the same diagnostics at startup without touching
Pi's config.

## The gate contract

OpenCode's free tier is only served to requests that look like the official
client. Measured 2026-10-14 by capturing a live Pi request through a local
forwarder and bisecting it; `HANDOFF.md` §4 in this repo has the full evidence.

**Surface:** `https://opencode.ai/inference/v1/chat/completions`
(`/zen/v1` is hard-403 for every non-official client.)

**Headers** — five are required, and that is all:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | must contain `opencode/` |
| `authorization` | any bearer; the bridge uses the literal `public` (no key needed) |
| `x-opencode-session` | server-valid session id |
| `x-opencode-session-id` | same value |

`x-opencode-client`, `x-opencode-project` and extra headers are not required and
there is **no** header-count rule (an earlier revision of this doc claimed ≥7;
that was measured on a failing body and is obsolete).

**Body:**

- `stream: true` (`stream: false` → 403)
- a leading `system` or `developer` message (content and length are free)
- a non-empty `tools` array containing both tool names **`read`** and **`bash`**
  — names are inspected; `[read, bash]` in any order passes, `[bash]` alone or
  two arbitrary names do not

**Session id:** the gate rejects self-minted ids (`ses_<hex><base62>`,
`ses_000…`, garbage) and no session-minting endpoint exists, so the bridge ships
a known-good constant. If the surface ever starts answering 403 again, refresh it
without touching code:

```
/free-bridge-session                       # show the current id and its source
/free-bridge-session ses_abc123…           # use a new one for this session
```

and persist it in `~/.pi/agent/pi-free-bridge.json`:

```json
{
  "sessionId": "ses_…",
  "liveIds": ["big-pickle", "…"]
}
```

`PI_FREE_BRIDGE_SESSION_ID` overrides the config file.

## Tests

```bash
node test/smoke.mjs   # filter, header contract, excluded/paid leak — offline, no network
node repro.mjs        # the live gate — network
```

`test/smoke.mjs` stubs Pi's `ExtensionAPI` and asserts the registration: provider
id, surface, api key, the exact 7-model set, absence of excluded and paid models,
the five required headers, and that the retired Zen route never reaches the
registration. It is the regression
net for the filter and the header recipe; `repro.mjs` covers the vendor side.

## Tripwire after a vendor change

`repro.mjs` is the canary. Run it first whenever free models start failing:

```bash
node repro.mjs                      # -> 200 SSE-CHUNK (PASS)
node repro.mjs cat-jam-free         # probe one specific model
```

A `403 FreeTierError` from the tripwire means the gate moved again — re-derive it
(capture a live Pi request, bisect) and update `HANDOFF.md` §4 *and* `index.ts`.
A tripwire failure with working Pi traffic usually means the session id expired,
not that the bridge is broken.

## Notes

- Provider id `oc-sdk-zen` is load-bearing: `settings.json`,
  `~/.pi/gentle-ai/profiles.json` and `subagents.json` all reference it.
- The registry file is read on every launch, so new free models appear without a
  package update; removals propagate too. Nothing is written back to it.
- No credentials are stored: the bridge authenticates with the literal string
  `public`.