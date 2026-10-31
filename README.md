# pi-free-bridge

Puente [OpenCode](https://opencode.ai) solo-modelos-gratis para [Pi](https://github.com/earendil-works/pi-coding-agent).

Registra **únicamente** el tier gratuito anónimo de OpenCode bajo el provider id
**`oc-sdk-zen`** e inyecta el contrato del gate desde un binario Go nativo
(`pi-free-bridge`), así que sobrevive a `pi update` y no depende de ningún
puente de terceros ni de Bun.

## Instalar

```bash
pi install git:github.com/Deury08/pi-free-bridge#go-native
pi -p --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
```

Reemplaza al puente de terceros `pi-opencode-bridge`; **no corran los dos en paralelo**.
Sacalo con `pi remove npm:pi-opencode-bridge`.

## Cómo funciona

El gate de `/inference/v1` inspecciona el fingerprint TLS del cliente y solo
acepta clientes que se parezcan a Bun. Pi 1.2.0 corre sobre Node, así que ningún
request que salga desde Pi puede pasar el gate. Por eso la extensión arranca un
binario Go nativo (`pi-free-bridge`) que:

1. Escucha en `http://127.0.0.1:8790/v1`
2. Usa uTLS con ClientHello de Bun (JA4 `t13d1713h1`) para pasar el gate TLS
3. Inyecta los headers del gate (`content-type`, `user-agent`, `authorization`, `x-opencode-session`, `x-opencode-session-id`)
4. Inyecta el bloque `<env>` con `Working directory:` en el system prompt
5. Inyecta las tools `read` y `bash` si faltan
6. Fuerza `stream: true`
7. Cosecha el session ID de la tienda local de OpenCode
8. Reenvía a `https://opencode.ai/inference/v1` y pipea la respuesta SSE byte por byte

```
Pi (Node) → http://127.0.0.1:8790/v1/chat/completions → pi-free-bridge (Go) → OpenCode
```

El binario se descarga automáticamente al instalar (postinstall) o al primer
uso. No requiere Go ni Bun instalados.

### Puerto

Por defecto el binario escucha en `127.0.0.1:8790` y expone `GET /health`:

```json
{"service":"pi-free-bridge","ok":true,"sessionId":"ses_…","sessionSource":"opencode.db"}
```

`sessionSource` es `env`, `config`, `opencode.db` o `session-diff`. El puerto se
puede cambiar con `PI_FREE_BRIDGE_BRIDGE_GO_PORT`.

### Arranque y recuperación (launcher, multiplataforma)

Al pedir el puerto, la extensión primero pregunta si ya hay una instancia
sana (`GET /health`, hasta 3 intentos × 750 ms con 500 ms de pausa: tolera el
cold-start de un binario recién lanzado, por ejemplo un escaneo de antivirus).
Si no responde y un proceso `pi-free-bridge` viejo de una sesión anterior quedó
colgado con el puerto tomado, el launcher lo identifica por pid dueño del
socket y nombre de proceso, lo mata y arranca una instancia nueva una sola vez
(acotado). El mecanismo es multiplataforma:

- **Windows**: `netstat -ano` para el pid, `Get-Process` para la identidad,
  `taskkill /T /F` para terminar todo el árbol de procesos.
- **Linux/macOS**: `lsof -t -i TCP:<puerto> -sTCP:LISTEN` para el pid,
  `ps -p <pid> -o comm=` para la identidad, `SIGKILL` para terminar.

Nunca mata un dueño del puerto que no pueda identificar positivamente como
`pi-free-bridge`; si el puerto lo tiene otro servicio, reporta que hay que
elegir otro puerto en vez de matar nada. Si las herramientas del SO no están
disponibles (por ejemplo `lsof` ausente), la recuperación se degrada a
best-effort y el error original se reporta sin matar nada.

## Instalación

### Plug-and-play (recomendado)

```bash
pi install git:github.com/Deury08/pi-free-bridge#go-native
```

El `postinstall` descarga automáticamente el binario correcto para tu OS desde
GitHub Releases. No requiere Go ni Bun.

### Si no hay release disponible

El postinstall intenta compilar desde source si Go está instalado. Si no, muestra
instrucciones para compilar manualmente:

```bash
git clone -b go-native https://github.com/Deury08/pi-free-bridge.git
cd pi-free-bridge/bridge-go
go build -ldflags "-X main.Version=v0.1.0" -o pi-free-bridge ./cmd/bridge-go
cd ..
pi install ./
```

## Comandos en Pi

| Comando | Descripción |
|---------|-------------|
| `/free-bridge-session` | Ver o setear el session ID |
| `/free-bridge-refresh` | Re-fetch de la lista de modelos libres |
| `/free-bridge-models` | Listar modelos registrados |
| `/free-bridge-doctor` | Diagnóstico completo |
| `/free-bridge-proxy` | Test de conectividad bridge-go |
| `/free-bridge-update` | Forzar check de actualización |
| `/free-bridge-auto-update` | Activar/desactivar auto-update |

## Auto-update

Desactivado por defecto. Para activar:

```bash
# Variable de entorno
PI_FREE_BRIDGE_AUTO_UPDATE=1 pi

# O desde Pi
/free-bridge-auto-update
```

Si está activo, verifica cada 24h si hay una versión nueva en GitHub Releases y
pregunta antes de actualizar. Nunca actualiza sin confirmación.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PI_FREE_BRIDGE_SESSION_ID` | — | Override del session ID |
| `PI_FREE_BRIDGE_BINARY` | — | Ruta al binario pi-free-bridge |
| `PI_FREE_BRIDGE_BRIDGE_GO_PORT` | `8790` | Puerto de bridge-go |
| `PI_FREE_BRIDGE_AUTO_UPDATE` | `0` (off) | Activa/desactiva auto-update |
| `PI_FREE_BRIDGE_AUTO_UPDATE_INTERVAL` | `86400` (24h) | Intervalo de verificación |
| `PI_FREE_BRIDGE_SELF_REPAIR` | — | `0` para desactivar auto-repair de enabledModels |

## Session ID

El gate de OpenCode solo confía en session IDs creados por el cliente oficial de
OpenCode. bridge-go cosecha uno automáticamente de la tienda local:

- `~/.local/share/opencode/storage/session_diff/ses_*.json` (más reciente por mtime)
- `~/.local/share/opencode/opencode.db` (SQLite, newest session)

Si no hay OpenCode instalado, setear `PI_FREE_BRIDGE_SESSION_ID` manualmente.

## Docker (futuro)

Una sola imagen contendrá `pi-free-bridge` + `warp-minimal` para no levantar dos
imágenes. Por ahora solo documentado, no implementado.

## Troubleshooting

- **"bridge-go started but did not answer /health"**: suele ser un zombie de una sesión anterior con el puerto tomado. El launcher ahora lo mata y reincida una vez; si persiste, ejecutar `/free-bridge-doctor` o cambiar el puerto con `PI_FREE_BRIDGE_BRIDGE_GO_PORT`. Causas posibles: instancia previa colgada, o antivirus demorando mucho más de los 3 intentos de arranque.
- **"bridge-go is not reachable"**: El binario no se descargó o no se puede ejecutar. Ejecutar `/free-bridge-doctor` para diagnóstico.
- **"No free models discovered"**: El registry de OpenCode no está disponible. Ejecutar `/free-bridge-refresh`.
- **429 FreeUsageLimitError**: El gate rechazó el request. Verificar que bridge-go esté corriendo y que el session ID sea válido (`/free-bridge-session`).
- **El paquete desaparece después de `pi update`**: `pi list`, y después `pi install git:github.com/Deury08/pi-free-bridge#go-native`.

## Notas técnicas

- El binario `pi-free-bridge` registra la línea "listening on" en su log **antes** de intentar el bind del puerto; si otra instancia posee el puerto la línea es solo informativa y el proceso muere enseguida con un error de bind. Es la razón por la que el recovery del launcher existe (ver `odd/tasks/bridge-go-health-recovery.md`).
- Los helpers puros de launcher y recovery son módulos `.mjs` testables con Node (`node --test test/`): `relay.mjs` (eliminado en la rama go-native; su test quedó obsoleto) y `health-recovery.mjs` (probe con reintentos, lookup del pid dueño del puerto, guardia de identidad y kill acotado, todos multiplataforma).