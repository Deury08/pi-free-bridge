# Feature: warp-429-retry

Reenviar automáticamente un request que recibió 429 del gate cuando la rotación
de la IP de egress warp ya se confirmó, sin cambiar el comportamiento de `off`
ni de los caminos `auto` que hoy funcionan.

## Specs

- S1 El gate de opencode responde 429 con el cuerpo
  `{"type":"FreeUsageLimitError","message":"Free usage limit reached..."}`. Pi
  clasifica ese string como límite terminal no reintentable
  (`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` en
  `pi-coding-agent/dist/bundle/chunks/chunk-62VOPMLK.js`, presente ya en 1.2.0),
  así que Pi NO reintenta este error aunque `retry.maxRetries` sea 3.
- S2 La cuota del free tier se cuenta por IP de egress y por día UTC
  (`packages/console/app/src/routes/zen/util/ipRateLimiter.ts`: clave
  `buildYYYYMMDD(now)`, `lifetimeInterval = ""`,
  `getRetryAfterDay(now) = Math.ceil((86_400_000 - (now % 86_400_000)) / 1000)`).
  El 429 lleva `Retry-After` en segundos hasta el próximo 00:00 UTC
  (`handler.ts`: `headers.set("retry-after", String(error.retryAfter))`).
- S3 Una IP con `lifetimeCount < dailyLimit * 7` ("nueva") tiene `dailyLimit * 2`
  de cuota; una IP ya establecida tiene `dailyLimit`. `lifetimeCount` nunca se
  resetea. Rotar de IP preserva el multiplicador de la IP local.
- S4 Un request rechazado por el rate limiter NO incrementa el contador:
  `await rateLimiter?.check()` lanza antes de `await rateLimiter?.track()`.
  Probar una IP quemada cuesta un round-trip, no cuota.
- S5 El relay debe reenviar el request **una sola vez** cuando la respuesta que
  iba a entregar es un 429 y la rotación de la IP de egress warp quedó
  confirmada. Reenvío único; nunca loop.
- S6 La rotación se confirma con `GET <warpProxy><RELAY_WARP_HEALTH_PATH>`
  cuando deja de reportar `recycling: true` **y** hay evidencia positiva de que
  el recycle corrió: se observó `recycling: true` al menos una vez durante el
  poll, o la lista de `exits[]` cambió contra el snapshot tomado antes del
  `POST /recycle`. `recycling: false` solo no alcanza. El nombre del exit no
  sirve como señal (ver L26).
- S7 Si la rotación no se confirma dentro del timeout (10s), o el reenvío vuelve
  a dar 429, se entrega el 429 original byte-exact. Nunca se entrega un error
  sintético nuevo ni se oculta el 429 real.
- S8 El reenvío ocurre únicamente **antes del primer byte downstream**, igual
  que la regla de failover existente (`relay.mjs:269`). Nunca se escribe nada al
  cliente mientras se espera la rotación.
- S9 El modo `off` no cambia de comportamiento en ningún caso.
- S10 El disparador es ancho, no atado al último egress: se reenvía si en el
  request se observó algún 429 en el egress warp y ninguna respuesta no-429 fue
  entregada. Esto cubre los dos órdenes de `auto`
  (`["local","warp"]` y `["warp","local"]`).
- S11 `warpPreferred` debe reflejar éxito real: `updateWarpPreference` recibe
  `ok = status < 400`, no `true` hardcodeado (`relay.mjs:551`). Hoy un 429 de
  warp deja warp como preferido.
- S12 El cooldown de recycle se arma solo después de un `/recycle` 2xx. Hoy se
  arma antes del fetch y se consume aunque el pedido falle.
- S13 Si el cliente se desconecta durante la espera, se aborta el poll y no se
  reenvía nada.
- S14 La ruta de health de warp se pasa al relay por entorno
  (`RELAY_WARP_HEALTH_PATH`) desde `relayEnv()` en `index.ts`, reutilizando
  `resolveWarpTarget()`; no se hardcodea `/health` en `relay.mjs`.
- S15 El relay debe reenviar el header `retry-after` del 429 upstream. Hoy solo
  copia `content-type`.
- S16 Parking de la IP local: tras un 429 en el egress local, no se reintenta
  local hasta `retry-after + 10s`; mientras tanto el tráfico va por warp. El
  margen sale del header, nunca de calcular 00:00 UTC ni de la zona horaria.
- S17 El estado del parking vive solo en memoria del proceso. Sin persistencia.
- S18 Kill switch `RELAY_WARP_RETRY_AFTER_RECYCLE=0` desactiva S5-S7 sin tocar
  el resto.
- S19 El README guía la instalación paso a paso con las capturas de `Imagenes/`,
  en el orden real del recorrido: instalar, confirmar, activar WARP, aceptar la
  descarga, elegir modo, elegir modelo, usarlo. La instalación tiene que ser
  fácil para alguien que nunca vio el repo.

- S20 Antes de rotar, el relay espera a que no queden respuestas **entregándose**
  por warp: un request que ya pasó el gate se completa solo, y rotar lo mata sin
  necesidad. La espera no tiene reloj; `DRAIN_VALVE_MS` (120s) es una válvula por
  si un stream queda colgado, no un presupuesto. El `POST /recycle` va siempre
  **después** de esa espera: mandarlo antes derrumba el túnel y la espera no
  salva nada. Cuenta solo respuestas aceptadas (`<400`), porque un request que
  todavía espera headers va a comerse su propio 429 en la IP quemada y esperarlo
  no compra nada. Vale para los dos caminos de rotación: el reenvío y la rotación
  automática de `auto` (streak) que dispara cuando el 429 de warp ya cayó a un
  local exitoso. Si el cliente del 429 ya se fue, no se rota: nadie va a
  reenviar y esperar para después tirar el túnel le costaría el reintento a los
  demás.

## Tasks

- T1 (S11,S12,S13) DONE. Commit `02ca375`. `updateWarpPreference` recibe el
  status (no un booleano hardcodeable), el cooldown se arma solo tras un 2xx y
  con guarda de in-flight, y un cliente que se va a mitad del stream cancela el
  reader en vez de drenarlo. RED observado en ambos contratos, suite 65/65.
  S14 se movió a T2: es plomería que solo usa el poll de readiness.
- T2 (S5,S6,S7,S8,S10,S14,S18,S20) DONE: retry tras rotación confirmada — poll de health, reenvío único, fallback al 429 original, disparador ancho, kill switch. Route: gentle-ai-worker + gentle-ai-verify (concurrencia). Commit: `feat(relay): resend once after a confirmed warp exit rotation`. Test-first: rojo observado (el import de los helpers nuevos no existía) y verde 78/78 en `test/relay.test.mjs` (65 existentes + 13 nuevos). Archivos: `relay.mjs`, `index.ts`, `test/relay.test.mjs`, `README.md`, `CHANGELOG.md`.
  
  S20 se agregó después (L33-L36): contador propio de respuestas EN ENTREGA
  (no requests en vuelo), espera sin reloj antes del `POST /recycle`, válvula de
  120s. Dos tests lo pinnean (espera al peer; la válvula suelta al turno trabado)
  y los dos quedaron rojos al anular la espera. Suite: 98/98.
- T3 (S15) DONE: `forwardedHeaders()` puro reemplaza el copiado inline de
  `content-type` en `forward()` y suma `retry-after`. RED de comportamiento, no
  de import: el helper se escribió primero con el comportamiento de hoy y los
  dos casos de `retry-after` quedaron rojos (89 verdes / 2 rojos); después
  91/91. Commit `fix(relay): forward retry-after on upstream errors`.
- T4 (S16,S17) DONE: `parkDurationMs()` puro lee `retry-after` de la respuesta
  local y devuelve la ventana + `PARK_MARGIN_MS` (10s); un header ausente o no
  entero no parkea nada. `egressOrder(mode, warpPreferred, localParked)`
  depriorita local en `auto` sin sacarlo de la cadena (con WARP caído el pedido
  sale igual por local y recibe su 429, no un 502; S4 dice que un rechazo no
  cuesta cuota). Estado en memoria (`localParkedUntil`), expuesto en `/health`
  como `localParkedForMs`. RED de comportamiento en dos ciclos (parking
  ignorado; luego la aritmética del header) y finalmente 96/96. Commit
  `feat(relay): park a rate-limited local egress until its reset`.
- T5 (S2,S3) DONE 2026-11-04: la perilla `RELAY_WARP_RECYCLE_THRESHOLD` se eliminó (config muerta: un solo valor correcto), `needsWarpRecycle(streak, onCooldown)` rota en el primer warp 429, y README/CHANGELOG/`warp-auto-recycle.md` S4 se alinearon. Test-first: rojo observado con la firma nueva, verde 65/65 en `test/relay.test.mjs`. Commit `02ca375` (código) + el commit de documentación.
- T6 (S19) DONE: guía visual de instalación en siete pasos con las capturas de `Imagenes/`, verificadas una por una contra el archivo en disco. Commit de documentación.
- Verificación (S1-S18): tests de `off` intacto, disparador ancho, un solo reenvío, fallback al 429 original, cooldown tras 2xx. Los helpers puros se prueban en `test/relay.test.mjs`.

## Log

- L1 (verbatim): "solo estaba probando el 429 muy bien cuando envie
    ❯ hola

   Error: 429: {"type":"FreeUsageLimitError","message":"Free usage limit reached. Free
   models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going:
   https://opencode.ai/go"}
   If this looks like a pi bug, /bug sends a report to the developers. pero a la proxima iteracion cambio, lo unico es que no se porque no intento nuevamente, soo respondeme no te pongas a codear"
- L2 (verbatim): "no, lo que entendo es que se agoto la cuota y el warp cambio la ipv6 por eso enla proxima iteracion fnciono , pero pi no reintento"
- L3 (verbatim): "no, anteriormente pi reintentaba solo 3 3 veces, pero bueno"
- L4 Evidencia: el retry de Pi existe (`retry.maxRetries: 3`) y se ve en las
  sesiones como runs `ERR x1..x4` con `502 all egress attempts failed` y
  `503 WARP unavailable`. Un `429 FreeUsageLimitError` dentro del run corta el
  loop: firma observada `ERR x2 (503) → ERR x3 (429 FreeUsageLimitError) → USER`.
- L5 Evidencia: `/health` del proxy warp expone
  `{"active":1,"cooling_down":0,"exits":["warp-18e (in_use, streams=1)"],"healthy":1,"ok":true,"pool_size":2,"recycling":false,...}`.
  El nombre del exit y `recycling` dan la señal de readiness.
- L6 (verbatim): "me gusta esa idea, pero planteame todos los ecesarios tanto en on auto y off no quiero que arreglemos algoy se empeore or otra parte"
- L7 (verbatim): "megusta , detallameun poco mas de auto"
- L8 (verbatim): "sabes cuanto tiempo dura una ip quemada para liberarse?manda a ivesigar"
- L9 (verbatim): "eso no es cierto, bsca enla web , la razon real es poner a descansar la ip local por ese tiemplo, bsca en internet, ya que yo instalaba vpn y seguia uusando"
- L10 Corrección de L9: el código fuente del gate no tiene decaimiento por
  inactividad. El contador es por IP y por día UTC y reinicia a las 00:00 UTC.
  "Descansar" no libera una IP. La observación del VPN es correcta pero el
  motivo es otro: IP nueva = bucket nuevo y, si es "nueva", 2× de cuota (S3).
- L11 (verbatim): "osea auto crei que era local y cuando 429 entra al warp y ocal queda el coldoun,es asi'"
- L12 Corrección de L11: `auto` no tiene cooldown por egress. Tiene
  `warpPreferred`, un puntero al último egress que entregó respuesta, que
  cambia el orden entre `["local","warp"]` y `["warp","local"]`.
- L13 (verbatim): "ntoncess que tiempo permanece la ip quemada'"
- L14 (verbatim): "osea la idea es en auto mandar a descansar la ip local hasta que llegue la hoara de reinicioo mientras se trabaja con el warp, pero al parecer ahora voy a necesita saber la hora y la zona horaria, lo mejor es comparar la hora en  00:00 utc talvez añadirle 2 minutos , seia asi lcal hasta 429 luego warp y al llegar las 00:00 utc + 2 min volver a ip local, que piensas?"
- L15 Corrección aceptada de L14: no hace falta hora ni zona horaria. El 429
  trae `Retry-After` en segundos hasta el 00:00 UTC (S2); el margen va sobre el
  header (+10s), no sobre un cálculo de medianoche ni +2 minutos.
- L16 (verbatim): "en estos3 pasos esta todo lo que conversamos?"
- L17 Auditoría de L16: los 3 pasos propuestos cubrían solo las features, no
  el saneamiento obligatorio. Se separa T1 (neutro, sin comportamiento nuevo)
  de T2-T4 (features) para que un problema en el feature no arrastre el
  saneamiento.
- L18 (verbatim): "prepara el odd guarda en engram y  despues compactamos"
- L19 Decisión: se implementa en el relay, no en Pi ni en la extensión. El
  retry pertenece a la capa que causó el fallo y que puede confirmar la
  rotación. Se descarta lavar el string `FreeUsageLimitError` para engañar el
  retry de Pi (`docs/custom-provider.md:208` lo desaconseja).
- L20 Residual aceptado: IPs de warp compartidas ya consumidas por otros
  usuarios, y 429 por violación de contrato (determinístico). Ninguno se
  resuelve con retry. Sin cache de "429 determinístico" hasta tener evidencia.
- L21 (verbatim): "si asi mismo entonces arregla en la documentacion y es mas si esto no influye oes ino demas la quitas,"
- L22 Decisión derivada de L21: `RELAY_WARP_RECYCLE_THRESHOLD` eliminado. Con el
  retry implementado, todo umbral > 1 entrega esa cantidad de 429 antes de
  rotar, así que el valor único correcto es 1 → perilla muerta. Queda solo
  `RELAY_WARP_RECYCLE_COOLDOWN_MS` como control de ráfaga.
- L23 (verbatim): "ademamas tengo unas imagenes para que actuaices el readme , hay una carpeta de imagenes i y en el nombre esta mas o menos que es"
- L24 (verbatim): "osea quieroqu a instalacion sea facil por eso las imagenes"
- L25 Decisión derivada de L23-L24: el README pasa de un bloque de comandos a un
  recorrido visual de siete pasos, porque el problema no era el comando sino no
  saber dónde escribirlo ni qué esperar después. Las capturas son de una
  instalación real; el orden de los archivos no era el orden del recorrido
  (`Activando` va antes que `Instalando`).
- L26 Evidencia (fuente primaria: `~/.pi/agent/pi-free-bridge/warp/warp-minimal.log`
  y el binario). El nombre del exit **no** es observable: `/health` publica
  `"exits":["warp-18e (in_use, streams=1)"]`, un label de 8 caracteres
  (`warp-18e`) idéntico para todos los exits, mientras el log nombra los reales
  (`warp-18e4af9b4c1ce26c`, `warp-18e4afddebe59310`, `warp-18e4afe2edeaed54`,
  `warp-18e4afeb81071da8`). El formato interno es `%s (%s, streams=%d)`
  (nombre, estado, streams). Por eso S6 se reescribió: la señal usable es la
  ventana de `recycling`, no el nombre. Ciclo real medido en el log:
  `recycle requested: started=true` → enroll → `WARP exit replaced: viejo ->
  nuevo (healthy=1 cooling=0)` → `WARP pool recycle complete: fresh egress
  addresses enrolled`, en ~4s. Un poll de 250ms con timeout de 10s lo ve.
- L27 Incidente y regla derivada: probar rutas desconocidas en el proxy
  (`/status`, `/pool`, `/exits`) las reenvía al upstream y **mata el exit**
  (`dial :80` → `healthy:1` pasa a `cooling_down:1`), porque el relay del
  usuario está ruteado por ahí en modo `on`. Nunca se sondean rutas del proxy
  que no estén documentadas, y no se llama `/recycle` con tráfico vivo encima.
- L28 (verbatim): "porque no delegas nada?"
- L29 Decisión derivada de L28: T2 pasa de "parent inline" a writer delegado
  (`gentle-ai-worker`) por el backstop de contexto, y su verificación a
  `gentle-ai-verify` porque el cambio toca estado mutable compartido entre
  handlers concurrentes (item 4). T3 y T4 siguen inline por tamaño y
  dependencia, no por preferencia.
- L30 (verbatim): "Riesgo residual aceptado: /recycle corta todos los streams del proxy, no solo el del request que lo pidió. Si tenés dos turnos en vuelo y uno come un 429, la rotación puede abortar el otro. explica esto"
- L31 (verbatim): "escogeria la 1 pero no termino de entender"
- L32 (verbatim): "noentendi todo pero si hay un 429 entiendo que aunque haya uan secion hay que cambiar la ip porque igual no va a funcionar , entonces cmo entra aqui lo que me exolicas?"
- L33 Corrección del usuario, y es la clave de S20: un `429` es un veredicto en la
  puerta, no un interruptor que invalide lo ya aceptado. Un request que todavía
  espera headers en la IP quemada está condenado (S4: probar cuesta un
  round-trip, no cuota), pero una respuesta que ya entró pasó `check()` y se va a
  completar sola. Rotar mata lo segundo. El primer diseño contaba los dos y
  esperaba un tope de 2s: mal en las dos puntas.
- L34 (verbatim): "pero si no se hace por tiempo, todas las solicitudes pasan por free bridge, asi que e sabe si hay una peticion en medio,asi que si ha una peticion en medio esperar que termine , pedir nueva ip y continuar normlmete, esto si ya se envio la solicitud de ka nueva io, dime si cuadra"
- L35 Corrección aceptada de L34 (S20): sin reloj. Todas las requests pasan por el
  relay, así que el contador es nuestro y no hace falta adivinar. El orden importa
  y el usuario lo marcó: la espera va ANTES del `POST /recycle`; mandarlo primero
  derrumba el túnel y después no hay nada que salvar. Se conserva una válvula
  (`DRAIN_VALVE_MS`, 120s) porque sin tope un stream colgado cuelga también el
  turno del 429, y Pi lo mata a los 5 minutos: se perderían los dos.
- L36 (verbatim): "si me gusta, dale"
- L37 Verificador independiente sobre `bea829d`: dos bloqueantes que la suite no veía.
  (a) El `POST /recycle` de `maybeRecycleWarp` no esperaba nada, y ese es el camino
  normal de `auto` (warp 429 -> local 200): el "siempre después de la espera" del
  mensaje de commit era falso. (b) La espera no miraba `client.gone`: un cliente que
  abandonaba igual tiraba el túnel hasta 120s después y retenía el guard. Además, el
  guard single-flight tomado durante la espera estiraba de ~12s a ~134s la ventana en
  que otro 429 pierde su reenvío. Arreglado: espera compartida
  `drainBeforeRotation(client)` usada por los dos caminos, aborto si el cliente se
  fue, y el guard se toma DESPUÉS de la espera. Cuatro tests nuevos (orden del POST
  por timestamp, un solo POST con dos 429, contador por `forward()` real, cliente
  ido); los cuatro quedan rojos al anular su arreglo. Suite: 103/103.
