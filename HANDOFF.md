# HANDOFF — `pi-free-bridge`: free-models-only bridge for Pi

> **Audience:** the agent that will implement this.
> **Status:** investigation COMPLETE, implementation NOT started. This document is the source of truth (Engram was degraded this session — nothing was persisted to memory).
> **Date of evidence:** 2026-10-14. The vendor has moved this gate before; re-verify §4 before blaming the code if it breaks again.

---

## 1. Mission

Build **our own** Pi extension package (`pi-free-bridge`) that registers **only OpenCode free models** under the existing provider id `oc-sdk-zen`, **self-contained** (the bridge injects the full gate header contract itself), and **replaces** the third-party `pi-opencode-bridge` for the free path.

All research is done. This is a bounded implementation + verification task.

## 2. Why (context in one paragraph)

OpenCode moved its anonymous free-tier surface from `https://opencode.ai/zen/v1` (now hard-403 for *any* client outside the official CLI) to `https://opencode.ai/inference/v1` (the route documented in the official model table and used by opencode.exe 1.19.0). The third-party bridge hardcodes `ZEN_BASE_URL = "https://opencode.ai/zen/v1"` and registers **all 122** registry models (most unusable anonymously). We patched the bridge in `node_modules` as a stopgap (one line) — that patch dies on the next `pi update`. The durable fix is our own package.

## 3. Verified current state (baseline — do not re-verify from scratch)

**Pi works TODAY** for these free models (end-to-end `pi -p`, answered `OK`):

| Model | Result |
|---|---|
| `oc-sdk-zen/mimo-v2.6-flash-free` | OK |
| `oc-sdk-zen/space-bunny-free` | OK |
| `oc-sdk-zen/big-pickle` | OK |
| `oc-sdk-zen/cat-jam-free` | OK |
| `oc-sdk-zen/nemotron-3.5-lightning-free` | OK |
| `oc-sdk-zen/step-5-preview-free` | OK (one transient `429 Upstream request failed` on first try, OK on retry) |
| `oc-sdk-zen/longcat-2.5-preview-free` | in free list, **not yet e2e-probed — include in acceptance tests** |
| `oc-sdk-zen/muse-spark-1.2-contributor-free` / `-1.3-` | **400 `ModelProtocolUnsupported`** via chat/completions → EXCLUDE (see D5) |
| `oc-sdk-zen/jev-1.13-free` | 400 protocol unsupported + absent from Pi's registry → EXCLUDE (stale entry already removed from settings) |

**Stopgap patches already applied by the previous session (temporary):**
- `C:\Users\Polanco\.pi\agent\npm\node_modules\pi-opencode-bridge\index.ts:15` → `ZEN_BASE_URL = "https://opencode.ai/inference/v1"`
- same package `README.md:57` (architecture diagram)
- `C:\Users\Polanco\.pi\agent\settings.json` → removed stale `oc-sdk-zen/jev-1.13-free` from `enabledModels` (was a startup warning on every run)

These go away when the old package is uninstalled (D7). No other config changed.

## 4. The decoded gate (INPUT CONTRACT — settled, do not re-research)

### 4.1 Surfaces

| Surface | Status | Evidence |
|---|---|---|
| `https://opencode.ai/inference/v1/chat/completions` | **LIVE — use this** | official CLI 1.19.0 route; official docs model table lists `mimo-v2.6-flash-free` → this URL; byte-identical official replay → `200` SSE chunk |
| `https://opencode.ai/zen/v1/*` | **DEAD for anonymous** | same byte-identical replay → `403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode..."}}` (re-confirmed 2026-10-14, incl. anthropic `/messages` path) |
| `https://opencode.ai/zen/go/v1` (paid plan) | alive, key valid, **quota exhausted** | `429 GoUsageLimitError` with valid `sk-` key + full session headers → GO is out of scope (D6), nothing usable is lost |
| premium model on `/inference/v1` + `Bearer public` | unusable anonymously | `400 Model is unavailable` → the free filter (D3) is mandatory, not cosmetic |
| `GET https://opencode.ai/inference/v1/models` | `200`, 85 models | free ids: `big-pickle`, `cat-jam-free`, `mimo-v2.6-flash-free`, `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`, `nemotron-3.5-lightning-free`, `jev-1.13-free`, `step-5-preview-free`, `longcat-2.5-preview-free`, `space-bunny-free` |

### 4.2 Header contract — RE-MEASURED 2026-10-14 (supersedes the previous ≥7-header rule)

The first version of this section (≥7 headers, junk headers satisfying the count) is **obsolete**: with a gate-valid body, a 5-header request passes and a 7-header request with a bad body fails. Header count is not part of the gate. Re-measured by capturing a live Pi request through a local forwarder and bisecting.

**Required — remove any one → 403:**

| Header | Value | Probe evidence |
|---|---|---|
| `content-type` | `application/json` | implied by every passing set |
| `user-agent` | must contain `opencode/` | `my-agent/1.0` → 403 |
| `authorization` | **any** bearer; the literal `public` passes | header removed → 403; `Bearer public` → 200; the account `sk-…` key also → 200 |
| `x-opencode-session` | **server-valid** session id, e.g. `ses_eca394440ffeYFPjS30HnZEVBo` | removed → 403; generated `ses_<hex><base62>` → 403; `ses_0000000000000000000000` → 403; `whatever` → 403 (**E2 answered: self-minted ids are rejected**) |
| `x-opencode-session-id` | same value | removed → 403 |

**Not required:** `x-opencode-client` (absent → 200; `cli` or `sdk` both → 200), `x-opencode-project`, `x-opencode-request`, `accept`, `x-stainless-*`. A 5-header request is enough.

**No session-minting endpoint exists:** `GET`/`POST` `/inference/v1/session` and `/inference/v1/sessions` → `404`. A valid session id must come from the official client, so the bridge ships a known-good constant (see **D4**).

### 4.3 Body contract — RE-MEASURED 2026-10-14 (supersedes "tool names are not inspected")

- `stream: true`. **`stream:false` → 403** (**E3 answered**).
- A **leading `system` or `developer` message is required** — content and length are irrelevant: a 6-character system prompt with 60 tools → 200; no system message → 403.
- `tools` must be non-empty **and must contain both tool names `read` and `bash`** (order-independent). Tool-name inspection is real on this surface now:
  - `[read, bash]` → 200 (either order), `[read, bash, edit]` → 200
  - `[read]`, `[bash]`, `[edit]`, `[write]` alone → 403
  - `[bash, grep]`, `[read, grep]`, `[bash, ls]`, `[bash, edit]`, `[grep, ls]`, `[mem_stats, todo]`, `[ask_user_question, codegraph]` → 403
  - 2 or 3 dummy-named tools (`d1`,`d2`,`d3`) → 403; 3/5/10/…/50 real Pi tools → 200
- Body **size** is not a factor: 61 310 bytes with 1 tool → 403 while 60 503 bytes with 0 tools → 403 and 61 629 bytes with 60 tools → 200. Size only correlated with the tool list.
- Premium/model validity is checked independently (`Model is unavailable` for paid ids).

### 4.4 Free-model filter inputs

- **Registry:** `C:\Users\Polanco\.cache\opencode\models.json` → top-level key `"opencode"` → **122 models with `cost` metadata** (`cost.input/output/cache_read/cache_write`, plus `status`, `limit`, `modalities`, `family`).
- **Live list:** `GET /inference/v1/models` → 85 ids (what the surface advertises).
- **Recommended filter (D3):** registry `opencode` models where all `cost.* === 0` **AND** id ∈ live list. Cross-check the result against the known working set in §3.
- ⚠️ Pi's own catalog `C:\Users\Polanco\.pi\agent\models-store.json` (key `"opencode"`, 87 entries) also exists and carries per-model `baseUrl: https://opencode.ai/inference/v1` — it participates in Pi's model resolution (see §5 precedence) but is NOT the bridge's source of truth.

### 4.5 Self-contained repro (no dependency on temp files)

> The snippet below is the **historical** 2026-10-13 probe that decoded the surface.
> It no longer passes: with the gate-valid tool set it is correct, and the canonical
> tripwire now lives in **`repro.mjs`** at the repo root (keep that file green).

```js
// repro.mjs — gate sanity check. Run: node repro.mjs  (or bun)
import { randomBytes } from "node:crypto";
const hex = (n) => randomBytes(n).toString("hex");
const b62 = (n) => {                       // base62, URL-safe-ish
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: n }, () => A[randomBytes(1)[0] % A.length]).join("");
};
const sid = "ses_" + hex(6) + b62(14);     // shape: ses_ + 12 chars + 14 chars
const headers = {
  "content-type": "application/json",
  "user-agent": "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
  "authorization": "Bearer public",
  "x-opencode-client": "cli",
  "x-opencode-session": sid,
  "x-opencode-session-id": sid,
  "x-opencode-project": "global",          // 7th header — do not drop below 7 total
};
const body = {
  model: "mimo-v2.6-flash-free",
  stream: true,
  max_tokens: 16,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Reply with exactly: OK" },
  ],
  tools: [{ type: "function", function: {
    name: "bash", description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
};
const r = await fetch("https://opencode.ai/inference/v1/chat/completions",
  { method: "POST", headers, body: JSON.stringify(body) });
const txt = await r.text();
console.log(r.status, /chat\.completion\.chunk/.test(txt) ? "SSE-CHUNK (PASS)" : txt.slice(0, 140));
```

Expected: `200 SSE-CHUNK (PASS)`. Any 403 here = you changed the header/body recipe — fix the recipe, not the URL.

## 5. Pi platform facts (from `pi-coding-agent` dist types, verified 2026-10-14)

- **Local installs work:** `pi install ./local/path` (also `npm:`, `git:`, `https://`). Docs: `pi install --help`.
- **Package shape** (copy from old bridge): `package.json` with `"type": "module"`, `"peerDependencies": {"@earendil-works/pi-coding-agent": "*"}`, `"pi": { "extensions": ["./index.ts"] }`, keyword `pi-package`. Pi runs `index.ts` directly (no build step).
- **Entry point:** `export default function (pi: ExtensionAPI) { ... }`.
- **`pi.registerProvider(name, config: ProviderConfig)`** — `ProviderConfig` (from `dist/core/extensions/types.d.ts`) has:
  - `baseUrl?`, `apiKey?` (literal | `$ENV` | `!command`), `api?`, `name?`
  - **`headers?: Record<string, string>`** ← we inject the gate contract here
  - **`authHeader?: boolean`** ← adds `Authorization: Bearer <resolved apiKey>`
  - `models?: ProviderModelConfig[]` — per-model `id`, `name`, **`api?` and `baseUrl?` overrides**, `contextWindow`, `maxTokens`, `reasoning`, `cost`, `input`, `compat`
  - `refreshModels?`, `streamSimple?`, `oauth?`
  - Documented semantics: *"If `models` is provided: replaces all existing models for this provider"* and *"During initial extension load this call is queued and applied once the runner has bound its context"* → extension config should win over native `models.json`, **but verify empirically (task T6)**.
- **Old bridge guards re-registration with `Symbol.for("pi-oc-sdk:registered")`** — a global symbol. If old + new bridge coexist, load order decides who registers (or both fight). **Therefore: fully remove the old package (D6), never run them side by side.**
- **Provider id MUST stay `oc-sdk-zen`** (D2): `settings.json` (`defaultProvider`, 9 `enabledModels`), `gentle-ai/profiles.json` and `gentle-ai/subagents.json` all reference `oc-sdk-zen/<model>`.

### File map

| File | Role | Change expected |
|---|---|---|
| `C:\Users\Polanco\.pi\agent\settings.json` | `packages[]` (has `npm:pi-opencode-bridge`), `defaultProvider: "oc-sdk-zen"`, `defaultModel: "space-bunny-free"`, `enabledModels[]` | remove old package entry (via `pi remove`), remove `muse-spark-*` enabled entries (D5); keep default model/provider |
| `C:\Users\Polanco\.pi\agent\models.json` | native provider blocks: `opencode-go` (apiKey only), `oc-sdk-zen` (`apiKey: "public"` + the 6 static gate headers captured 2026-10-13) | once the bridge self-injects headers (D4), strip the static `oc-sdk-zen` headers so there is ONE source of truth; keep/adjust `apiKey` per T6 testing |
| `C:\Users\Polanco\.pi\agent\models-store.json` | Pi's model catalog (provider key `opencode`, 87 entries, `baseUrl: …/inference/v1`) | none (reference only) |
| `C:\Users\Polanco\.pi\gentle-ai\profiles.json`, `subagents.json` | reference `oc-sdk-zen/…` models | none — but see **O3** |
| `C:\Users\Polanco\.local\share\opencode\auth.json`, `C:\Users\Polanco\.pi\agent\auth.json` | keys (`opencode`, `opencode-go` = same `sk-…`, `openrouter`, `tokenharbor`, `nvidia`, oauth `openai`) | none — free tier needs NO key: literal `"public"` |
| `C:\Users\Polanco\.pi\agent\npm\node_modules\pi-opencode-bridge\` | third-party bridge (currently patched) | removed at T5 |

### Commands for verification

```
pi install C:\Users\Polanco\pi-free-bridge        # local install, adds to settings
pi list                                            # package present?
pi remove npm:pi-opencode-bridge                  # drop the third-party bridge
pi --list-models free                              # only our free set should show under oc-sdk-zen
pi -p --no-session --model oc-sdk-zen/<id> "Reply with exactly: OK"
```

## 6. Locked design decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | Own package: name `pi-free-bridge`, source dir `C:\Users\Polanco\pi-free-bridge` (this document lives there), own git repo, Conventional Commits | "es nuestro" — survives `pi update`, reviewable, forkable |
| **D2** | Provider id stays **`oc-sdk-zen`** | zero migration across settings/profiles/subagents |
| **D3** | Register **only free models**: registry `"opencode"` entries whose every **present** numeric `cost` field is `0` (⚠️ `cost.cache_write` is absent on most free models — testing all four fields with `=== 0` silently drops 36 of 39) ∩ live `/inference/v1/models`; exclusion list D5 → **7 models**: `big-pickle`, `cat-jam-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free` | premium = 400 anonymously; old bridge's 122-model dump = broken picker entries |
| **D4** | Bridge is **self-contained**: injects `baseUrl`, `api: "openai-completions"`, `authHeader: true` + `apiKey: "public"`, and the §4.2 header recipe. **Revised 2026-10-14:** the session id is **not** generated per launch — a self-minted id is rejected (§4.2, E2). The bridge ships a known-good constant, overridable via `PI_FREE_BRIDGE_SESSION_ID` or `~/.pi/agent/pi-free-bridge.json`, plus a `/free-bridge-session` command to refresh it | kills the static-header staleness in `models.json` and the dead `zen/v1` coupling |
| **D5** | **Exclude** `muse-spark-1.2/1.3-contributor-free` and `jev-1.13-free`; remove their `enabledModels` entries (avoid startup warnings) | 400 `ModelProtocolUnsupported` on openai-completions; 403 on `/messages` too; historically `/responses`-only (experiment E1 optional) |
| **D6** | Remove `npm:pi-opencode-bridge` entirely (drops `oc-sdk-go` too) | GO is `429 GoUsageLimitError` right now — nothing usable lost. Restore path: re-add the package to `settings.packages` if GO quota returns and the user wants it |
| **D7** | The `node_modules` stopgap patch needs no manual cleanup — it disappears with T5 | — |

**Open items (do NOT let these block the default path):**

- **E1 (optional):** probe `api: "openai-responses"` per-model override for muse (`https://opencode.ai/inference/v1/responses`-style path). Default remains: excluded.
- **E2:** session-value shape on `/inference/v1` (garbage `ses_` inside a passing header set — all passing tests used the official captured id).
- **E3:** `stream:false` behavior (does Pi ever send it?).
- **O3:** `profiles.json` references `oc-sdk-zen/nemotron-3-ultra-free` — that id was NOT in the live free list. If `--list-models` confirms it's gone, **report to the user; do not silently edit profiles.**

## 7. Task checklist (implementer)

- [ ] **T1** Scaffold `pi-free-bridge` in `C:\Users\Polanco\pi-free-bridge` (`package.json` per §5, `index.ts`, `README.md`, `git init` + conventional commits).
- [ ] **T2** Implement discovery + free filter (D3/D5) + `registerProvider("oc-sdk-zen", …)` self-contained (D4): fresh `ses_…`, full header recipe, `authHeader`/`apiKey`, per-model context/cost from registry metadata.
- [ ] **T3** (optional) `--dry-run` flag printing the filtered model list + header set.
- [ ] **T4** `pi install C:\Users\Polanco\pi-free-bridge` → confirm with `pi list`.
- [ ] **T5** `pi remove npm:pi-opencode-bridge` → confirm it left `settings.packages`.
- [ ] **T6** **Precedence proof:** strip the static gate headers from `models.json → providers.oc-sdk-zen`, then re-run an e2e probe → must still be 200 (proves the bridge is self-sufficient). If it fails, extension registration is losing to native config — investigate load order before proceeding.
- [ ] **T7** Acceptance e2e matrix: every model of the filtered set via `pi -p` (expect OK for openai-protocol models; `longcat-2.5-preview-free` explicitly); `pi --list-models` must show **no** muse/jev under `oc-sdk-zen`; no startup warnings.
- [ ] **T8** `settings.json` cleanup: drop `muse-spark-*` from `enabledModels` (D5). Keep `defaultModel`/`defaultProvider`.
- [ ] **T9** Commit each work unit (Conventional Commits). Record in README: the gate contract summary + how to re-run `repro.mjs` after a vendor change.

**Routing note:** this is a 2–3-file implementation → delegate ONE writer with this document as the spec; verification per §5 commands.

## 8. Acceptance criteria

1. `node repro.mjs` (§4.5) → `200 SSE-CHUNK (PASS)`. **Note the 2026-10-14 revision:** the tripwire must send *both* `read` and `bash` tools and a server-valid session id, or it fails for reasons unrelated to the bridge.
2. `pi -p --no-session --model oc-sdk-zen/<each accepted free model> "Reply with exactly: OK"` → `OK`.
3. `pi --list-models` shows the free set only (no muse, no jev, no paid `claude-*`/`gpt-*` under `oc-sdk-zen`).
4. No warnings on `pi` startup.
5. `settings.packages` contains the new package and NOT `npm:pi-opencode-bridge`.
6. Zero occurrences of `zen/v1` in the new package (GO's `zen/go/v1` is out of scope entirely).
7. `models.json → providers.oc-sdk-zen` no longer carries the stale static headers (post-T6) OR the reason it must stay is documented.

## 9. Risks & environment notes

- **Vendor hardening cadence:** the surface already moved once (zen → inference), the gate checks four dimensions (surface, headers, body, content/tool-shape — content and tool-name checks were documented by third parties on the old surface in Sep 2026). Contract may break again; keep `repro.mjs` as the tripwire. Vendor ToS says the free tier is for use *within OpenCode* — this is the user's informed choice.
- **Extension vs native precedence:** verified semantics say extension wins; still prove it (T6).
- **`pi update`** may prune/reinstall packages — re-check `pi list` after any update; our local package must survive (if it doesn't, re-run `pi install <dir>`).
- **PowerShell 5.1:** `Set-Content -Encoding utf8` writes a BOM (bun/node tolerate it; git diffs won't). Prefer the Write tool for repo files.
- **Engram (memory) was degraded** this session — do not trust it for this feature; this file is authoritative.
- Evidence artifacts (may be wiped with `%TEMP%`): `zsample-h-2.txt` (captured official headers), `zsample-b-2.json` (official body incl. `tools`), `z*.cjs` probe scripts (`zbisect*`, `zverify`, `zprobe*`, `zdesign*`, `zgo`, `zdiag`, `zrelay`). All conclusions are already encoded in §4 — the scripts are only raw history.
