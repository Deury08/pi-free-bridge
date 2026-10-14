# pi-free-bridge — free-models-only OpenCode bridge for Pi

Bridge Pi extension that registers only OpenCode's anonymous free-tier models under
the existing provider id `oc-sdk-zen`, self-contained (it injects the gate header
contract itself) and independent from the third-party `pi-opencode-bridge`.

## Specs

- **S1** Provider id stays `oc-sdk-zen`: "El bridge nuevo debe ser free-only y
  'nuestro' (`pi-free-bridge`); el provider id se mantiene `oc-sdk-zen`."
- **S2** Own package named `pi-free-bridge`, source dir `C:\Users\Polanco\pi-free-bridge`,
  own git repo, Conventional Commits (HANDOFF D1).
- **S3** "Register **only free models**: registry `cost.*===0` ∩ live
  `/inference/v1/models`; exclusion list D5" (HANDOFF D3).
- **S4** "The bridge is **self-contained**: injects `baseUrl`, `api:
  "openai-completions"`, `authHeader: true` + `apiKey: "public"`, and the §4.2
  header recipe ... always ≥7 headers" (HANDOFF D4) — **revised by S8/S9**.
- **S5** "**Exclude** `muse-spark-1.2/1.3-contributor-free` and `jev-1.13-free`;
  remove their `enabledModels` entries" (HANDOFF D5).
- **S6** "Remove `npm:pi-opencode-bridge` entirely (drops `oc-sdk-go` too)"
  (HANDOFF D6).
- **S7** "`pi --list-models` shows the free set only (no muse, no jev, no paid
  `claude-*`/`gpt-*` under `oc-sdk-zen`)" (HANDOFF §8.3).
- **S8** Gate headers, re-measured 2026-10-14 by byte-capture of a live Pi
  request plus header bisect: required are exactly `content-type:
  application/json`, a `user-agent` containing `opencode/` (any other UA → 403),
  an `authorization: Bearer <anything>` header (removing it → 403; the literal
  `public` passes), and `x-opencode-session` + `x-opencode-session-id` carrying a
  **server-valid** session id (generated, garbage and malformed ids all → 403).
  `x-opencode-client` (`cli` or any other value) and `x-opencode-project` are
  optional; there is no header-count rule.
- **S9** Gate body, re-measured 2026-10-14: `stream: true` (`stream:false` → 403),
  a leading `system`/`developer` message (content and length irrelevant — a short
  custom system prompt passes), and a **non-empty `tools` array that contains both
  `read` and `bash` tool names**. One tool fails even when it is `bash`; two
  arbitrary names (`grep`+`ls`, or dummy names) fail; `read`+`bash` in any order
  passes. Body size is not a factor (61 KB passes, 60 KB fails — it is the tool
  names).
- **S10** Free-model filter, corrected 2026-10-14: registry entries under
  `"opencode"` whose every **present** numeric `cost` field is `0`, intersected
  with the live list, minus S5 exclusions → 7 models: `big-pickle`,
  `cat-jam-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`,
  `nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free`.
  The old `cost.input===0 && cost.output===0 && cost.cache_read===0 &&
  cost.cache_write===0` test silently dropped 36 of 39 free models because
  `cache_write` is absent from most entries.
- **S11** "`node repro.mjs` → `200 SSE-CHUNK (PASS)`" and
  "`pi -p --no-session --model oc-sdk-zen/<each accepted free model> "Reply with
  exactly: OK"` → `OK`" (HANDOFF §8.1–8.2).
- **S12** "`settings.packages` contains the new package and NOT
  `npm:pi-opencode-bridge`" (HANDOFF §8.5).
- **S13** "Zero occurrences of `zen/v1` in the new package" (HANDOFF §8.6).

## Tasks

- **T0** Re-measure the gate and correct `HANDOFF.md` §4.1–§4.5 + `repro.mjs` to
  the S8/S9/S10 contract. Route: inline. Commit: `docs: re-measure opencode free-tier gate`.
- **T1** Scaffold the package (`package.json`, `index.ts`, `README.md`,
  `repro.mjs`, `.gitignore`, `git init`). Route: inline.
  Commit: `feat: scaffold pi-free-bridge package`.
- **T2** Implement `index.ts`: S1, S3/S10 discovery + filter, S8 headers with a
  configurable session id, `apiKey: "public"`, `authHeader`, exclusion list S5,
  per-model metadata from the registry. Route: inline.
  Commit: `feat: register filtered free models with the gate header contract`.
- **T3** `--dry-run` (env `PI_FREE_BRIDGE_DRY_RUN=1`) printing the filtered model
  list and the header set. Route: inline. Commit: `feat: add dry-run diagnostic`.
- **T4** `pi install C:\Users\Polanco\pi-free-bridge`, confirm with `pi list`.
  Route: inline. Commit: none (environment state).
- **T5** `pi remove npm:pi-opencode-bridge`; confirm `settings.packages`. Route:
  inline. Commit: none.
- **T6** Precedence proof (S4): strip the stale static gate headers from
  `models.json → providers.oc-sdk-zen` and re-probe e2e. Route: inline.
- **T7** Acceptance e2e matrix over the 7 filtered models + `pi --list-models`
  shows no muse/jev/paid + no startup warnings (S7, S11). Route: inline.
- **T8** `settings.json` cleanup: drop `muse-spark-*` from `enabledModels` (S5).
  Route: inline.
- **T9** README: gate contract summary + how to re-run `repro.mjs` after a vendor
  change + how to refresh the session id. Route: inline.

## Log

- **L1** (user, verbatim) "dale paurry , te aso el royecto ara que lo bregues" —
  authorization to implement T1–T9 from `HANDOFF.md`, plus the open items T6
  (precedence proof) and O3 (report-only) named in the preceding turn.
- **L2** (evidence, 2026-10-14) `repro.mjs` per HANDOFF §4.5 → `403 FreeTierError`
  while `pi -p --model oc-sdk-zen/space-bunny-free` → `OK`. The documented recipe
  was stale; the gate had moved again. Triggered the re-measurement.
- **L3** (evidence) Proxy capture of the live Pi request (`127.0.0.1` forwarder,
  request bytes written to `%TEMP%`, forwarder fixed after a first 404 caused by a
  doubled `/v1` prefix): upstream `200`, 121 788-byte body, 23 headers. Byte-exact
  replay of that request → `200`; the same headers with a 1.6 KB body → `403`.
  The body, not the headers, was the discriminator in that comparison.
- **L4** (evidence) Body bisect: 60 tools → `200`; 1 tool → `403`; 3/5/10/…/50
  real tools → `200`; 60 tools with a 6-character system prompt → `200` (system
  length irrelevant); 0 tools → `403`. Name bisect: `[read,bash]` → `200` in any
  order; `[read]`, `[bash]`, `[edit]`, `[write]`, `[bash,grep]`, `[read,grep]`,
  `[bash,ls]`, `[bash,edit]`, `[ask_user_question,codegraph]`, `[grep,ls]`,
  `[mem_stats,todo]` → `403`; 2 or 3 dummy-named tools → `403`. → S9.
- **L5** (evidence) Header bisect with the corrected body: 5-header core → `200`;
  drop `x-opencode-session` → `403`; drop `x-opencode-session-id` → `403`;
  generated `ses_<hex><base62>` id → `403`; `ses_000…0` → `403`;
  `whatever` → `403`; drop `authorization` → `403`; `authorization: Bearer
  public` → `200`; `user-agent: my-agent/1.0` → `403`; `x-opencode-client` absent
  → `200`, `sdk` → `200`; `x-opencode-project` absent → `200`. No session-minting
  endpoint exists (`/inference/v1/session(s)` GET+POST → `404`). → S8.
- **L6** (decision) D4's "fresh `ses_…` id generated per process launch" is
  **withdrawn**: a self-minted id is rejected, so the bridge ships a known-good id
  as a constant, overridable via `PI_FREE_BRIDGE_SESSION_ID` or
  `~/.pi/agent/pi-free-bridge.json`, with a `/free-bridge-session` command to
  refresh it. Recorded here and in HANDOFF D4.
- **L7** (evidence) Filter correction: `cost` objects omit `cache_write` on most
  free models, so the D3 test matched 3 models; "every present numeric cost field
  is 0" matches 39 registry models, 7 of them live and non-excluded. → S10.
- **L8** (evidence) Extension precedence already observed while capturing: pointing
  `models.json → providers.oc-sdk-zen.baseUrl` at the local proxy did **not**
  change the target (the extension's `baseUrl` won), while `models.json` headers
  still reached the wire — native headers merge, extension `baseUrl` wins. T6
  reduces to confirming that after the static headers are stripped, e2e still
  passes.
- **L9** (safety) The captured request contains the user's real `sk-…` OpenCode
  key from `~/.pi/agent/auth.json`. It stays in `%TEMP%` only and never enters the
  repo; the bridge itself needs no key (`Bearer public` passes, S8).