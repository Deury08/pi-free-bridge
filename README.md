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

- **"pi-free-bridge: bridge-go is not reachable"**: El binario no se descargó o no se puede ejecutar. Ejecutar `/free-bridge-doctor` para diagnóstico.
- **"No free models discovered"**: El registry de OpenCode no está disponible. Ejecutar `/free-bridge-refresh`.
- **429 FreeUsageLimitError**: El gate rechazó el request. Verificar que bridge-go esté corriendo y que el session ID sea válido (`/free-bridge-session`).
- **El paquete desaparece después de `pi update`**: `pi list`, y después `pi install git:github.com/Deury08/pi-free-bridge#go-native`.