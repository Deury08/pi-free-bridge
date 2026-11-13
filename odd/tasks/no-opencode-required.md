# No OpenCode required

The extension must work on a machine with no OpenCode, no Bun and no Node: it
loads, its commands register, and the menu can install the relay. Branch
`feat/no-opencode-required`, cut from `master` @ `db9a45a`.

## Specs

S1. Register the three commands unconditionally, BEFORE any model discovery or
early return. "The menu is most needed exactly when there are no models."

S2. Stop sourcing the catalog from OpenCode. The provider must implement
`refreshModels` and take its list from the relay. "No embedded list, no
hardcoded fallback, no registry read for the catalog."

S2 amended (owner decision, L11): the catalog must come THROUGH THE RELAY, not
from a direct call by the extension. The relay serves `GET /models`; the
extension fetches `http://127.0.0.1:<port>/models`. "One door to the vendor, not
two." The relay owns the vendor contract (headers, egress, session id); the
extension owns the exclusion list and the published shape.

S2b. A catalog that could not be read is not an empty catalog. Upstream failure
(429, offline, dead tunnel) surfaces as a readable state — relay `502 {ok:false,
reason}` — and must never render as "the service has no free models".

S3. Registration is live: after a successful relay install, call
`registerProvider` again with the real models. No Pi restart required.

S4. "Zero models at startup is NO LONGER a failure. Delete the fail-closed early
return and the error that hides the menu. Replace it with a menu item that says
the relay is not installed and offers to install it."

S5. Menu gating (progressive disclosure): "show only what is usable. Relay not
installed → only 'Instalar / actualizar relay' (hide estado). WARP not installed
→ hide 'Reciclar WARP'. Everything installed → the full seven-item list in the
agreed order."

## Evidence (container test, debian slim, `pi install npm:pi-free-bridge` 0.5.0)

- The extension LOADS: startup shows `[Extensions] pi-free-bridge`.
- Its commands are NOT registered: typing `/` lists only built-ins, `/free`
  filters to nothing.
- Cause: `discoverFreeModels()` reads `~/.cache/opencode/models.json`, finds
  nothing, and the factory does `return` before reaching `pi.registerCommand`.
- So "no OpenCode needed" was FALSE for the extension even though it is proven
  TRUE for the relay binary.

## Docs verified before relying on them

- `docs/custom-provider.md:13` — "Discover models dynamically — A provider with
  `refreshModels`".
- `docs/extensions.md:1980` — Pi calls `refreshModels` during model refresh and
  publishes the returned list.
- `docs/custom-provider.md:122` — "Calls made after initial extension loading
  take effect immediately. Use `pi.unregisterProvider()`…" and
  `docs/extensions.md:1976` adds "without requiring a `/reload`".

## Tasks

| ID | Spec | Route | State |
|----|------|-------|-------|
| T1 | S1, S4 | inline | done — commit `1e8a0f4` |
| T2 | S5 | inline | done — commit `1e8a0f4` |
| T3 | S1, S5 tests | inline | done — commit `1e8a0f4` |
| T4 | S2 | inline | done — commit `11036b8` |
| T5 | S3 | inline | done — commit `c29327d` |
| T6 | S2 amended, S2b | inline | done — commit `bdcc1e7` |

## Log

L1 (human, via the coordinating session, verbatim):

> THE FIX, in this order:
> 1. Register the three commands unconditionally, BEFORE any model discovery or early return. The menu is most needed exactly when there are no models.
> 2. Stop sourcing the catalog from OpenCode. The provider must implement `refreshModels` and take its list from the relay.
> 3. Registration is live: after a successful relay install, call `registerProvider` again with the real models. No Pi restart required.
> 4. Zero models at startup is NO LONGER a failure. Delete the fail-closed early return and the error that hides the menu.
> 5. Menu gating (progressive disclosure, dictated by the human): show only what is usable.

L2 (slice 1 decisions, T1-T3): the early `return` was the only thing preventing
registration, so the fix is surgical rather than a reordering of the factory.
Commands stay where they are; the provider registration became conditional
instead. Registered with an empty model list would have blanked the provider,
which is why item 1 is a guard and not an unconditional call.

L3 (slice 1 evidence): RED observed against `master` before the change — the new
zero-model test reports `actual: []` and `expected: ['free-bridge',
'free-bridge-warp-recycle', 'free-bridge-doctor']`. GREEN after: 204 pass, 0
fail (was 201). The test runs in a child process with `HOME` pointed at an empty
directory, because the pre-existing registration test only passes thanks to the
developer machine's OpenCode cache — it was green for the wrong reason.

L4 (open): T4 and T5 are untouched. S2 needs the provider to move from the
legacy `ProviderConfig` form to the native `Provider` form that supports
`refreshModels` (`docs/extensions.md:2084`), and S3 needs the install path to
re-register. Neither is claimed done.

L5 (slice 2 decisions): the fork was "new /models route in the relay" versus
"fetch the service directly". The relay has no catalog route at all — a live
GET /models returns {"error":{"message":"no route for GET /models"}} — so the
first option meant editing relay.mjs, rebuilding the binary and cutting a
release before the container test could see it. Fetching the service directly
removes the OpenCode dependency today with no release, so that was chosen. It
does not satisfy "from the relay" literally; that remains an option only if a
future release makes it free.

L6 (the trap that would have shipped broken): the service nests prices as
cost.text.<kind>.price, while the OpenCode cache file used flat numbers. The
existing isFree() looks for flat numbers, so pointing it at the live service
classifies ALL 86 models as paid and yields zero free models. The adapter
upstreamPrice() reads the nested shape with a flat fallback, and a model whose
price cannot be read is refused rather than assumed free.

L7 (slice 2 evidence): fetchUpstreamCatalog against the live service returns
12 free models, 74 skipped, and preserves longcat-2.5-free at context 1000000.
That is the same 12 the smoke test registered through the OpenCode cache, so
dropping OpenCode costs no models. Suite: 206 pass, 0 fail.

L8 (slice 3, T5/S3): the provider registration was duplicated three times
(startup, menu refresh, and now the post-install republish), which is how copies
drift apart. It is one function, publishCatalog(models), called by all three.
installOrUpdateRelay now uses the boolean runRelayInstallWithPrompt already
returned: on success it fetches the catalog and publishes it live, and on an
unreachable catalog it warns instead of failing. Registration after loading is
immediate per docs/custom-provider.md:122, so there is no restart to ask for.

L9 (test hygiene): the new catalog test passed alone and failed in the full
suite because an earlier test leaves PI_FREE_BRIDGE_SKIP_CATALOG=1 in
process.env and the child process inherits it. Fixed by pinning the variable to
"" in that child env. A test that only passes alone is not a test.

L10 (build note): "bun build index.ts" exits 1 on a node:url browser-polyfill
error because Bun defaults to a browser target; that is pre-existing and not a
regression. The truthful check is "bun build index.ts --target=node", which
exits 0. Earlier green build reports in this project were the exit status of a
piped tail, not of bun.

## Slice boundaries

- `L11` (measurement, not assumption): the direct call written in `427accd` was
  tested WITHOUT WARP before assuming it was broken — 3 consecutive requests to
  `opencode.ai/inference/v1/models` with the extension's exact headers returned
  HTTP 200 in 0.5-2.7s, 86 models, 12 free, **no 429**. So the direct call worked
  at measurement time, and moving the catalog onto the relay is architectural
  coherence (one door, one place for the vendor contract), NOT a fix for an
  observed failure. Recorded because the opposite was assumed by the requester
  and the honest answer is the boring one.
- `L12` (failure semantics, verified live): with a dead upstream
  (`RELAY_UPSTREAM=https://upstream.invalid/v1`) `GET /models` answers
  `502 {"ok":false,"reason":"... unreachable: getaddrinfo ENOTFOUND ..."}` while
  `/health` on the same relay still answers `ok:true`. With a real upstream the
  same route answers `200 {"ok":true,"models":[12],"skipped":74}`.
- `L13` (operational note): the relay exits 0 when stdin closes, by design, so
  an orphaned relay dies with its parent. Running it by hand for a check needs
  its stdin held open (`tail -f /dev/null | bun relay.mjs`), otherwise it looks
  like a crash.

The tooling reports this branch past the ~400 authored line review unit (~580
lines, 4 commits). It was split on purpose: each slice is a different failure,
and someone verifying one should not have to hold the others in their head.

- `88418c5` — S1, S4, S5. Verifiable alone: does the menu exist on a machine
  with no OpenCode, and does it hide what cannot work there.
- `427accd` — S2. Verifiable alone: 12 free models from the service and no
  registry read. This is the slice carrying the pricing-shape trap.
- `ee93ad1` — S3. Live publish after install, plus collapsing three copies of
  the provider registration into one `publishCatalog(models)`.
- `bdcc1e7` — S2 amended + S2b: the relay serves `GET /models`, the extension
  stops talking to the vendor, and a failed catalog stops looking like an empty
  one. Verifiable alone: curl the relay route with and without a reachable
  upstream and compare `200 {ok:true}` against `502 {ok:false,reason}`. About 250
  changed lines; ~751 accumulated on the branch, which is why this slice is
  recorded here rather than folded into `427accd`.
- `8e9e448` (peer-authored) and the README edits in this doc's branch — the
  claims that the extension needs no OpenCode and no Bun. They are true only
  because of the three commits above, so they must land with them and never on
  `master` alone. Publishing that text on `master` would ship a false claim.
- `L14` (consequence found by the owner's question, not by the tests): putting the
  catalog behind the relay created an ORDERING bug that could not exist while
  the extension had its own door — the catalog was fetched before `ensureRelay`
  ran, so a cold start asked a process that was not up yet, published nothing,
  and started the relay afterwards. Fixed in `cce57b2`: relay first, then its
  catalog. Not unit-tested, because exercising `ensureRelay` would spawn a real
  relay on the live port 8788; the tested consequence is the user-visible one.
- `L15` (honest limit of "one door"): the relay's `/models` route reuses the wire
  headers but NOT the WARP egress ladder. If the vendor ever blocks direct
  requests while `/v1` survives through the tunnel, the catalog returns a
  readable 502 and offers nothing. Making the route walk the same egress ladder
  as `forward` is the follow-up; it was not done here because there is no
  evidence today that direct access fails (L11).
