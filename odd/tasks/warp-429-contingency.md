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
