# Feature: compat-system-role

Que Pi emita `role: "system"` y `max_completion_tokens`→`max_tokens` para **todos**
los modelos de `oc-sdk-zen`, con lo que se arregla el último modelo gratis que
todavía fallaba (`inkling-2-small-free`). El arreglo va en el registro de modelos
(`index.ts`, `buildPiModels`), no en el transporte del relay.

## Specs

- S1 Todos los modelos que `buildPiModels` (`index.ts`, ~línea 1160) registra para
  el provider `oc-sdk-zen` llevan en su `compat`:
  `supportsDeveloperRole: false` y `maxTokensField: "max_tokens"`. Es un **default
  del provider**, aplicado a cada modelo, no a un subconjunto por familia.
- S2 El default se aplica por **merge, no por reemplazo**: los campos que ya
  declaraba cada familia sobreviven.
  - `deepseek` conserva `allowsSyntheticReasoningContentForToolCalls: false`.
  - `kimi` conserva `requiresReasoningContentForToolCalls: true` y
    `thinkingFormat: "zai"`.
- S3 Causa raíz (medida, no supuesta): `@earendil-works/pi-ai/dist/api/openai-completions.js:887`
  emite `role: "developer"` cuando `model.reasoning && compat.supportsDeveloperRole`;
  `detectCompat` (`:1260`) resuelve `supportsDeveloperRole: true` porque el
  provider se registra con `baseUrl` loopback y un id propio, así que no entra en
  la detección de "endpoint no estándar". Por el mismo falso positivo Pi elige
  `max_completion_tokens` en vez de `max_tokens` (`detectCompat`, `maxTokensField`).
- S4 Medición en el relay (`127.0.0.1:8788`, no directo al gate): con
  `role: "system"` responden `200` SSE **11/11** modelos registrados; con
  `role: "developer"`, 10/11. `inkling-2-small-free` devuelve exactamente
  `400 upstream failed: [airlock_error] invalid request: unknown variant 'developer', expected one of 'system','user','assistant','tool'`.
- S5 El cliente de referencia (OpenCode, `@ai-sdk/openai-compatible`) manda
  `system` para sus 134 modelos; en su binario no existe el valor de rol
  `developer`. Ese es el contrato real del gate.
- S6 Alcance cerrado: NO se toca la clasificación gratis/pago, el registry,
  `liveIds` ni `SNAPSHOT_LIVE_FREE_IDS`; NO se reescriben roles dentro de
  `relay.mjs` (su invariante es reenvío byte-exacto y solo completa `tools` y
  `<env>` cuando faltan); NO se aplica esto a otros providers (`nvidia`,
  `opencode-go`), donde `developer` puede ser correcto.
- S7 `test/smoke.mjs` afirma que **cada** modelo registrado lleva
  `supportsDeveloperRole: false` y `maxTokensField: "max_tokens"`, y que
  `deepseek`/`kimi` conservan su `compat` propio (S1, S2).
- S8 End-to-end por el puente:
  `pi -p --no-session --model oc-sdk-zen/inkling-2-small-free "Reply with exactly: OK"`
  devuelve `OK`. Antes del fix devuelve el `400 airlock_error` de S4.
- S9 Regresión:
  `pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"`
  devuelve `OK`.
- S10 Documentación: `README.md` (la sección del contrato del gate menciona
  system/developer) y `CHANGELOG.md` describen el cambio.
- S11 `test/smoke.mjs` **no** compara el set registrado contra una lista exacta
  hardcodeada: afirma invariantes sobre el set real. Todo id registrado existe en
  el registry de OpenCode y su costo declarado es todo cero; todo modelo apunta a
  `http://127.0.0.1:<puerto>/v1`; ningún id de `EXCLUDED_MODELS` está registrado;
  ningún id registrado es de pago; el set registrado es subconjunto del registry
  y del config. `REQUIRED_MODELS` pasa a ser un subconjunto que **debe** estar
  presente, no el set exacto. Un set exacto se rompe cada vez que el catálogo
  cambia, que es justo lo que este proyecto hace seguido (L6).
- S12 Riesgo conocido, fuera de alcance: `modalities.input` en la superficie usa
  MIME (`image/jpeg`) y `buildPiModels` filtra a `["text","image"]`. Si el
  refresh migra a leer `modalities` de la superficie sin normalizar, los modelos
  VL se registran como solo-texto (L4).

## Tasks

- T1 · S1, S2 · inline/worker · merge del `compat` default en `buildPiModels` (`index.ts`)
- T2 · S7, S11 · worker · aserciones `compat` + invariantes de set en `test/smoke.mjs`
- T3 · S10 · worker · `README.md` + `CHANGELOG.md`
- T4 · S8, S9 · parent · verificación end-to-end por el puente (bloqueada por L5)
- T5 · S1-S3 · parent · suite (`test/relay.test.mjs`, `test/gate-tools.mjs`) + commit de unidad

## Log

- L1 (pedido original, verbatim):
  TAREA (rama propia, no master): hacer que Pi emita `system` + `max_tokens` para
  todos los modelos de `oc-sdk-zen`, y con eso arreglar el último modelo gratis
  que falla.

  ## El cambio
  Archivo `index.ts`, función `buildPiModels` (~línea 1160). Hoy solo setea
  `model.compat` para las familias deepseek y kimi. Hay que agregar un default del
  provider para TODOS los modelos de `oc-sdk-zen`:

  ```ts
  model.compat = {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    ...existingFamilyFields,   // NO pisar deepseek/kimi
  };
  ```

  Merge, no reemplazo: `deepseek` ya usa
  `allowsSyntheticReasoningContentForToolCalls: false` y `kimi` usa
  `requiresReasoningContentForToolCalls: true` + `thinkingFormat: "zai"`. Esos
  campos tienen que sobrevivir.

  ## Por qué (medido hoy, por el relay en 127.0.0.1:8788, no directo al gate)
  - Con `role: "system"`: **11/11** modelos registrados responden `200` SSE.
  - Con `role: "developer"`: 10/11; `inkling-2-small-free` devuelve
    `400 upstream failed: [airlock_error] invalid request: unknown variant 'developer', expected one of 'system','user','assistant','tool'`.
  - Causa raíz: `@earendil-works/pi-ai/dist/api/openai-completions.js:887` usa
    `role: "developer"` cuando `model.reasoning && compat.supportsDeveloperRole`;
    `detectCompat` (`:1260`) resuelve `supportsDeveloperRole: true` porque el
    provider se registra con `baseUrl` loopback y un id propio, así que no entra
    en la detección de "endpoint no estándar".
  - El cliente de referencia (OpenCode, `@ai-sdk/openai-compatible`) manda
    `system` para sus 134 modelos; en su binario no existe ningún valor de rol
    `developer`. Ese es el contrato real del gate.
  - Segundo motivo, latente: por el mismo falso positivo, Pi manda
    `max_completion_tokens` cuando `detectCompat` (`:1260`, `maxTokensField`)
    elige `max_tokens` para endpoints no estándar. Hoy los backends lo toleran;
    si uno lo ignora, la respuesta se trunca sin error visible.

  ## Alcance cerrado
  - NO tocar la clasificación de gratis/pago, el registry, `liveIds` ni
    `SNAPSHOT_LIVE_FREE_IDS`.
  - NO reescribir roles dentro de `relay.mjs`: su invariante es reenvío
    byte-exacto y solo completa `tools` y `<env>` cuando faltan. El arreglo va en
    el registro, no en el transporte.
  - NO aplicar esto a otros providers (nvidia, opencode-go): ahí `developer`
    puede ser correcto.

  ## Rama y commits
  - El working copy `C:\Users\Polanco\pi-free-bridge` está en
    `feat/warp-429-contingency` (`b62b042`), un commit atrás de `master`
    (`967e6d9`). Ramá desde `origin/master` con un nombre tipo
    `fix/compat-system-role`. No rebasees, no forces nada, no toques el remoto sin
    autorización explícita del humano.
  - Un commit de unidad de trabajo (código + test + docs juntos), Conventional
    Commit. **No pushear ni abrir PR** sin que el humano lo pida.

  ## Verificación obligatoria
  1. `node --test test/relay.test.mjs`
  2. `node test/gate-tools.mjs`
  3. `node test/smoke.mjs` — agregá la aserción de que los modelos registrados
     llevan `supportsDeveloperRole: false` y `maxTokensField: "max_tokens"`, y que
     deepseek/kimi conservan su compat propio.
  4. End-to-end por el puente:
     `pi -p --no-session --model oc-sdk-zen/inkling-2-small-free "Reply with exactly: OK"`
     → debe devolver `OK`. Antes del fix devuelve el `400 airlock_error`.
  5. Regresión:
     `pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"`
     → `OK`.

  Nota: el pedido válido al relay es `POST http://127.0.0.1:8788/v1/chat/completions`
  con `stream: true`, un mensaje inicial system y `tools` con `read` y `bash`. El
  relay agrega los headers del gate y el session id.

  ## Documentación
  Actualizá `README.md` (la sección del contrato del gate menciona
  system/developer) y `CHANGELOG.md`. Si el repo usa ODD, espejá en el documento de
  feature y en Engram.

- L2 (evidencia, parent): rama `fix/compat-system-role` creada desde
  `origin/master` = `967e6d9`. El árbol de trabajo tenía solo `.tmp-probe/`
  (untracked, ajeno a esta tarea). No se rebaseó nada.
- L3 (evidencia, parent): el bloque actual de `buildPiModels` asigna
  `model.compat` dos veces, una por familia, y **deja `compat` sin definir** para
  las demás — o sea `detectCompat` decide. Confirmado por lectura de
  `index.ts:1159-1172`.
- L4 (riesgo conocido, reportado por el peer M1): `modalities.input` en la
  superficie usa MIME (`image/jpeg`), y `buildPiModels` filtra a
  `["text","image"]`. Si el refresh migra a leer `modalities` de la superficie
  sin normalizar, los modelos VL se registran como solo-texto. Se anota, no se
  arregla en esta rama.
- L5 (bloqueo de verificación, reportado por el peer M1): el e2e de S8/S9 **no se
  puede probar todavía**: `pi -p` carga la extensión instalada desde git
  (`.gentle-shell/agent/git/github.com/Deury08/pi-free-bridge`), no este working
  copy. Se prueba después de pushear y reinstalar, con autorización explícita del
  humano. No se cambió la instalación.
- L6 (corrección de requisito, verbatim del peer M1): «Arreglá `smoke.mjs` sin
  tocar `liveIds` ni el snapshot. Reemplazá la aserción de set exacto por
  aserciones de invariantes, que es lo que el test debería estar cuidando:
  - todo id registrado existe en el registry y tiene costo declarado todo en cero;
  - todo modelo apunta a `http://127.0.0.1:<puerto>/v1`;
  - ningún id de `EXCLUDED_MODELS` está registrado;
  - ningún id registrado es de pago;
  - el set registrado es subconjunto del registry y del config.» Causa: el test
  comparaba contra un set exacto hardcodeado de 8 ids y el config real registra
  11 (`crouton-alpha-free`, `iceman-free`, `inkling-2-small-free` de más).
  `node --test test/relay.test.mjs` → 164/164 OK y `node test/gate-tools.mjs` →
  OK ya verificados por el peer; no se repiten.
