# pi-free-bridge

Puente [OpenCode](https://opencode.ai) solo-modelos-gratis para [Pi](https://github.com/earendil-works/pi-coding-agent).

Registra **únicamente** el tier gratuito anónimo de OpenCode bajo el provider id
**`oc-sdk-zen`** e inyecta él mismo el contrato de headers del gate, así que
sobrevive a `pi update` y no depende de ningún puente de terceros.

## Instalar

```bash
pi install C:\Users\Polanco\pi-free-bridge
pi list
pi -p --model oc-sdk-zen/space-bunny-free "Reply with exactly: OK"
```

Reemplaza al puente de terceros `pi-opencode-bridge`; **no corran los dos en paralelo**.
Sacalo con `pi remove npm:pi-opencode-bridge`.

## Qué registra

Siete modelos, descubiertos desde el registry de OpenCode
(`~/.cache/opencode/models.json`, clave `"opencode"`), filtrados a entradas cuyo
cada campo de costo declarado es cero **y** que la superficie efectivamente
publicita:

`big-pickle`, `cat-jam-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`,
`nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free`

Dos trampas del filtro, ambas medidas, ambas que conviene tener presentes:

- `cost.cache_write` **no existe** en la mayoría de los modelos gratis, así que
  testear los cuatro campos con `=== 0` clasifica como pagados a 36 de los 39
  modelos gratis del registry. El filtro usa cada campo *declarado*.
- 32 de esos 39 ya no los publicita `/inference/v1/models`. Registrarlos dejaría
  entradas permanentemente rotas en el picker, así que el set se interseca con la
  lista publicitada.

La lista publicitada es un snapshot fechado en `index.ts` para que el arranque
quede offline y determinístico; `/free-bridge-refresh` la re-pide, la persiste en
`~/.pi/agent/pi-free-bridge.json` y re-registra el provider.

Excluidos a propósito:

- `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`,
  `jev-1.13-free` — la superficie responde `400 ModelProtocolUnsupported` sobre
  chat/completions (y `403` en `/messages`). Fuera del picker para que no generen
  warnings al arrancar.

## Referencia de comandos

Todo lo que expone el puente en un solo lugar. Elegí por síntoma: ver
[Qué comando, cuándo](#qué-comando-cuándo).

### Dentro de una sesión de Pi (slash commands)

| Comando | Qué hace | Cuándo usarlo |
|---|---|---|
| `/free-bridge-models` | Lista los modelos efectivamente registrados y de dónde salió el registry | El picker se ve mal, o querés confirmar el filtro |
| `/free-bridge-session` | Muestra el session id en uso y su origen (env, config o constante incluida) | Si los requests empiezan a fallar — revisá el id antes de tocar código |
| `/free-bridge-session ses_…` | Cambia el session id de esta sesión **y lo persiste** en `~/.pi/agent/pi-free-bridge.json` | El gate responde `403` porque el id quedó viejo |
| `/free-bridge-refresh` | Pide `GET /inference/v1/models`, lo cruza con los gratis del registry, persiste el resultado y re-registra el provider | OpenCode agregó o sacó un modelo gratis |

### Terminal (fuera de Pi)

| Comando | Qué hace | Requiere red |
|---|---|---|
| `node repro.mjs [model-id]` | Dispara un request crudo contra el gate; espera `200 SSE-CHUNK (PASS)`. Sin argumento sondea `mimo-v2.6-flash-free` | sí |
| `node test/smoke.mjs` | Aserciona el registro contra el registry real: provider id, el set exacto de 7 modelos, cero fugas de modelos excluidos o pagados, los 5 headers requeridos, ninguna ruta retirada | no |
| `PI_FREE_BRIDGE_DRY_RUN=1 pi …` | Imprime origen del registry, superficie, api key, session id + origen, headers, modelos aceptados y descartados, y sigue normal | no |
| `pi -p --no-session --model oc-sdk-zen/<id> "Reply with exactly: OK"` | Sondeo end-to-end de un modelo a través de Pi | sí |
| `pi list` | Muestra los paquetes instalados (el nuestro aparece como `..\..\pi-free-bridge`) | no |
| `pi --list-models` | Muestra qué va a ofrecer el picker | no |
| `pi install C:\Users\Polanco\pi-free-bridge` | Reinstala el paquete (hace falta de nuevo si `pi update` lo pisa) | no |
| `pi remove npm:pi-opencode-bridge` | Saca el puente de terceros — ya ejecutado; nunca corran los dos | no |

### Entradas de configuración

| Entrada | Efecto |
|---|---|
| `PI_FREE_BRIDGE_SESSION_ID` | Sobreescribe el session id (máxima precedencia) |
| `~/.pi/agent/pi-free-bridge.json` → `sessionId` | Session id persistido |
| `~/.pi/agent/pi-free-bridge.json` → `liveIds` | Sobreescribe el snapshot de modelos publicitados |
| `PI_FREE_BRIDGE_DRY_RUN=1` | Diagnóstico de arranque |

Forma del archivo de config:

```json
{
  "sessionId": "ses_…",
  "liveIds": ["big-pickle", "…"]
}
```

Precedencia: env → config → constante incluida. Un config malformado o ausente
cae en silencio a los valores por defecto (verificado).

### Qué comando, cuándo

| Síntoma | Primer movimiento |
|---|---|
| Los modelos gratis devuelven `403` de golpe | `node repro.mjs`. Pasa → problema de session id: `/free-bridge-session`. Falla → el gate se movió de nuevo: re-derivarlo y actualizar `HANDOFF.md` §4 + `index.ts` |
| Falta un modelo en el picker | `/free-bridge-refresh`, y después `/free-bridge-models` |
| Entradas rotas o inesperadas en el picker | `node test/smoke.mjs` |
| Cambiaste el filtro o la receta de headers | `node test/smoke.mjs` (offline), después `node repro.mjs` (live) |
| Un modelo falla end-to-end pero el gate está sano | `pi -p --no-session --model oc-sdk-zen/<id> "Reply with exactly: OK"` para aislar ese modelo |
| El paquete desaparece después de `pi update` | `pi list`, y después `pi install C:\Users\Polanco\pi-free-bridge` |

## El contrato del gate

El tier gratuito de OpenCode solo atiende requests que parecen venir del cliente
oficial. Medido el 2026-10-14 capturando un request vivo de Pi a través de un
forwarder local y bisecteándolo; `HANDOFF.md` §4 de este repo tiene toda la
evidencia.

**Superficie:** `https://opencode.ai/inference/v1/chat/completions`
(`/zen/v1` responde 403 duro a todo cliente que no sea el oficial).

**Headers** — se requieren cinco, ni uno más:

| Header | Valor |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | debe contener `opencode/` |
| `authorization` | cualquier bearer; el puente usa la literal `public` (no hace falta key) |
| `x-opencode-session` | session id válido en el server |
| `x-opencode-session-id` | el mismo valor |

`x-opencode-client`, `x-opencode-project` y headers extra no son necesarios y **no
existe** regla de conteo (una revisión anterior de este doc decía ≥7; eso se midió
sobre un body inválido y está obsoleto).

**Body:**

- `stream: true` (`stream: false` → 403)
- un mensaje inicial `system` o `developer` (contenido y longitud libres)
- un array `tools` no vacío que contenga **ambos** nombres `read` **y** `bash`
  — los nombres se inspeccionan; `[read, bash]` en cualquier orden pasa,
  `[bash]` solo o dos nombres arbitrarios no

**Session id:** el gate rechaza ids autogenerados (`ses_<hex><base62>`,
`ses_000…`, basura) y no existe endpoint para crear sesiones, así que el puente
incluye una constante conocida. Si la superficie vuelve a responder 403, renovalo
sin tocar código:

```
/free-bridge-session                       # ver el id actual y su origen
/free-bridge-session ses_abc123…           # usar uno nuevo en esta sesión
```

y persistilo en `~/.pi/agent/pi-free-bridge.json`:

```json
{
  "sessionId": "ses_…",
  "liveIds": ["big-pickle", "…"]
}
```

`PI_FREE_BRIDGE_SESSION_ID` pisa al config.

## Pruebas

```bash
node test/smoke.mjs   # filtro, contrato de headers, fuga de excluidos/pagados — offline, sin red
node repro.mjs        # gate vivo — con red
```

`test/smoke.mjs` stubbea el `ExtensionAPI` de Pi y aserca el registro: provider id,
superficie, api key, el set exacto de 7 modelos, ausencia de modelos excluidos o
pagados, los cinco headers requeridos, y que la ruta retirada del Zen nunca llegue
al registro. Es la red de regresión del filtro y la receta de headers;
`repro.mjs` cubre el lado del vendor.

## Tripwire tras un cambio del vendor

`repro.mjs` es el canario. Correlo primero cada vez que los modelos gratis fallen:

```bash
node repro.mjs                      # -> 200 SSE-CHUNK (PASS)
node repro.mjs cat-jam-free         # sondear un modelo puntual
```

Un `403 FreeTierError` del tripwire significa que el gate se movió de nuevo —
re-derivarlo (capturar un request vivo de Pi, bisectar) y actualizar
`HANDOFF.md` §4 **e** `index.ts`. Si el tripwire falla pero el tráfico de Pi anda
bien, casi siempre venció el session id, no el puente.

## Notas

- El provider id `oc-sdk-zen` es load-bearing: `settings.json`,
  `~/.pi/gentle-ai/profiles.json` y `subagents.json` lo referencian.
- El registry se lee en cada arranque, así que un modelo gratis nuevo aparece
  sin actualizar el paquete; las bajas también se propagan. Nada se escribe
  de vuelta en ese archivo.
- No se guardan credenciales: el puente se autentica con la literal `public`.