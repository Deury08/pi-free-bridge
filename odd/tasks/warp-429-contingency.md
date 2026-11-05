# warp-429-contingency

Contingencia para un `429 FreeUsageLimitError` que hoy deja el turno muerto sin
rastro en disco y sin forma de recuperarlo a mano. Slice 1: observabilidad y
escape hatch seguro. Sin cambio de conducta del relay.

## Specs

- **S1** — El relay deja rastro en disco de sus eventos de warp (429 observado,
  rotación pedida/aceptada/confirmada/fallada con motivo, reenvío, parking del
  egress local, entrega final) en un archivo JSONL. Controlado por
  `RELAY_LOG_FILE`: sin valor no escribe nada. Nunca registra bodies, cabeceras
  ni prompts — solo status, egress, contadores y nombres de evento.
- **S2** — Rotación por tamaño del archivo de log: al superar 5 MB se mueve a
  `.1` (se conserva un solo anterior) y se continúa en el archivo nuevo.
- **S3** — El relay expone `POST /warp/recycle` en loopback que ejecuta la MISMA
  rotación que el camino automático, incluido el `drainBeforeRotation`, y
  responde el resultado (confirmada / rechazada + motivo) en JSON. Correr el
  comando manual no puede tirar streams multiplexados en vuelo.
- **S4** — Pi expone el comando plano `/free-bridge-warp-recycle` (el nombre que
  el usuario pidió: "unrecicle manual un comando de pi
  pi-free-brige-warp-recicle o algo parecido" y "debe se asi para que pi melo
  sugiera /free-bridge-warp-recycle"). Reporta estado antes, resultado de la
  rotación y estado después, leyendo `/health` del relay.
- **S5** — El comportamiento existente no cambia: sin `RELAY_LOG_FILE` y sin
  invocar el comando, el relay atiende `/v1/*` exactamente igual. La suite que ya
  existe sigue verde.

## Tasks

| ID | Spec | Qué | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2 | Log JSONL + rotación por tamaño en `relay.mjs`, con helpers puros testeados | inline | `feat(relay): persist warp event log as JSONL` |
| T2 | S3 | `POST /warp/recycle` sobre la rotación existente (drain incluido) + guard de sólo loopback | inline | `feat(relay): add manual warp recycle endpoint` |
| T3 | S4 | Comando `/free-bridge-warp-recycle` en `index.ts` | inline | `feat(extension): add /free-bridge-warp-recycle` |
| T4 | S1, S4 | README + CHANGELOG: comando nuevo y `RELAY_LOG_FILE` | inline | `docs(readme): document warp recycle command and relay log` |
| T5 | S5 | Suite completa + prueba en vivo del comando contra el relay instalado | verify | — |

## Log

- **L1** — "mira me paso dos veces uan vez en auto y otra en on revisa el log en
  la carpeta de pi  el 429 y no salia tuve que decirle a un agente con otro
  modelo que envie el recicle, que me propones, al parecer se quemaron las ips y
  no salia automaticamente, debemos tener contingencia con esto , no se ,dime
  que puiensas, ayudate con engran y mira la ramadonde estas parado"
- **L2** — "otra cosa, si queda en 429 y vuelvo a escribir deberia aber un
  recicle para no quedar em 429  forever, tambien unrecicle manual un comando de
  pi pi-free-brige-warp-recicle o algo parecido ¿que opinas?"
- **L3** — "debe se asi para que pi melo sugiera /free-bridge-warp-recycle"
- **E1** — Evidencia: el relay no persiste stderr (`index.ts:702-703`, pipe) y no
  expone superficie de control; lo único posible a mano era
  `curl -X POST http://127.0.0.1:8789/recycle` al proxy, que saltea
  `drainBeforeRotation` y tira los streams en vuelo.
- **E2** — Evidencia: `GET /health` del relay ya reporta `warp429Streak`,
  `warpRecycles`, `warpResends`, `localParkedForMs`, `lastEgress`, `pid`
  (`relay.mjs:1040-1070`), así que S4 se apoya en él y no agrega estado nuevo.
- **D1** — Decisión: slice 1 no toca warp-minimal. El swap suave de exit
  (escalera "un intento por IP") queda pendiente del contrato con esa sesión.
- **D2** — Decisión: comando plano `/free-bridge-warp-recycle`, no subcomando de
  `/free-bridge-warp`, porque Pi sugiere por prefijo plano (L3).
- **E3** — Respuesta de la sesión de warp-minimal (memoria Engram #3190): el pool
  tiene **un solo exit enrolado**, no dos. `pool_size` es la intención del
  config; `active` es `len(p.exits)`; `healthy` es un contador (`++` al crear,
  `--` en `Fail`). `ensureExit` se rinde definitivamente tras 3 intentos
  (`internal/warp/pool.go:130`) y `RecycleAll` itera solo `p.exits`
  (`pool.go:261`), así que el slot que nunca entró es invisible: no vuelve sin
  reiniciar el proceso. Ventana de bootstrap ~105s, y el proceso lleva mucho más
  con `active:1`. También corrigieron el modelo: **no existe "el exit activo"**, la
  selección es por request (`Acquire` first-healthy).
- **D3** — La escalera "un intento por IP" queda bloqueada hasta arreglar el
  bootstrap del pool en warp-minimal. Ese repo es del usuario y la decisión es
  suya.
- **D4** — Retirado el pedido "`ok:true` garantiza `pool_size` exits sanos": sería
  una promesa falsa (es el bug de E3). El relay leerá `active` y salteará el
  peldaño suave cuando `active < 2`.
- **D5** — La atribución de exit va por **selección, no por respuesta**: el túnel
  es TLS, el proxy no ve el 429 y no puede inyectar headers de respuesta. El
  relay fija el exit con un header en su propio request al proxy.
- **E4** — warp-minimal cerró su lado en `feat/per-exit-swap`: `c34e209` (el pool
  ahora sí se mantiene en `pool_size`: `fill` reintenta sin techo, contadores
  derivados, slot liberado, ids completos en `/health`), `209dd95` (`POST /swap`
  + `X-Warp-Exit` en el CONNECT), `394657f` (contrato en
  `odd/tasks/warp-per-exit-swap.md`). Verificado con `go vet`, `-race` y
  mutaciones. Sin pushear. **El binario de 8789 sigue viejo**: no tiene `/swap`
  ni el header.
- **D6** — Corregido D5: el relay llega al proxy con `fetch(url, { proxy })`
  (`relay.mjs:374`), así que Bun arma el CONNECT internamente y **no expone su
  respuesta**. Medido con un proxy falso propio: el header `X-Warp-Exit` no
  aparece, y Bun tampoco reenvía headers del cliente al CONNECT (manda solo
  `Host` y `Proxy-Connection`). El CONNECT es opaco en ambas direcciones. La
  atribución solo puede llegar por `/health`: se pide un contador monótono
  `served` por exit (o `last_connect_exit`).
- **D7** — No se pide pinning de exit: con atribución + `POST /swap` apuntado
  alcanza. Si el segundo exit también da 429, el swap queda prohibido por la
  guarda de standby (`409`), así que se espera.
- **E5** — warp-minimal cerró el contrato en `5d9f5ec`: `/health` expone
  `served` monótono por exit (`"warp-<id> (healthy, served=42, streams=0)"`),
  cuenta túneles CONNECT, nunca se resetea mientras el exit viva, y un exit
  reemplazado es un id nuevo con `served` desde 0. Pinning descartado. El
  default de `/swap` sin cuerpo se confirmó malo para este caso (elige por
  `streams` y el culpable ya está en 0): se pasa siempre el id explícito.
- **E6 (medido)** — Bun **reusa el túnel CONNECT**: 3 fetches secuenciales por
  un proxy falso → 1 solo CONNECT. Consecuencia: `served` sube una vez y queda
  quieto mientras el túnel viva, así que el delta NO atribuye la request que
  falla (el 429 típico viaja por un túnel ya establecido). Solución en el relay:
  mapa cacheado túnel→exit, aprendido en cada delta de `served`, invalidado si el
  id desaparece o cambia; delta con 2+ exits = ambiguo, no se rota. Encaja con el
  swap: drenar A mata ese túnel, la próxima request abre CONNECT y cae en B.
- **E7** — Contrato congelado (`cafded7`, 5 commits en `feat/per-exit-swap`):
  `exits[]` es siempre `"<full id> (<state>, served=<n>, streams=<n>)"`, los tres
  campos, en ese orden, **sin campos opcionales** (parseo simple). El `202` y el
  `409` traen `"target": "<id>"` (el propio, o el que está drenando en un replay
  idempotente). **Un re-enrolamiento emite id nuevo**, nunca reusa el id (hay un
  test que falla si se repite), así que comparar ids completos alcanza y no hace
  falta `served=0` ni un contador `swaps` como testigo.
- **D8** — Política de atribución (slice 2), cerrada con warp-minimal tras dos
  correcciones cruzadas. `served` es del exit, no del relay, así que un CONNECT
  ajeno (navegador, git, otro servicio) también suma. Reglas:
  1. Aprender **solo** en una ventana donde el intento propio abrió túnel: mapa
     vacío, o el intento anterior falló a nivel transporte, o se acaba de pedir
     un swap del propio exit (el drain mata ese túnel).
  2. En esa ventana, exigir delta total == 1. Delta 0 o 2+ → no aprender, mapa
     dudoso.
  3. Con mapa válido y túnel vivo, cualquier delta es ajeno → se ignora, nunca se
     sobreescribe el mapa. (Re-aprender en cada delta es el bug: un cliente
     externo movería el mapa al exit equivocado.)
  4. Mapa dudoso o vacío al decidir → no rotar, aplicar retry-after puro. El
     forzado manual queda en `/free-bridge-warp-recycle`.
  5. Delta sobre el propio exit con túnel vivo → contradicción → knockout.
  Costo acotado del error: un swap al exit equivocado = 1 enrolamiento + un drain,
  sin pérdida de datos (el swap no corta streams) y `fill` vuelve a 2.
  Nota sobre la regla 5 (observación del peer): es conservadora a propósito. Puede
  dispararse por churn legítimo del pool (idle timeout, reconexión de Bun), no solo
  por tráfico ajeno. No es un bug: cuesta un ciclo sin atribución y **se
  auto-cura** porque el mapa vacío vuelve a la regla 1 en el intento siguiente. Se
  registra como evento `attribution_knockout` en el JSONL para que la causa quede
  visible y no parezca un fallo.
