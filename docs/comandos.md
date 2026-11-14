# Comandos

Cuatro comandos registrados; lo demás se alcanza desde el menú, porque cada
comando —alias incluidos— cuesta una entrada de autocompletado.

## `free-bridge`

Abre el menú: relay, WARP, wire mode, modelos, sesión. No cuesta nada y no para
nada. Su ítem de modo WARP muestra el aviso de desajuste de build cuando el
commit que corre y el que se instaló no coinciden; si coinciden o no hay
registro del instalado, no dice nada.

## `free-bridge-warp-recycle`

Recrea el túnel ahora mismo: recuperación manual cuando un 429 se come los
turnos. Cada ejecución quema enrollments —`/recycle` vuelve a registrar cada
exit del pool, y un enrollment es lo único que el proxy no puede devolver—. El
mismo barrido corre solo en el request siguiente a un 429.

## `free-bridge-doctor`

Informa el estado: provider, modelos registrados, session id, bun, relay, WARP,
target, upstream y los modelos descartados por no ser free. No es de sólo
lectura: repara la entrada `oc-sdk-zen/*` de `enabledModels` en `settings.json`
si falta, y lo informa como `scope: repaired` (aplica en el próximo arranque,
porque Pi lee el scope una sola vez; `PI_FREE_BRIDGE_SELF_REPAIR=0` la desactiva).

## Instalar/actualizar warp (dentro del menú)

No es un comando: vive en `/free-bridge` → **WARP → Instalar/actualizar warp**,
siempre visible. Descarga siempre la última release publicada y reemplaza el
archivo, sin preguntar si «ya estás al día». Es la **única** acción que detiene
el proxy, porque el binario se reemplaza debajo del proceso que sirve. Antes de tocar nada muestra el costo —dos
enrollments, 3-5 s sin servicio, egress nuevo y cada entrada estacionada
dejando de coincidir con un exit vivo— y pide confirmación. Si el binario nuevo
no se identifica, no cuenta como éxito: no se escribe registro.

## Por qué la asimetría

El proxy es compartido entre sesiones de Pi y **nada lo detiene
automáticamente** — ni al cerrar una sesión, ni al recargar, ni al desactivar
WARP. Dejarlo vivo cuesta cero; apagarlo por error le corta el servicio a otra
sesión, así que el único apagado es un acto explícito: reemplazar el binario.
