# pi-free-bridge

Puente [OpenCode](https://opencode.ai) solo-modelos-gratis para [Pi](https://github.com/earendil-works/pi-coding-agent).

Registra **únicamente** el tier gratuito anónimo de OpenCode bajo el provider id
**`oc-sdk-zen`** e inyecta el contrato del gate desde un relay local ejecutado por
Bun, así que sobrevive a `pi update` y no depende de ningún puente de terceros.

## Instalar

Siete pasos, todos desde el terminal. Las capturas son de una instalación real
en Windows: si tu pantalla se parece a la de la foto, vas bien.

Los pasos 3 a 5 son solo para WARP. Si no lo querés, los podés saltear: el puente
funciona igual contra tu IP directa.

### 1. Instalar la extensión

Escribí el comando en el terminal y dale Enter:

```bash
gentle-shell install git:github.com/Deury08/pi-free-bridge
```

![Escribiendo el comando de instalación](<Imagenes/Comando ParaInstalar.png>)

### 2. Confirmar que quedó instalada

El comando clona el repo y termina con `Installed
git:github.com/Deury08/pi-free-bridge` en verde. Si no ves esa línea, no sigas:
volvé a correr el paso 1.

![Salida del comando con la línea Installed](<Imagenes/Instalado.png>)

### 3. Activar WARP

Dentro de Pi escribí `/free-bridge-warp` (con el `/` aparece el autocompletado;
Enter lo selecciona).

![Autocompletado del comando free-bridge-warp](<Imagenes/Activando%20Warp.png>)

### 4. Aceptar la descarga de `warp-minimal`

Si no tenés WARP corriendo ni el binario instalado, Pi te lo pregunta antes de
bajar nada: te muestra la versión, el tamaño, de dónde lo baja y dónde lo
instala. Elegí **`Yes`** y verifica el checksum solo.

![Diálogo de confirmación de descarga de warp-minimal](<Imagenes/Instalando%20Warp.png>)

### 5. Elegir el modo

- **`auto`** — primero tu IP directa y WARP solo ante rate limit. Es el modo
  recomendado para empezar.
- **`on`** — siempre WARP.
- **`off`** — siempre directo.

El cambio aplica en el próximo request, sin reiniciar nada.

![Menú con los tres modos de WARP](<Imagenes/Configurando%20Warp.png>)

### 6. Elegir un modelo gratis

`/model` abre el picker. Los del tier gratuito terminan en `-free` y vienen del
provider `oc-sdk-zen`; en la captura están agrupados bajo `[oc-sdk-zen]` junto a
los de `nvidia`. El panel de la derecha tiene que decir `pi-free-bridge · ready`.

![Picker con los modelos gratuitos del provider oc-sdk-zen](<Imagenes/Modelos%20Disponibles.png>)

### 7. Usarlo

Escribí cualquier cosa y mirá el pie: `ctx` sube, el costo queda en **`$0.000`**.
Eso es el tier gratuito funcionando a través del relay.

![Conversación respondiendo con costo $0.000](<Imagenes/Usando%20Modelos.png>)

### Alternativa: desde el repo clonado

Si ya tenés el repo en disco, la instalación es la misma que cualquier
extensión local:

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
curl http://127.0.0.1:8788/health        # relay vivo
pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
```

Dentro de Pi, `/free-bridge-doctor` informa la ruta de Bun, el puerto, si el
relay está `running`, `reused` o `not started`, y la URL upstream.

## Cosecha de session id (híbrida)

El gate solo confía en session ids creados por el cliente oficial de OpenCode;
nunca se mintea uno sintético (los rechaza con `429`). La cosecha corre **en los
dos lados** (bun-upgrades S2):

- **La extensión (Pi)** cosecha del store local de OpenCode — `opencode.db` vía
  `node:sqlite`, y si falla el archivo más reciente de
  `storage/session_diff/ses_*.json` — y se lo pasa al relay en
  `RELAY_SESSION_PI`. Esto funciona con Pi y OpenCode en máquinas separadas.
- **El relay (Bun)** cosecha de su propio store cuando nadie le pasa un id.

Precedencia en el arranque del relay: override del usuario
(`PI_FREE_BRIDGE_SESSION_ID` / `config.sessionId` / `RELAY_SESSION`) > id
cosechado por Pi (`RELAY_SESSION_PI`) > cosecha local del relay. El origen
quedará visibible en `/health` (`sessionSource`) y `/free-bridge-session`:
`env`, `config`, `pi-harvest`, `opencode.db` o `session-diff`.

## Egress WARP (`off` / `auto` / `on`)

[`warp-minimal`](https://github.com/Deury08/warp-minimal) es el proxy que aporta la
salida (puerto `127.0.0.1:8789`, `warp_enabled` opcional). Es un proyecto aparte
del relay: registra las salidas WARP, publica su pool en `/health` y expone
`/swap` y `/recycle`. De él vienen la salida alternativa cuando el egress directo
está bloqueado o saturado de rate limit. Tres modos (bun-upgrades S5):

- **`off`** (default): todo directo; el relay nunca toca WARP.
- **`auto`**: directo primero; si llega un `429` **antes del primer byte**, el
  mismo request se reintenta por WARP. Si un request solo sale por WARP, los
  siguientes prueban WARP primero (con local de backoff, así un WARP caído no
  rompe el puente).
- **`on`**: todo por WARP; si WARP no responde, el request falla con el
  diagnóstico de egreso.

Regla invariante: **no hay failover a mitad de stream.** Si la conexión muere
después del primer byte, el stream termina tal como está — reintentarlo
corrompería la respuesta SSE.

**Modo del cable (v1 / v2):** `/free-bridge-wire` sin argumentos abre un selector
con las dos versiones y marca cuál está activa; `/free-bridge-wire v1|v2` la fija.
Se guarda como `wireMode` en el mismo config y el relay lo relee en cada request,
igual que el warp: no hay que reiniciar ni reiniciar Pi. Por defecto es `v1`, los
cinco headers que ya manda toda instalación; `v2` agrega `x-session-affinity`,
`X-Session-Id` y `x-opencode-client`. `RELAY_WIRE_MODE` (env) gana sobre el archivo.
`x-opencode-project` queda afuera a propósito: el bridge no tiene concepto de
proyecto y un id inventado sería una variable más en la medición que este modo
existe para hacer.

**Hot reload:** el relay relee `warpEnabled` del config en **cada request**
(la extension se lo pasa por `RELAY_CONFIG_PATH`), así que cambiar el modo con
`/free-bridge-warp off|auto|on` no reinicia ni mata el relay: el pid sobrevive y
el cambio aplica en el próximo request. Si el archivo está malformado o ilegible,
el relay conserva el último modo conocido y avisa una sola vez por stderr, sin
tirar ningún request. La excepción es `PI_FREE_BRIDGE_WARP_MODE`: si existe, pinna
el modo hasta que lo desactives (no lee el config; `warpModeSource` en `/health`
dice `env` en ese caso y `config` cuando el modo viene del archivo).

En los errores ≥ 400 el relay loguea un snapshot acotado del cuerpo del upstream
(stderr) y lo devuelve byte-exacte, con pista específica de session id ante
`429`.

**Qué mide ese `429`:** el free tier cuenta por **IP de egress** y por **día
calendario UTC**, no por cuenta ni por sesión. El 429 trae `Retry-After` con los
segundos que faltan para las 00:00 UTC, y **no hay decaimiento por inactividad**:
una IP quemada se libera en el cambio de día UTC, no antes, así que dejarla
descansar no devuelve nada. Además una IP que sigue siendo "nueva"
(`lifetimeCount < dailyLimit * 7`, contador que nunca se resetea) tiene el doble
de cuota diaria que una ya establecida: rotar de IP también preserva el
presupuesto de la IP local. Fuente y detalle en `odd/tasks/warp-429-retry.md`
S2-S3.

### Reenvío tras rotación

Cuando la respuesta que iba a entregarse es un `429`, el relay rota la IP de
egress de WARP (`POST /recycle`) y espera a que la rotación quede **confirmada**:
`recycling` volvió a `false` **y** además se observó `recycling: true` en algún
momento del poll, o la lista de `exits[]` cambió contra el snapshot tomado justo
antes del `POST`. `recycling: false` solo no alcanza: es el estado de reposo de
un pool sano, así que no prueba que el recycle haya corrido.

Con la rotación confirmada hace **un** reenvío, y nada más:

- Antes de rotar — por los **dos** caminos: el reenvío y la rotación automática
  de `auto` cuando la cadena cayó al local — espera a que no queden respuestas
  **entregándose** por WARP. Un
  request que ya pasó el gate se completa solo; rotar lo mataría sin necesidad.
  La espera no tiene reloj — si el otro tarda 40 segundos, esperás 40. Solo hay
  una válvula de **120s** por si un stream quedó colgado, y cuando se dispara lo
  deja escrito en el log. Un request que todavía espera headers no se cuenta:
  esa IP ya está quemada y se va a comer su propio `429` igual.
- El `POST /recycle` va **después** de esa espera. Si se manda antes, el túnel ya
  se está cayendo y esperar no salva nada.
- Si el cliente que comió el `429` ya se fue, no se rota: nadie va a reenviar,
  y esperar para después tirar el túnel solo le costaría el reintento a los
  demás.

- Sale siempre por el egress WARP, porque la IP nueva vive ahí sin importar el
  orden que haya usado `auto` (el disparador es todo el request: basta un `429`
  observado en WARP, aunque después un fallback local haya respondido).
- Solo antes del primer byte downstream: durante los hasta 10s de la ventana de
  rotación el cliente no recibe nada. Es la misma regla de siempre — un stream
  empezado no se puede replicar.
- Solo se entrega un reenvío **sin error** (`status < 400`). Cualquier reenvío
  rechazado — `429`, `5xx` u otro `4xx` (`400`/`401`/`403`) — se descarta: se
  entrega el `429` original **byte-exact** y el status real queda en el `stderr`.
  Nunca un error sintético y nunca un `429` real escondido. Lo mismo si la
  rotación no se confirma dentro del timeout o si el reenvío ni siquiera sale.
- `off` no cambia en nada: su orden de egress es solo local, así que nunca hay
  un `429` de WARP que dispare el reenvío.
- `/health` publica `warpResends` (reenvíos que salieron bien) y
  `warpResendEnabled` (si el mecanismo está activo en este proceso).
- `RELAY_WARP_RETRY_AFTER_RECYCLE=0` lo apaga del todo, sin tocar el resto.

### Escalera de recuperación: swap apuntado antes que recycle

Un `429` de WARP ya no tiene la rotación dura como único paso. La escalera va de
menor a mayor costo:

1. **Un intento por IP.** El `429` se atribuye a un exit concreto leyendo el
   contador `served` de `/health` —túneles abiertos por ese exit, no requests—:
   snapshot antes del intento, snapshot después del `429`, y sólo un delta de
   exactamente 1 sobre un único exit cuenta como evidencia. Con el mapa dudoso o
   vacío **no se rota**: se entrega el `429`, y el escape forzado es el comando
   manual.
2. **`POST /swap` apuntado por id.** Reemplaza sólo ese exit: un enrolamiento en
   vez de N, y el pool sigue sirviendo por el otro. Un `202` es **aceptación**, no
   cambio: el `target` queda en `draining` y la salida nueva aparece cuando el
   drain termina. `409` (no hay standby) y `404` (id desconocido) son respuestas:
   no se insisten.
3. **La espera del cambio, y después un reintento por la salida nueva.** El relay
   relee `/health` hasta que la salida drenada desaparezca **y** aparezca un id que
   antes no estaba, y sólo entonces reenvía. Reenviar antes sale por la standby —la
   única que sirve mientras la otra drena—, que puede estar tan limitada como la
   que dio el `429`: se gastaría un enrolamiento para reintentar contra una IP
   quemada. No hay plazo propio: la espera termina cuando el pool cambia o cuando
   **el cliente se va**, lo que pase primero. Si el cliente se fue primero, se
   entrega el `429` original byte-exacto y el swap sigue solo en segundo plano, así
   el request siguiente ya encuentra la salida nueva. La espera medida contra el
   drain real no es corta: 120 s una vez, 183 s otra, y la válvula del proxy sólo
   se abre al vencer, no antes.
4. **`/recycle`** sólo si ese reintento también da `429`. Es el único paso que
   corta los streams en vuelo —incluido el tuyo—, así que va último, y también
   espera a que el pool muestre las salidas nuevas antes de reenviar. En esa ruta
   el presupuesto de confirmación de 10 s ya no manda cuando hay cliente: era el
   mismo error, porque contra el drain medido toda rotación exitosa se reportaba
   como `not_confirmed`.
5. **Un reintento más**, y si tampoco: el `429` original byte-exacto.

Acotada por construcción: dos intentos extra como máximo, nunca un loop.

Dos detalles que costaron encontrar:

- Un `202` con `{"ok":false}` (o un `/recycle` rechazado) significa que **otro**
  swap o recycle tiene el estado del proxy: no pasó nada, así que no se cuenta
  como acción. Sólo un `202` puede decir `ok:false` y significarlo; un `409`/`404`
  llega con status de error y ahí el status es la respuesta.
- Si el proxy no tiene `/swap` (binario viejo, o stack WireGuard que responde
  `501` en texto plano, o un `404` sin el motivo `unknown_exit`), el relay lo
  detecta, avisa **una vez** y sigue rotando duro. Reintentar contra una ruta que
  no existe sólo gasta intentos.

### Parking de la IP local

Un `429` en el egress **local** no es lo mismo que uno en WARP: el relay no puede
rotar la IP física de tu casa, así que la única salida honesta es esperar. Cuando
el local devuelve `429`, el relay lee el `retry-after` **de esa misma respuesta**
y no vuelve a ofrecer local primero hasta ese momento más 10s de margen.

- El número sale siempre del header. Nunca de calcular medianoche UTC ni de
  adivinar tu zona horaria.
- Si el header falta o no es un entero de segundos, no se parkea nada: se
  prefiere un intento de más antes que inventar un reset.
- Local **no se saca** de la cadena, solo baja al segundo lugar: si WARP está
  caído, el pedido igual sale por local y recibe su `429` en vez de un `502`. Un
  request rechazado por el gate no consume cuota, así que ese fallback es gratis.
- Solo aplica a `auto`. En `off` el orden sigue siendo solo local y en `on`
  nunca se usa local.
- `/health` publica `localParkedForMs`: 0 significa que local volvió a estar
  disponible.
- El estado vive en memoria: reiniciar el relay lo olvida y lo vuelve a aprender
  con un request que no cuesta cuota.

**Instalación desde Pi (opción 2):** si activás `auto` u `on` y no hay WARP vivo
ni binario configurado, Pi abre un diálogo de confirmación y, si aceptás, descarga
la última release de `github.com/Deury08/warp-minimal`, verifica su sha256 contra
`checksums.txt` del propio release, la instala en
`~/.pi/agent/pi-free-bridge/warp/` y levanta el proceso. Nada se baja sin tu
consentimiento explícito, y si el download falla el modo queda configurado con un
warning (`auto` sigue funcionando directo).

### Config compartida con `warp-minimal`

El archivo `~/.pi/agent/pi-free-bridge/warp/config.json` es **del binario**:
`warp-minimal` lo obedece, y la extensión lee **el mismo archivo** para las claves
que ambos tienen que acordar. **No se crea ni se reescribe nunca**: si no existe,
todo va a los defaults compilados (`127.0.0.1:8789`, `/health`). Lo escribís a
mano (o el plugin, si algún día lo necesita) solo para una configuración especial.

Merge **por clave**, no todo-o-nada: lo que está en el archivo manda, lo que
falta cae al default.

| Clave | Quién la lee | Default |
|---|---|---|
| `listen` | ambos (`host:puerto`, también `:puerto`, `puerto` o `[::1]:puerto`) | `127.0.0.1:8789` |
| `health_path` | ambos | `/health` |
| `pool_size`, `stack`, `log_path` | solo `warp-minimal` | — |

**Destino remoto:** si `listen` apunta fuera de loopback (otra PC o contenedor),
es válido. En ese caso la extensión **solo verifica**: nunca intenta lanzar un
binario que vive en otra máquina. Con destino loopback sí lo lanza cuando no
responde.

Un valor ilegible (typo, tipo equivocado) cae al default y `/free-bridge-doctor`
lo reporta como `defaults`, no como si hubiera salido del archivo. Si movés el
`listen`, el relay arranca con la nueva URL y se reinicia solo cuando la URL
resuelta cambia respecto de la que tenía al nacer.

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
| `/free-bridge-warp` | Muestra el modo de salida WARP (`off` por defecto), el endpoint efectivo y el último egress usado | Diagnóstico de red o grandes rate limits |
| `/free-bridge-warp off\|auto\|on` | Cambia y persiste el modo: `off` directo; `auto` directo primero, WARP ante rate limit; `on` siempre WARP. **Hot reload:** sin reiniciar el relay — aplica en el próximo request | Requiere `warp-minimal` en `127.0.0.1:8789` para modos no-`off`. Si no está y no hay ruta configurada, Pi **te pregunta** y ofrece descargar e instalar la release oficial (checksum verificado) |
| `/free-bridge-warp bin <ruta>` | Configura la ruta del binario `warp-minimal` (queda en `warpBin` de la config) | Cuando ya lo tenés compilado o descargado y preferís apuntarlo a mano |
| `/free-bridge-warp-recycle` | Recupera el egress WARP ahora, por el paso más barato primero: lee el pool y hace recycle si sólo una salida puede servir o si alguna está parkeada en el cool-down de 30 minutos del proxy; si no, hace un swap apuntado de la salida en uso y vuelve a leer el pool después de cada swap aceptado, parando cuando queda una sola sirviendo. Nunca arranca un swap que dejaría el pool sin salidas, porque el drain retiene esa salida hasta 120 s. Espera a que no haya respuestas entregándose por el túnel e informa cada paso, no un veredicto | Cuando un `429` te mató el turno y la rotación automática no llegó (o no querés gastar un turno para que llegue). **No lo corras desde una sesión que esté usando el bridge**: el swap cambia el exit debajo de tu propia respuesta |

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
| `~/.pi/agent/pi-free-bridge.json` → `warpEnabled` | Modo de egress WARP: `off`, `auto` u `on` (por defecto `off`) |
| `PI_FREE_BRIDGE_WARP_MODE` | Pisa el modo de egress WARP (también `off`, `auto`, `on`; máxima precedencia). Mientras exista, el relay **no** lee el `warpEnabled` del config — el modo queda fijado (estático por diseño) |
| `RELAY_WARP_RETRY_AFTER_RECYCLE` | Relay-only: kill switch del reenvío único tras una rotación confirmada. `0` lo desactiva (se entrega el `429` original tal cual); ausente o cualquier otro valor lo mantiene activo. |
| `RELAY_WARP_SWAP` | Relay-only: kill switch del swap apuntado. `0` lo desactiva y deja la rotación dura como único paso; ausente o cualquier otro valor lo mantiene activo. |
| `RELAY_WARP_SWAP_MIN_RETRY_AFTER_MS` | Relay-only: si el `retry-after` del `429` es menor que esto (default `120000`), el relay espera en vez de gastar un enrolamiento. Un swap consume cuota de Cloudflare, que es justo lo escaso cuando el gate ya está devolviendo `1015`. |
| `RELAY_LOG_FILE` | Relay-only: ruta del log de eventos de WARP en JSONL (un objeto por línea: `429` observado, rotación pedida/confirmada/fallida con motivo, reenvío, parking local, entrega final). Sin valor **no escribe nada**. Rota a los 5 MB conservando un `.1`. Nunca registra bodies, cabeceras ni prompts: solo el evento y los contadores que explican la decisión |
| `PI_FREE_BRIDGE_WARP_PROXY` | URL del proxy WARP (por defecto `http://127.0.0.1:8789`) |
| `PI_FREE_BRIDGE_WARP_BIN` | Ruta al binario `warp-minimal` (precedencia sobre `warpBin` en config) |
| `~/.pi/agent/pi-free-bridge.json` → `warpBin` | Ruta al binario; si no hay ninguna y no responde, Pi ofrece descargar e instalar la release oficial (te lo pregunta antes) |
| `~/.pi/agent/pi-free-bridge.json` → `liveIds` | Sobreescribe el snapshot de modelos publicitados |
| `~/.pi/agent/pi-free-bridge.json` → `relayPort` | Puerto del relay (por defecto `8788`) |
| `PI_FREE_BRIDGE_RELAY_PORT` | Pisa el puerto del relay |
| `PI_FREE_BRIDGE_BUN` | Ruta explícita al ejecutable de Bun |
| `PI_FREE_BRIDGE_DRY_RUN=1` | Diagnóstico de arranque |

Forma del archivo de config:

```json
{
  "sessionId": "ses_…",
  "liveIds": ["big-pickle", "…"],
  "relayPort": 8788,
  "warpEnabled": "off"
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

**Respuesta** — el status y el `content-type` del upstream pasan tal cual, y un
error conserva además su `retry-after`: cuando el gate corta por cuota esa
cabecera trae los segundos reales hasta el reset, así que el cliente no necesita
calcular medianoche UTC ni adivinar su zona horaria. El resto de los headers del
upstream no salen del relay.

**Body:**

- `stream: true` (`stream: false` → 403)
- un mensaje inicial `system` o `developer` (contenido y longitud libres)
- un array `tools` no vacío que contenga **ambos** nombres `read` **y** `bash`
  — los nombres se inspeccionan; `[read, bash]` en cualquier orden pasa,
  `[bash]` solo o dos nombres arbitrarios no

**Rol del mensaje y campo de tokens:** el puente registra **cada** modelo de
`oc-sdk-zen` con `compat: { supportsDeveloperRole: false, maxTokensField:
"max_tokens" }`, porque el gate acepta `system` y `max_tokens`. Si el `compat` se
deja sin definir, `detectCompat` (`pi-ai/dist/api/openai-completions.js:1260`)
trata al provider como endpoint estándar — `baseUrl` loopback y un id propio — y
resuelve `supportsDeveloperRole: true` y `max_completion_tokens`; con eso
`openai-completions.js:887` emite `role: "developer"` para todo modelo con
`reasoning: true`. Medido el 2026-10-14 por el relay: con `system` responden
**11/11** modelos registrados; con `developer`, 10/11 — `inkling-2-small-free`
devuelve `400 upstream failed: [airlock_error] invalid request: unknown variant
'developer', expected one of 'system','user','assistant','tool'`. El cliente de
referencia (OpenCode, `@ai-sdk/openai-compatible`) manda `system` para sus 134
modelos, así que ése es el contrato real. Es un default del provider aplicado por
**merge**, no por reemplazo: `deepseek` conserva
`allowsSyntheticReasoningContentForToolCalls: false` y `kimi` conserva
`requiresReasoningContentForToolCalls: true` + `thinkingFormat: "zai"`. No se
aplica a `nvidia` ni a `opencode-go`, donde `developer` puede ser correcto.

**Session id:** el id lo genera el **cliente**, no el proveedor. Es `ses_` + 12
hex de un contador de milisegundos (+ secuencia intra-ms) + 14 caracteres
alfanuméricos aleatorios, tal como lo arma
`packages/schema/src/identifier.ts` de OpenCode. Nada lo firma ni lo registra:
verificado reproduciendo 8 ids reales de `session_v2` con esa fórmula (8/8). Por
eso el formato importa — los 12 primeros **tienen** que ser hex — pero ninguna
máquina necesita tener OpenCode para conseguirlo.

El paquete **no incluye** ningún id. El relay lo resuelve al arrancar, en este
orden:

1. `RELAY_SESSION` — sólo lo setea la extensión cuando hay un override explícito.
2. `RELAY_SESSION_PI` — el id que la extensión cosechó en la máquina de Pi.
3. **El servidor local de OpenCode** — se lee
   `~/.local/state/opencode/service.json` (respeta `XDG_STATE_HOME`) y se hace
   `POST {url}/api/session` con Basic `opencode:<password>`. Su id es el que el
   gate acepta (medido 5/5), así que es la fuente principal. **Nunca se
   arranca el daemon**: si el archivo falta, está viejo o el puerto rechaza, se
   sigue de largo (el rechazo tarda ~9 ms, no 2 s).
4. La sesión más nueva de `~/.local/share/opencode/opencode.db`, en la tabla
   `session_v2` (v1 usaba `session`); si una no existe se prueba la otra. Se
   abre en modo lectura y cualquier falla se ignora.
5. El archivo `ses_*.json` más reciente por mtime en
   `~/.local/share/opencode/storage/session_diff/`.
6. **Genera uno** con el mismo algoritmo de OpenCode (`source: "generated"`).

Las sesiones que emite el servidor local persisten en `opencode.db` igual que
las de uso real, así que el paso 4 las encuentra cuando el paso 3 no está
disponible.

El paso 6 es el que hace que una máquina **sin OpenCode instalado** arranque el
relay en vez de fallar. Antes el relay se negaba a arrancar con una línea
pidiendo correr OpenCode; ahora genera el id y sigue.

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
todos los modelos apuntan a `http://127.0.0.1:<puerto>/v1`, el provider ya no
declara headers (los pone el relay), y cada modelo declara
`supportsDeveloperRole: false` + `maxTokensField: "max_tokens"` sin perder el
`compat` propio de su familia.

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

## Licencia

MIT — ver [`LICENSE`](LICENSE).

---

## Relay standalone: sin Bun y sin OpenCode

El relay puede correr solo, como un único ejecutable. **No hace falta instalar
Bun, Node, ni OpenCode**, ni la extensión de Pi: el ejecutable trae el runtime
adentro, genera su propio session id y trae los modelos adentro.

### 1. Descargá el archivo de tu sistema

En la página de **Releases** de este repositorio:

| Tu sistema | Archivo |
| --- | --- |
| Windows 64 bits | `relay-windows-x64.exe` |
| Linux 64 bits | `relay-linux-x64` |
| Linux ARM (Raspberry, servidores ARM) | `relay-linux-arm64` |
| macOS con Intel | `relay-darwin-x64` |
| macOS con Apple Silicon (M1 o posterior) | `relay-darwin-arm64` |

Si no sabés qué Mac tenés: menú Apple → *Acerca de esta Mac*. Si dice "Chip
Apple M…" es ARM; si dice "Procesador Intel" es el otro.

### 2. Corrélo

**Windows** — abrí PowerShell en la carpeta donde lo bajaste:

```powershell
Unblock-File .\relay-windows-x64.exe
.\relay-windows-x64.exe
```

`Unblock-File` evita el aviso de "Windows protegió tu PC" con archivos bajados
de internet. Si aun así aparece, *Más información → Ejecutar de todas formas*.

**macOS** — abrí Terminal en la carpeta donde lo bajaste:

```bash
chmod +x relay-darwin-arm64
./relay-darwin-arm64
```

Si macOS lo bloquea por no estar firmado, dos caminos: clic derecho sobre el
archivo → *Abrir* → *Abrir*, o quitarle la cuarentena:

```bash
xattr -d com.apple.quarantine relay-darwin-arm64
```

**Linux**:

```bash
chmod +x relay-linux-x64
./relay-linux-x64
```

### 3. Comprobá que está vivo

En otra terminal:

```bash
curl http://127.0.0.1:8788/health
```

Tiene que devolver un JSON con `"ok":true`. Para cortarlo, `Ctrl+C` en la
terminal donde corre.

### Opciones

Todo tiene un valor por defecto: sin configurar nada, el relay escucha en el
puerto 8788 y apunta al upstream de OpenCode.

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `PORT` | Puerto donde escucha | `8788` |
| `RELAY_UPSTREAM` | URL del upstream | `https://opencode.ai/inference/v1` |
| `RELAY_WARP_MODE` | `off` / `auto` / `on` (usa el proxy WARP) | `off` |
| `RELAY_WARP_PROXY` | URL del proxy WARP | `http://127.0.0.1:8789` |
| `RELAY_WIRE_MODE` | `v1` / `v2` (set de headers) | `v1` |
| `RELAY_API_KEY` | Credencial enviada al upstream | `public` |
| `RELAY_STDIN_LIFETIME` | `off` mantiene el relay vivo aunque se cierre la entrada estándar (servicios, contenedores, `nohup`) | activo |

Ejemplo, en Linux o macOS:

```bash
PORT=9000 RELAY_WARP_MODE=on ./relay-linux-x64
```

En PowerShell:

```powershell
$env:PORT=9000; $env:RELAY_WARP_MODE="on"; .\relay-windows-x64.exe
```

> Sin proxy WARP la IP local queda expuesta al límite diario del free tier. Si
> el relay responde 429, `RELAY_WARP_MODE=on` cambia la salida.

**Si lo vas a correr como servicio**, en un contenedor o con `nohup`, agregá
`RELAY_STDIN_LIFETIME=off`. Sin eso el relay se apaga solo cuando se cierra su
entrada estándar: esa es la conducta que usa la extensión para no dejar procesos
huérfanos cuando Pi se cae, y en un binario suelto juega en contra.

### Lo que este ejecutable NO hace

No registra los modelos en el selector de Pi: eso lo hace la extensión. El
binario es el relay solo — sirve para correr el puente aparte, en otra máquina,
o adentro de un contenedor.
