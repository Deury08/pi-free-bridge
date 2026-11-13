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
| T4 | S2 | inline | **open** |
| T5 | S3 | inline | **open** |

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
