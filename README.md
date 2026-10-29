# pi-free-bridge

Puente [OpenCode](https://opencode.ai) solo-modelos-gratis para [Pi](https://github.com/earendil-works/pi-coding-agent).

Registra **únicamente** el tier gratuito anónimo de OpenCode bajo el provider id
**`oc-sdk-zen`** e inyecta el contrato del gate desde un relay local ejecutado por
Bun, así que sobrevive a `pi update` y no depende de ningún puente de terceros.

## Instalar

```bash
pi install C:\Users\Polanco\pi-free-bridge
pi list
pi -p --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
```

Reemplaza al puente de terceros `pi-opencode-bridge`; **no corran los dos en paralelo**.
Sacalo con `pi remove npm:pi-opencode-bridge`.

## El relay de Bun (requisito)

El gate de `/inference/v1` ahora inspecciona el fingerprint TLS del cliente y
solo acepta clientes que se parezcan a Bun. Pi 1.2.0 corre sobre Node, así que
ningún request que salga desde Pi puede pasar el gate, sin importar los headers
ni el cuerpo. Por eso la extensión ya no llama a OpenCode: levanta un relay
local ejecutado por Bun y apunta el provider a `http://127.0.0.1:<puerto>/v1`.

```
Pi (Node) → http://127.0.0.1:<puerto>/v1/chat/completions → relay (Bun) → upstream
```

El relay es el único proceso que abre la conexión TLS contra OpenCode. Ahí viven
los headers del gate, el session id, el bloque `<env>` con `Working directory:`
y las tools `read`/`bash`. La respuesta vuelve byte por byte, sin parsear y sin
reescribir ningún chunk.

### Bun es obligatorio

La extensión resuelve el ejecutable en este orden:

1. `PI_FREE_BRIDGE_BUN` (ruta explícita al binario)
2. `bun` en `PATH` (en Windows, `bun.exe`)
3. `~/.bun/bin/bun.exe`

Si no encuentra ninguno, `/free-bridge-doctor` muestra `bun: MISSING` y el
primer request falla con un error que indica cómo instalarlo. Instalación:
<https://bun.sh>.

### Puerto

Por defecto el relay escucha en `127.0.0.1:8788` y expone `GET /health`, que
devuelve el session id efectivo y de dónde salió:

```json
{"service":"pi-free-bridge-relay","ok":true,"sessionId":"ses_…","sessionSource":"opencode.db"}
```

`sessionSource` es `env`, `config`, `opencode.db` o `session-diff`. El puerto se
puede cambiar con:

1. `PI_FREE_BRIDGE_RELAY_PORT`
2. `relayPort` en `~/.pi/agent/pi-free-bridge.json`
3. `8788`

Si el puerto está ocupado, la extensión primero prueba `/health`: si responde
con `{"service":"pi-free-bridge-relay","ok":true}` reutiliza ese relay; si
responde otra cosa, falla con un mensaje que pide elegir otro puerto. Para
liberarlo, cerrá la instancia anterior de Pi o cambiá el puerto:

```bash
PI_FREE_BRIDGE_RELAY_PORT=8790 pi
```

En PowerShell: `$env:PI_FREE_BRIDGE_RELAY_PORT = 8790` y después `pi`.

El relay se apaga solo cuando Pi termina (su stdin se cierra), así que no quedan
procesos huérfanos. Un relay reutilizado pertenece a otra instancia de Pi y no
se toca.

### Cómo verificar que funciona

```bash
node --test test/relay.test.mjs          # helpers del relay — offline
bun test/proxy-failover.e2e.mjs          # failover directo→proxy con un proxy mock
curl http://127.0.0.1:8788/health        # relay vivo
pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
```

Dentro de Pi, `/free-bridge-doctor` informa la ruta de Bun, el puerto, si el
relay está `running`, `reused` o `not started`, y la URL upstream.

## Qué registra

Nueve modelos, descubiertos desde el registry de OpenCode
(`~/.cache/opencode/models.json`, clave `"opencode"`), filtrados a entradas cuyo
cada campo de costo declarado es cero **y** que la superficie efectivamente
publicita:

`beam-free`, `big-pickle`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`,
`longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `minimax-m3.1-flash-free`,
`nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`

Ese es el snapshot que el paquete trae para arrancar offline; el set real cambia
con el tiempo (hoy la superficie publica otro conjunto). `/free-bridge-refresh` lo
re-pide y lo persiste, que es la forma de actualizarlo sin tocar código.

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
| `/free-bridge-session` | Muestra el session id que el relay está mandando y su origen (`env`, `config`, `opencode.db` o `session-diff`) | Si los requests empiezan a fallar — mirá el id antes de tocar código |
| `/free-bridge-session ses_…` | Cambia el session id de esta sesión **y lo persiste** en `~/.pi/agent/pi-free-bridge.json` | El gate responde `403` porque el id quedó viejo |
| `/free-bridge-refresh` | Pide `GET /inference/v1/models`, lo cruza con los gratis del registry, persiste el resultado y re-registra el provider | OpenCode agregó o sacó un modelo gratis |

### Terminal (fuera de Pi)

| Comando | Qué hace | Requiere red |
|---|---|---|
| `node repro.mjs [model-id]` | Dispara un request crudo contra el gate; espera `200 SSE-CHUNK (PASS)`. Sin argumento sondea `mimo-v2.6-flash-free` | sí |
| `node test/smoke.mjs` | Aserciona el registro contra el registry real: provider id, el set exacto de modelos gratis, cero fugas de modelos excluidos o pagados, y que cada modelo apunte al relay local | no |
| `PI_FREE_BRIDGE_DRY_RUN=1 pi …` | Imprime origen del registry, superficie, api key, session id + origen, modelos aceptados y descartados, y sigue normal | no |
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
| `~/.pi/agent/pi-free-bridge.json` → `relayPort` | Puerto del relay (por defecto `8788`) |
| `PI_FREE_BRIDGE_RELAY_PORT` | Pisa el puerto del relay |
| `PI_FREE_BRIDGE_BUN` | Ruta explícita al ejecutable de Bun |
| `PI_FREE_BRIDGE_DRY_RUN=1` | Diagnóstico de arranque |
| `~/.pi/agent/pi-free-bridge.json` → `proxy` | Pool de proxies del failover (ver abajo) |
| `RELAY_PROXY_STATIC` | Lista de proxies separada por comas (pisa el config) |
| `RELAY_PROXY_SOURCE` | URL de una lista cruda de proxies (una por línea) |
| `RELAY_PROXY_MAX` | Tamaño máximo del pool (por defecto `5`) |
| `RELAY_PROXY_REFRESH_MINUTES` | Cada cuánto se re-pide `RELAY_PROXY_SOURCE` (por defecto `30`) |
| `RELAY_PROXY_TIMEOUT_MS` | Tope hasta las cabeceras de cada intento (por defecto `15000`) |

Forma del archivo de config:

```json
{
  "sessionId": "ses_…",
  "liveIds": ["big-pickle", "…"],
  "relayPort": 8788,
  "proxy": {
    "static": ["http://1.2.3.4:8080"],
    "source": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "refreshMinutes": 30
  }
}
```

Precedencia del session id: `PI_FREE_BRIDGE_SESSION_ID` → `sessionId` del config →
cosecha automática desde el store de OpenCode. Un config malformado o ausente
cae en silencio a la cosecha (verificado).

### El picker está acotado por `enabledModels`

El selector de modelos de Pi **no** ofrece todo lo que el puente registra: lo acota
la lista `enabledModels` de `~/.pi/agent/settings.json`. Vacía → el picker ofrece todo
lo disponible. Con entradas → el picker ofrece **solo** esas.

Esto explica la contradicción más común: `pi --list-models` muestra los 7 modelos y el
picker no. **Son rutas distintas** — la CLI usa `getAvailable()`, el picker usa el scope
de `enabledModels`.

El puente necesita esa entrada, con **glob** y no ids literales. Se **agrega** a la lista
que ya tenés, no la reemplaza: si copiás este bloque tal cual sobre un `settings.json`
que ya tiene otras entradas, borrás esos modelos del picker.

```jsonc
// ~/.pi/agent/settings.json
"enabledModels": [
  "opencode-go/…",   // lo que ya tengas — no lo toques
  "oc-sdk-zen/*"     // lo único que necesita el puente
]
```

`oc-sdk-zen/*` cubre todos los modelos del momento y también los que agregue
`/free-bridge-refresh`. Con ids literales (`oc-sdk-zen/deepseek-v4.1-flash-free`, …) todo
modelo nuevo queda invisible hasta que edites la lista a mano, y es fácil olvidarse de
alguno: el síntoma es "falta un modelo en el picker" sin ningún error que lo explique.

### El puente repara el scope solo

No hace falta que edites `settings.json` a mano, ni después de un reinstall. En cada
arranque la extensión revisa `enabledModels` y, si le falta `oc-sdk-zen/*`, **se lo
agrega sola**.

El arreglo es append-only e idempotente: nunca borra, nunca reordena, nunca reescribe
una entrada existente y no toca ninguna otra clave del archivo. El insertado es a nivel
de bytes, no un round-trip de JSON — por eso no te reformatea el archivo ni te cambia
los CRLF a LF. Si el glob ya está, no escribe nada.

Si la lista está **ausente o vacía**, tampoco hace nada, y es a propósito: una lista
vacía deja el picker sin scope (muestra todo), así que agregar el glob ahí lo
*achicaría* en vez de arreglarlo. El bug solo existe cuando la lista tiene algo.

⚠️ **Pi resuelve el scope una sola vez, al arrancar, y nunca vuelve a leer
`settings.json`.** Si el arreglo se aplicó, el picker de esa sesión sigue como estaba:
**reiniciá Pi**.

⚠️ Si en `/models` guardás la selección, Pi reescribe la lista con los ids elegidos y
**pierde el glob**. No pasa nada: el próximo arranque lo repone.

Para ver qué está pasando y repararlo a mano cuando quieras:

```
/free-bridge-doctor
```

Diagnostica y repara: lista lo registrado, el session id, los modelos salteados y el
estado del scope. Si no puede escribir, dice exactamente por qué y qué editar a mano.

Comprobar que el scope resuelve (cero `No models match pattern` = todo patrón matcheó):

```bash
pi -p --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
```

### Qué comando, cuándo

| Síntoma | Primer movimiento |
|---|---|
| Los modelos gratis devuelven `403` de golpe | `node repro.mjs`. Pasa → problema de session id: `/free-bridge-session`. Falla → el gate se movió de nuevo: re-derivarlo y actualizar `HANDOFF.md` §4 + `index.ts` |
| Falta un modelo en el picker | `/free-bridge-doctor` — repara el scope y dice por qué. Solo si `oc-sdk-zen/*` ya figura ahí: reiniciá Pi, después `/free-bridge-refresh`, y por último `/free-bridge-models` |
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
(`/zen/v1` responde 403 duro a todo cliente que no sea el oficial). Pi no habla
con esta superficie: habla con el relay, que reenvía acá desde Bun.

**Headers** — se requieren cinco, ni uno más (los fija el relay):

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
`ses_000…`, basura) y no existe endpoint para crear sesiones. El paquete **no
incluye** ningún id: el relay cosecha uno del store local de OpenCode al
arrancar, en este orden:

1. `RELAY_SESSION` — sólo lo setea la extensión cuando hay un override explícito.
2. La sesión más nueva de `~/.local/share/opencode/opencode.db`
   (`select id from session order by time_created desc limit 5`, primero que
   empiece con `ses_`). Se abre en modo lectura y cualquier falla se ignora.
3. El archivo `ses_*.json` más reciente por mtime en
   `~/.local/share/opencode/storage/session_diff/`.

Si ninguno existe, el relay no arranca y escribe una sola línea accionable:
corré OpenCode una vez o seteá `PI_FREE_BRIDGE_SESSION_ID`.

Para forzar otro id:

```
/free-bridge-session                       # ver el id efectivo y su origen
/free-bridge-session ses_abc123…           # usar uno nuevo y persistirlo
```

El id forzado se persiste en `~/.pi/agent/pi-free-bridge.json`:

```json
{
  "sessionId": "ses_…",
  "liveIds": ["big-pickle", "…"]
}
```

`PI_FREE_BRIDGE_SESSION_ID` pisa al config. Cualquiera de los dos gana sobre la
cosecha; si querés volver a la cosecha, borrá la clave del config y reiniciá Pi.

### Requests sin tools (compactación, `/compact`, resúmenes de rama)

El requisito de `tools` aplica a **toda** request, y las llamadas one-off de Pi arman
su contexto con un system prompt y **ninguna tool** — por eso volvían `403
FreeTierError` mientras el turno normal de conversación funcionaba:

- `pi-coding-agent/dist/core/compaction/compaction.js:498` — `buildSummarizationContext`
  arma el contexto con un system prompt y un mensaje `user`; sin `tools`.
- `pi-coding-agent/dist/core/compaction/branch-summarization.js:224` — la misma forma
  para el resumen de rama.
- `pi-ai/dist/utils/transcript.js:41` — `getCurrentTools` resuelve las tools
  replayando en orden cada delta `toolsAdded`/`toolsRemoved` de los system messages.
- `pi-ai/dist/api/openai-completions.js:600` — `params.tools` sólo se agrega cuando el
  transcript resuelto trae tools, así que un contexto sin tools no manda el array.

El relay completa el array `tools` en el wire antes de reenviar: si falta o está
vacío, inyecta declaraciones mínimas de `read` y `bash`; si tiene sólo una de
las dos, agrega únicamente la que falta. Cuando el array se modifica, fija
`tool_choice` en `"none"` para que una request de resumen nunca pueda invocarlas.
Un array que ya trae ambos nombres pasa intacto. La misma regla aplica al bloque
`<env>`: se agrega sólo si el system prompt no lo tiene.

`gateRequestContext` sigue en `index.ts` como implementación de referencia a
nivel de contexto y la ejercita `test/gate-tools.mjs`; el camino de ejecución de
Pi ya no la usa. La resolución de tools de Pi está reimplementada en forma local
porque `@earendil-works/pi-ai` lo provee el host y no se resuelve desde la
carpeta de este paquete (un import estático falla con `ERR_MODULE_NOT_FOUND` y
rompe los tests independientes), así que el puente no le agrega ninguna
dependencia en runtime.

## Failover por proxy (opcional)

El relay sale **directo** a OpenCode como siempre. Los proxies existen solo para
cuando la IP directa deja de servir: es un salvavidas, no el camino normal.

```text
preferencia:  directo → proxy1 → proxy2 → …

1. arranque:            sale directo
2. directo falla:       rota al primer proxy del pool
3. un proxy anda:       se queda en ese proxy (no rota por request)
4. ese proxy falla:     se lo descarta y pasa al siguiente
5. todos descartados:   vuelve a probar directo
```

Reglas del pool:

- Solo `http`/`https`: Bun rechaza `socks5://` con `UnsupportedProxyProtocol`
  (medido). Una línea `host:puerto` se interpreta como `http`.
- Un proxy que falla (error de red, HTTP 429) se descarta por una ventana igual al
  ciclo de refresco y vuelve solo cuando el pool se refresca.
- Los reintentos ocurren **antes** de mandar la primera cabecera al cliente: un
  stream ya empezado nunca se reenvía.
- Sin `proxy` configurado, el camino es exactamente el de antes (sin overhead).

### Modo forzado (probar los proxies sin quemar la IP)

Por defecto el pool es un salvavidas. Si querés que los proxies salgan **primero**
aunque tu IP directa todavía tenga cuota — por ejemplo para e2e, o porque sospechás
que te marcaron — activá el modo forzado. `directo` queda **último**, así un pool
muerto degrada al comportamiento normal en vez de dejarte sin servicio:

```text
forzado:  proxy1 → proxy2 → … → directo
```

Tres formas de prenderlo, de más estable a más quirúrgica:

| Alcance | Cómo |
| --- | --- |
| Relay entero (config) | `"proxy": { "force": true }` en `pi-free-bridge.json` |
| Relay entero (env) | `RELAY_PROXY_FORCE=1` |
| Un solo request | header `x-free-bridge-force-proxy: 1` |

El header no toca estado compartido, así que es el que conviene para tests: fuerza
el pool en esa llamada y las concurrentes quedan como estaban.

### Modo test: `/free-bridge-proxy`

```
pi-free-bridge proxy
  preference: http://1.2.3.4:8080 -> direct
  forced:     yes — the pool is preferred over direct
  last egress: http://1.2.3.4:8080
  direct: ok (HTTP 200, 180 ms)
  http://1.2.3.4:8080: ok (HTTP 200, 640 ms)
  http://5.6.7.8:3128: DEAD — ConnectionRefused
```

Sondea `directo` y cada proxy en paralelo contra `<upstream>/models`: **cualquier**
respuesta HTTP (aunque sea 404) prueba que el túnel anda, así no confundís un proxy
sano con el gate enojado. `lastEgress` te dice quién sirvió la última request, que
es la evidencia dura de que el proxy se usó de verdad.

Por HTTP directo, para scripts:

```bash
curl -s http://127.0.0.1:8788/proxies | python -m json.tool
```

Verificación local del camino completo (proxy mock, sin red real):

```bash
bun test/proxy-failover.e2e.mjs
```

## Pruebas

```bash
node --test test/relay.test.mjs  # helpers del relay: <env>, tools, mapeo de URL, cosecha de sesión — offline
node test/gate-tools.mjs  # inyección de read/bash a nivel de contexto — offline
node test/smoke.mjs   # filtro y registro contra el relay local — offline
node repro.mjs        # gate vivo — con red
```

`test/relay.test.mjs` cubre las funciones puras de `relay.mjs` sin Bun y sin red,
incluida la cosecha de sesión contra un store temporal (`opencode.db` y
`session_diff/`), sin fixture de SQLite.
`test/gate-tools.mjs` cubre el contrato de tools a nivel de transcript.
`test/smoke.mjs` aserciona el registro contra el registry real: el provider y
todos los modelos apuntan a `http://127.0.0.1:<puerto>/v1`, y el provider ya no
declara headers (los pone el relay).

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