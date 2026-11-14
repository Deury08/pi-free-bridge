# El ledger por IP

## Se parquea una dirección, no un exit

El relay recuerda qué direcciones de egreso el gate rechazó, en un JSON que se
lee al arrancar y se reescribe en cada parqueo. Cuando el gate devuelve 429 y la
credencial del intento prueba qué salida la sirvió, el relay parquea esa salida
(`parkWarpExitOn429`): el `Proxy-Authorization` del intento nombraba un exit, así
que la dirección que respondió se sabe sin adivinar. Se guarda por **IP**, no por
exit (`quotaEgressKey`), porque la IP es lo que el gate castiga: un exit rota y
puede volver con otra dirección, y una dirección puede reaparecer en otro exit.
Una salida sin dirección nombrable no parquea nada, porque esa entrada no la
podría casar ningún request posterior; el egress local, que no tiene IP, usa la
clave `local`.

El campo es `parked_until`, un instante **absoluto** en milisegundos
(`parkQuotaEgress`). No existe `reset_at` en el relay: el proxy no interpreta
cuotas y no conoce ese concepto, sólo entrega tráfico. Lo que sabe el relay nace
de un `retry-after` que parseó, más el margen de siempre.

## El archivo

`~/.pi/agent/pi-free-bridge-quota.json`, o `RELAY_QUOTA_PATH` si el operador lo
fijó (`quotaLedgerPath`):

```json
{"version":1,"egresses":{"<ip-de-egreso>":{"prefix64":"…","exit_id":"…","parked_until":0,"observed_at":0,"reason":"gate_429","hits":1}}}
```

`prefix64` lo deriva el relay (`quotaPrefix64`) y `hits` cuenta cuántas veces se
parqueó la misma dirección. Un archivo malformado, de otra versión o ilegible se
lee como ledger vacío: es una caché, y perderla no puede fallar un request.

## Las direcciones se reutilizan: no se poda por exit

Una entrada que nombra una salida que ya no está sigue vigilando la dirección y
se conserva (`pruneQuotaLedger` sólo mira el reloj, nunca el exit). Una dirección
reciclada vuelve castigada sin importar el `exit_id`, así que el parqueo por IP
sigue siendo correcto y la entrada vieja sigue sirviendo. Lo único que se
descarta es un parqueo vencido, y sólo al reescribir el archivo
(`writeQuotaLedger`, `loadQuotaLedgerAtStartup`): la expiración es una
comparación contra el reloj, no un evento de borrado.

## Un parqueo vencido deja de contar en la lectura

`/health.quotaLedger` informa `parked`, `parkedLive`, `nearestResetInMs` y `path`
(`quotaLedgerHealth`, que se apoya en `nearestQuotaReset`). Ambos contadores
filtran por reloj al leer, así que un parqueo vencido no cuenta aunque el archivo
todavía lo tenga. `parkedLive` cuenta sólo los parqueos cuyo exit sigue en el
pool; `null` significa que el pool no respondió —no saber no es lo mismo que
saber que no hay— y `0` que respondió con la lista vacía.

## Un egreso parqueado se omite, nunca se intenta

El carril gratuito descarta los parqueados antes de elegir (`freeRoundOrder`, con
`isEgressParked`), y `chooseWarpExit` hace lo mismo al preferir. El ledger evita
redescubrir direcciones quemadas; no es una fuente de veredictos, nunca se
fabrica un rechazo desde él. Sin ninguna salida limpia hay igual un último
intento real por el último candidato del orden, y lo que responda se entrega tal
cual. Las decisiones están en
[`odd/tasks/warp-per-exit-quota.md`](../odd/tasks/warp-per-exit-quota.md).
