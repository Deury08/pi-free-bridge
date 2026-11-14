# La escalera del 429

Cuando el gate devuelve 429, el relay sube una escalera de coste creciente
(`recoverWarp429`). El proxy no participa de la política: entrega tráfico y
expone verbos. Nunca interpreta un 429 ni guarda cuotas; la decisión de qué
intentar, en qué orden y cuántas veces vive entera en el relay.

## Ronda 1: el carril gratis

El relay intenta las salidas que el pool **ya tiene**, una vez cada una, en el
orden que rankea `chooseWarpExit` (`freeRoundOrder`). No cuesta ningún
enrollment, y cada 429 atribuible a una salida parquea esa dirección antes de
pasar a la siguiente.

Un egreso parqueado se **omite**: no se intenta, no gasta un request
(`isEgressParked`). El ledger existe para evitar las direcciones quemadas, no
para redescubrirlas.

## Ronda 2: un único cambio dirigido

Agotado el carril gratis, la ronda pagada hace **un** cambio dirigido a la salida
que sirvió el 429 (`POST /swap {"exit": id}`): esa salida y sólo esa, un
enrollment, sin cortar el pool ni los streams del otro exit. Se prefiere sobre
`POST /recycle` porque el reciclaje re-registra en paralelo cada salida que no
esté enfriándose —un enrollment **por salida**, incluidas las que nunca
estuvieron implicadas— y sólo se usa como respaldo cuando el proxy responde que
no tiene `/swap`.

La rotación queda como último recurso: cada una quema enrollments, lo único que
el proxy no puede devolver. Por eso la ronda 2 corre una sola vez y nunca se
re-entra a la ronda 1 después de una entrega. La serializa el single-flight
(exclusión mutua), no un reloj: 18 enrollments en 55 minutos sin un solo rechazo
por tasa es la razón de que no haya cool-down.

## El 429 terminal

Si las dos rondas fallan, el cliente recibe **un** 429, y es el último rechazo
real: los bytes son los del último intento que produjo respuesta —su
`retry-after` incluido— y no un rechazo inventado desde el ledger. Si ese último
intento no produjo respuesta alguna, se entrega el 429 original. Nada reintenta
después de esa entrega: la decisión es final para ese request.

Con todas las salidas parqueadas el relay **sí** intenta: hace un único intento
final por la última candidata de su propio orden y entrega lo que ese intento
responda, porque un rechazo fabricado desde el ledger no es evidencia de nada.

## Qué se puede mirar

`/health` publica cada peldaño, porque una escalera invisible es indistinguible
de un request que funcionó: `warpCrossExitAttempts` (ronda 1 por otra salida),
`warpSwaps` (cambios dirigidos), `warpRecycles` (rotaciones) y
`warpTerminal429s` (el 429 que vio el cliente).
