# relay-improvements

Portar a pi-free-bridge las piezas de `dsh-our-free-model` que sí aplican, descartando las que la medición contra la gate desmintió.
Un commit por función; PRs encadenados sobre `master` (default verificado: `refs/remotes/origin/master`).

## Specs

- **S1 — Clasificador de fallas tipado.** Portar el modelo de `src/route/classify.js`: `kind` (12 valores), `scope` (`request|account|provider|transient`), `retryable`, cool-down fijo o backoff exponencial con `backoffFor(level)`, y cadena de precedencia ordenada (`context_window → texto → código → frase de status → marker → capa de status`) con override de `retry-after`. Debe reemplazar las ramas ad hoc de `forward()` para 401, 402, 404, timeout, stream cortado y respuesta vacía, no solo el 429.
  - **Decisión del usuario (L3):** el scope de cuota queda **sin techo**. No se porta `MAX_PROVIDER_COOLDOWN_MS` (1800000) de A: `parkDurationMs` hoy no capa y el techo introduciría una regresión el mismo día de la cuota diaria.
- **S2 — Ledger only-extend.** Una escritura de cool-down solo puede **alargar** un deadline, nunca acortarlo (A: `accounts/core/selection.js` `withCooldown`). Aplica al ledger de cuota por IP (`parkQuotaEgress`), para que un park corto no borre uno largo.
- **S3 — `parseRetryAfterMs`.** Un parser único que acepta segundos enteros, HTTP-date, y `0` como "liberado ya". Reemplaza el `/^\d+$/` de `parkDurationMs`, que hoy descarta cualquier otra forma y deja el egress sin parkear.
- **S4 — Cuarta causa del `FreeUsageLimitError`.** Medido 2026-11-27: `stream: false` hacia el upstream devuelve `FreeUsageLimitError` idéntico al de cuota gastada. Documentar esa causa en `classifyGate429` (hoy enumera tres) y fijar con test que el body que sale hacia la gate siempre lleva `stream: true`.
- **S5 — Token saver.** Comprimir los tool outputs dentro de `messages` en el request saliente, fail-open, sin tocar nunca resultados de error. Arranca con tres filtros: `buildOutput`, `gitDiff`, `smartTruncate`. Licencia Apache-2.0 de RTK a verificar y atribuir antes de portar.
- **S6 — Diagnóstico por etapas.** Un registro por pedido con timestamps monótonos: `received → body_received → dispatch → first_delta → finished|aborted`. Sin bodies, sin headers, sin claves.
- **S7 — Proceso.** Un commit por función; PRs encadenados sobre `master`. Sin tocar el wire: A documenta un contrato v2 que la medición desmintió, así que `src/o2a/` de A no se porta.

## Tasks

- T1 · S2, S3 · parent · **✅ `966d72e`** `fix(relay): keep the longest quota park and parse date-form retry-after`
- T2 · S4 · parent · **✅ `c813867`** `docs(relay): name the non-streaming cause of FreeUsageLimitError`
- T3 · S1 · parent · **✅ `b4ef816`** `feat(relay): classify upstream failures by kind and scope`
- T4 · S5 · parent · **✅ `7e00e53`** `feat(relay): compress tool outputs before dispatch`
- T5 · S6 · worker · commit `feat(relay): record per-stage request diagnostics`
- T6 · S7 · parent · preparar ramas y cuerpos de PR encadenados

## Log

- **L1** (usuario, textual): `https://github.com/Ebony-Vinyl/dsh-our-free-model quiero analizar esta repo para ver que ppodemos sacar para mejorar mi proyecto free bridge`
- **L2** (usuario, textual): `entonces que traemos de esa repo`
- **L3** (usuario, textual): `osea lo del techo no porque tenemos el mecanismo de parquear las ips, pero de lo demas que es y como mejora mo proyecto`
- **L4** (usuario, textual): `un odd con todo vas haciendo comit por funcion y pr encadensdos,`
- **L5** (usuario, textual): `ademas vi que trae mas modelos sin loguearse, como es esto porsile?`
- **E1** — Medición 2026-11-27 contra `https://opencode.ai/inference/v1` (modelo `big-pickle`, ~35 pedidos). Reglas reales de la gate: (1) `stream: true` obligatorio, `stream: false` → `FreeUsageLimitError`; (2) hace falta un tool llamado `read`, array vacío o solo `shell` → `FreeUsageLimitError`. NO importan: fidelidad de description/schema, valor del UA (`opencode/1.19.3 ai-sdk/…` y `opencode/latest/2.1.0/cli` dan 200 los dos), `x-opencode-project`, ni el contenido del bloque `<env>`. El session id debe llevar prefijo `ses_` con 12 hex iniciales. `retry-after` medido: 77986 s hacia las 00:00 UTC — es un reloj, no un veredicto de causa. Conclusión: el wire v2 de A no se porta.
- **E2** — El relay instalado en `~/.local/.../npm/node_modules/pi-free-bridge/relay.mjs` es byte-idéntico al del repo (3696 líneas, v0.7.4). `relay.mjs:3668-3673` sale con código 0 cuando stdin se cierra: cualquier spawn de prueba necesita stdin abierto.
- **E3 — Punto de control pedido por el usuario (L6).** Tag anotado `checkpoint/pre-relay-improvements` (objeto `fc34255`) apuntando al commit `0fed4d2` = `master` v0.7.4, con la suite verde y **ninguna** de S1-S6 implementada. Volver: `git checkout checkpoint/pre-relay-improvements`. Para que cualquier commit fuera posible se configuró la identidad **solo en este repo** (`Deury08 <32344040+Deury08@users.noreply.github.com>`, la del historial): no había `user.*` ni local ni global y `git commit`/`git tag -a` fallaban con "Committer identity unknown".
- **E4 — Línea base medida en el tag** (worktree temporal sobre `0fed4d2`): `node --test test/relay.test.mjs` → **411/411 pass, 0 fail**; `node test/gate-tools.mjs` → OK. Después de T1: **418/418 pass, 0 fail** (7 tests nuevos). Los 411 previos siguen verdes, que es la evidencia diferencial de que only-extend no rompió el camino existente.
- **E5 — Dos subagentes fallaron por indisponibilidad del modelo** (`gentle-ai-explore` y `gentle-ai-worker`, ambos con el catálogo/timeout del provider, no por el trabajo). El worker de T1 dejó el andamiaje RED escrito antes de morir; el trabajo se cerró **inline** sobre ese RED, sin rehacerlo.
- **E6 — Slice 1 cerrado**: rama `fix/quota-park-only-extend` con T1 (`966d72e`) + T2 (`c813867`) + ODD (`a816780`), **255 líneas autoradas** sobre `master` y suite **419/419**. Es un slice completo y revisable por sí solo. T2 fue un test de guarda, no de fix: no hay RED posible porque el comportamiento ya era correcto; se verificó que muerde rompiendo el pin a propósito y viéndolo fallar.
- **E7 — Slice 2 cerrado**: rama `feat/failure-classifier` (encadenada sobre `fix/quota-park-only-extend`) con T3 (`b4ef816`), **569 líneas** respecto a su base (334 en `relay.mjs` + 223 de los 8 tests nuevos — supera los 400 como unidad única código+tests inseparable, sin cortes artificiales). Suite **427/427**, `gate-tools` OK. Nota: el contador del hook de commit suma contra `origin/master` (824); el diff propio del PR #2 contra su base `fix/quota-park-only-extend` es 569 líneas.
- **E8 — Slice 3 cerrado**: rama `feat/token-saver` (encadenada sobre `feat/failure-classifier`) con T4 (`7e00e53`), **509 líneas** respecto a su base (338 en `relay.mjs` + 157 en `test/relay.test.mjs` + 17 en `LICENSE` con atribución Apache-2.0 para la mitad `src/cmds/` de RTK y MIT para `dsh-our-free-model`, sin código BUSL-1.1). Suite **433/433**, `gate-tools` OK. Nota de licencia: la spec S5 pedía verificar y atribuir Apache-2.0 antes de portar — verificado en `A/LICENSE` y `src/token-saver/compact/*.js`.
