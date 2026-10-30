# Plan: pi-free-bridge Go-Native — Solo binario pre-compilado

## Decisión

**Solo opción plug-and-play (pre-built binary).** No se contempla instalación local ni compilación desde source.

El usuario instala con:
```
pi install git:github.com/Deury08/pi-free-bridge#go-native
```

El `postinstall` descarga el binario correcto para el OS desde GitHub Releases. Si no hay release disponible, falla con instrucciones claras. No se intenta compilar desde source.

## Flujo de instalación

1. Usuario ejecuta `pi install git:github.com/Deury08/pi-free-bridge#go-native`
2. Pi clona el repo
3. `postinstall` se ejecuta:
   - Detecta OS → busca binario en `bin/<os>/pi-free-bridge`
   - Si existe → lo copia a la ubicación esperada
   - Si no existe → intenta descargar de GitHub Releases
   - Si no hay release → error con instrucciones ("instala Go y compila manualmente")
4. Pi registra la extensión
5. Al primer uso, la extensión arranca `pi-free-bridge` (el binario Go)

## Lo que NO se contempla

- Instalación por ruta local (`pi install ./ruta`) — no se ejecuta postinstall
- Compilación automática desde source — requiere Go instalado, no es plug-and-play
- Warp — por ahora queda apagado (`warp_enabled: false`)

## Estructura del repo (rama go-native, limpia)

```
pi-free-bridge/
├── index.ts              # Extensión Pi (sin Bun, sin relay)
├── package.json
├── bin/                  # Binarios pre-compilados por OS
│   ├── windows/
│   │   └── pi-free-bridge.exe
│   ├── linux/
│   │   └── pi-free-bridge
│   └── darwin/
│       └── pi-free-bridge
├── bridge-go/            # Código fuente Go (solo para CI/release)
│   ├── cmd/
│   ├── internal/
│   └── go.mod
├── scripts/
│   └── postinstall.mjs   # Descarga binario por OS → si no hay, error
├── test/
│   ├── gate-tools.mjs
│   └── settings.mjs
├── README.md
└── GO-NATIVE.md
```

## Lo que se elimina (innecesario)

- `relay.mjs` (relay de Bun)
- Todo código de Bun en `index.ts`
- `HANDOFF.md`, `SOLUTION.md`, `SUMMARY.md`, `CONTINUACION.md`
- `odd/` (tareas de ODD completadas)
- `big.txt`, `raw_*.txt` (debug)
- `.tmp/` (temporales)
- `GATE-DIAGNOSIS.md` (opcional, conservar como referencia)

## Docker (futuro)

Una sola imagen con `pi-free-bridge` + `warp-minimal`. Solo documentar por ahora, implementar después.

## Release workflow

Tag `v*` en la rama `go-native` dispara `.github/workflows/release.yml` que compila `pi-free-bridge` para 6 plataformas y crea el release.

## Comandos Pi (sin cambios)

Los comandos del usuario en Pi deben ser exactamente los mismos:
- `/free-bridge-session` — ver o setear session ID
- `/free-bridge-refresh` — re-fetch de modelos libres
- `/free-bridge-models` — listar modelos registrados
- `/free-bridge-doctor` — diagnóstico
- `/free-bridge-proxy` — test de conectividad bridge-go

## Decisión confirmada por el usuario

- Solo binario pre-compilado (no compilación automática)
- No instalación local (no se contempla)
- Sin Bun en el repo
- Docker: solo documentar por ahora, implementar después
- Warp: apagado por ahora
- Rama master intacta (producción)

## Decisión: Cosecho híbrido de session ID

**Quién cosecha:** Pi (máquina del usuario) con fallback en bridge-go (si está en la misma máquina).

**Flujo:**
1. Pi cosecha el session ID de ~/.local/share/opencode/storage/session_diff/ (más reciente por mtime)
2. Pi pasa el ID a bridge-go vía variable de entorno PI_FREE_BRIDGE_SESSION_ID al hacer spawn
3. bridge-go revisa la env var primero; si no hay, intenta cosechar localmente (fallback para misma máquina)
4. Si no hay ID en ningún lado → error con instrucciones claras

**Beneficio:** Funciona en Docker y máquinas remotas (Pi pasa el ID). Funciona en misma máquina (bridge-go cosecha solo). Sin latencia adicional (~3 ms en startup, 0 ms por request).

**Pool de IDs:** No se contempla. Los IDs de OpenCode no expiran (confianza permanente). Un solo ID cosechado es suficiente. Mintear IDs sintéticos no funciona (el gate los rechaza ~83% de las veces).

## Rutas de cosecho multi-OS (verificado en Windows)

Las rutas de OpenCode son iguales en todos los OS porque OpenCode usa el home directory del usuario (~ / $HOME / %USERPROFILE%):

- ~/.local/share/opencode/storage/session_diff/ (Linux, macOS, Windows)
- ~/.local/share/opencode/opencode.db (Linux, macOS, Windows)

Verificado en Windows: C:\Users\Polanco\.local\share\opencode\ existe y contiene opencode.db, storage/session_diff/, auth.json, etc.

Conclusión: No se necesita lógica multi-OS. La ruta ~/.local/share/opencode/ funciona en todos los sistemas operativos. Tanto Pi (TS) como bridge-go (Go) pueden usar os.UserHomeDir() / homedir() para resolver la ruta.

## Para el próximo agente

1. Limpiar la rama go-native (eliminar archivos innecesarios)
2. Crear directorio bin/ con subdirectorios por OS
3. Actualizar postinstall.mjs para buscar binario en bin/<os>/ primero
4. Implementar cosecho híbrido: Pi cosecha + pasa via env var, bridge-go fallback
5. Publicar tag v0.1.0 para disparar el release
6. Actualizar GO-NATIVE.md con las instrucciones finales

## Rutas de cosecho multi-OS (investigado en internet)

OpenCode usa `xdg-basedir` que devuelve `~/.local/share` en **todos los OS** (incluyendo Windows). No usa `%APPDATA%` ni `%LOCALAPPDATA%`.

### Ruta base

```
$XDG_DATA_HOME/opencode/    (si XDG_DATA_HOME está seteado)
~/.local/share/opencode/     (fallback, en Linux, macOS Y Windows)
```

Verificado por:
- Docs oficiales de OpenCode: Windows → `%USERPROFILE%\.local\share\opencode`
- Múltiples herramientas third-party que replican el comportamiento de OpenCode
- El paquete npm `xdg-basedir` que OpenCode usa internamente

### Rutas de cosecho

| Recurso | Ruta | Existe en Windows |
|---------|------|-------------------|
| session_diff | `~/.local/share/opencode/storage/session_diff/` | ✅ Verificado |
| opencode.db | `~/.local/share/opencode/opencode.db` | ✅ Verificado |
| auth.json | `~/.local/share/opencode/auth.json` | ✅ Verificado |

### Override

OpenCode también soporta `OPENCODE_DATA_DIR` que overridea toda la ruta de datos.

### Conclusión para Pi (TS) y bridge-go (Go)

No se necesita lógica multi-OS. Ambos pueden resolver la ruta con:

- **Go:** `os.UserHomeDir()` + `/.local/share/opencode/` (con check de `XDG_DATA_HOME` y `OPENCODE_DATA_DIR`)
- **TS:** `os.homedir()` + `/.local/share/opencode/` (con check de `process.env.XDG_DATA_HOME` y `process.env.OPENCODE_DATA_DIR`)

La prioridad de override es:
1. `OPENCODE_DATA_DIR` (override completo)
2. `XDG_DATA_HOME` + `/opencode`
3. `~/.local/share/opencode` (default, todos los OS)
