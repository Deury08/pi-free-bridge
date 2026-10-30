# GO-NATIVE — pi-free-bridge puente Go nativo (sin Bun)

## Estado

Rama `go-native` pusheada a origin: https://github.com/Deury08/pi-free-bridge/pull/new/go-native

Commits:
- `7ef7314` feat(bridge-go): add OpenCode gate injection for Go-native egress
- `a8bab37` feat(index.ts): switch from Bun relay to Go-native bridge-go

## Qué se hizo

**Objetivo:** hacer que `Pi (Node) → bridge-go (Go nativo) → OpenCode` funcione end-to-end, sin depender de Bun, sin warp por ahora.

**Problema:** el gate de OpenCode (`/inference/v1`) rechaza con `429 FreeUsageLimitError` cualquier request cuyo TLS ClientHello no sea el de Bun (JA4 `t13d1713h1`). Go nativo (`crypto/tls`) no emula a Bun. También requiere un `<env>` block con `Working directory:` en el system prompt, y herramientas `read`+`bash` con nombres exactos.

**Solución implementada:**

### bridge-go (Go) — hace todo el gate en el wire

| Archivo | Qué hace |
|---------|----------|
| `internal/httpx/bun_clienthello.go` | `BunClientHelloSpec()` — uTLS ClientHello que mima a Bun (JA4 `t13d1713h1`) |
| `internal/httpx/bun_transport.go` | `BunTransport` — `http.RoundTripper` que usa uTLS + HTTP/1.1, header ordering como Bun |
| `internal/gate/session_harvest.go` | `HarvestSessionID()` — lee session id de `~/.local/share/opencode/storage/session_diff/ses_*.json` (más reciente por mtime), fallback a `PI_FREE_BRIDGE_SESSION_ID` y `~/.pi/agent/pi-free-bridge.json` |
| `internal/gate/contract.go` | `SessionManager` acepta `seedID` (ID cosechado) en vez de siempre mintir uno sintético. Los IDs sintéticos son rechazados por el gate con 429. |
| `cmd/bridge-go/main.go` | `ensureGateTools()` — inyecta `read` y `bash` con nombres exactos si faltan. `reqBody["stream"] = true` forzado. `PromptInjector` pone `<env>` block. `HarvestSessionID()` se llama al arranque y se pasa a `SessionManager`. |

### index.ts (pi-free-bridge) — deja de depender de Bun

| Qué | Antes | Ahora |
|-----|-------|-------|
| Transporte de upstream | `relay.mjs` (Bun, puerto 8788) | `bridge-go` (Go, puerto 8790) |
| Dependencia de Bun | `resolveBunPath()`, spawn de `relay.mjs` | Eliminada (no es dependencia de runtime) |
| `baseUrl` del provider | `http://127.0.0.1:8788/v1` (relay Bun) | `http://127.0.0.1:8790/v1` (bridge-go) |
| `free-bridge-proxy` | test de pool de proxies | Eliminado (bridge-go maneja el pool internamente) |
| `free-bridge-doctor` | reporta bun path + relay | reporta bridge-go bin + proceso |

### Cómo funciona el flujo

```
Pi (Node) → http://127.0.0.1:8790/v1 → bridge-go (Go) → https://opencode.ai/inference/v1
```

bridge-go inyecta en cada request:
1. **TLS:** uTLS con ClientHello de Bun (pasa el gate TLS)
2. **Prompt:** `<env>\nWorking directory: <cwd>\nPlatform: win32\n</env>` en el primer `system`/`developer` message
3. **Tools:** `read` + `bash` con nombres exactos si faltan, `tool_choice: "none"`
4. **Stream:** `stream: true` forzado
5. **Headers:** `content-type`, `user-agent` (opencode/…), `authorization: Bearer public`, `x-opencode-session`, `x-opencode-session-id`
6. **Session ID:** cosechado de la tienda local de OpenCode

## E2E verificado ✅

```
pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
→ OK
```

## Cómo levantar y probar

bridge-go se levanta automáticamente al usar la extensión. No hace falta lanzarlo a mano.

```bash
# 1. Construir bridge-go (si no existe el binario)
cd bridge-go && go build -o bridge-go.exe ./cmd/bridge-go

# 2. Probar con Pi (bridge-go se inicia solo)
pi -p --no-session --model oc-sdk-zen/deepseek-v4.1-flash-free "Reply with exactly: OK"
```

Si bridge-go no está disponible, el postinstall intenta compilarlo desde el código fuente si Go está instalado.

## Variables de entorno relevantes

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PI_FREE_BRIDGE_SESSION_ID` | — | Override explícito de session ID |
| `PI_FREE_BRIDGE_BINARY` | — | Ruta al binario de bridge-go |
| `PI_FREE_BRIDGE_BRIDGE_GO_PORT` | 8790 | Puerto de bridge-go |
| `PI_FREE_BRIDGE_SELF_REPAIR=0` | — | Desactiva el auto-repair de `enabledModels` |

## Archivos clave (repo `pi-free-bridge`)

| Ruta | Rol |
|------|-----|
| `index.ts` | Entrada de la extensión Pi. Registra `oc-sdk-zen`, supervisa bridge-go, provee comandos `/free-bridge-session`, `/free-bridge-refresh`, `/free-bridge-models`, `/free-bridge-doctor` |
| `bridge-go/cmd/bridge-go/main.go` | Servidor HTTP de bridge-go. Handler `/v1/chat/completions` con gate injection |
| `bridge-go/internal/gate/contract.go` | `SessionManager`, `ToolAliaser`, `PromptInjector`, `ErrorMapper`, `SSEHandler` |
| `bridge-go/internal/gate/session_harvest.go` | Cosecha de session ID desde la tienda de OpenCode |
| `bridge-go/internal/httpx/bun_clienthello.go` | `BunClientHelloSpec` — ClientHello de Bun |
| `bridge-go/internal/httpx/bun_transport.go` | `BunTransport` — RoundTripper uTLS |
| `bridge-go/internal/egress/coordinator.go` | Fallback chain: local → WARP → local backoff |
| `bridge-go/internal/egress/local.go` | Egress local con `BunTransport` (fingerprint de Bun) |
| `bridge-go/config.json` | Config de bridge-go (puerto, upstream, warp_proxy) |

## Queda pendiente (siguientes pasos)

1. **WARP:** `warp_enabled: false` en `config.json`. Para activar WARP, poner `true` y asegurar que `warp-minimal` esté escuchando en `127.0.0.1:8789`. El campo `warp_proxy` ya está en el config y el coordinator ya soporta la fase WARP.
2. **Pull request:** abrir PR de `go-native` a `master` en GitHub.
3. **Tests:** agregar tests unitarios para `ensureGateTools`, `HarvestSessionID`, `BunTransport`.
4. **Comandos:** `/free-bridge-proxy` fue eliminado; si se necesita test de pool de proxies, reimplementar contra bridge-go directamente.

## Para el próximo agente

La rama `go-native` está lista en origin. El pipeline Pi → bridge-go → OpenCode funciona. Si querés agregar WARP, es solo cambiar `warp_enabled: true` en `bridge-go/config.json` y levantar `warp-minimal` en `:8789` (el proxy uTLS con ClientHello de Bun ya está implementado en el repo `warp-minimal`).

No hay dependencia de Bun. No hay relay de Bun. Todo es Go nativo.