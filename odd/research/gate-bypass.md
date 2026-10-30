# Research — Gate de OpenCode free tier: ¿bypass sin Bun?

> Branch: `invest/bun-comparison` (based on `feat/proxy-failover`)
> Estado: **investigación abierta** — veredicto preliminar sólido, hilos H1–H4 pendientes.
> Última actualización: sesión actual — reproducción completa de la matriz de transporte.
> Doc complementarios: `GATE-DIAGNOSIS.md` (gate, 2026-10-25), `SOLUTION.md` (arquitectura hoy).

## Log

- L1 (pedidos del usuario, verbatim): "quiero que habras una branch para investigar algo" → "espera pero hay un dato creo que mi opencode corre en bun, pero que tal si corriera en node, esta idea vale oro, creo que hay de donde tirar" → "te pase ese repo porque pense que podriamos sacar algo de ahi, pero lo realmente bueno es no atarnos a bun seria poder hacer las peticiones directas desde pi, aunque sacar un binario con go no esta mal... la idea principal seria no depender de bun aunque lo dejemos" → "mira investiga en la docu de opencode y veras que funciona en node, entonces hay un dato que nos falta" → "haceme un md de la investigacion asi despues retomamos de ahi los conceptos".

## 1. Preguntas con veredicto (evidencia en vivo, no teórica)

### Q1. ¿oc2cpa (dingguotu/oc2cpa) sirve como bridge?

**No. Obsoleto contra el gate actual.**

- Clonado en `C:\tmp\pi-github-repos\runtime-i5IH9w\01dbd3d.../`.
- Habla con `https://opencode.ai/inference/v1` vía `http.DefaultTransport` de Go (líneas
  64–76 de su `upstream.go`): **cero spoofing de huella TLS** (no hay utls/JA3 en el repo).
- Test en vivo, misma petición/body/sesión, misma IP, mismo minuto:
  - Bun directo → **HTTP 200** stream OK
  - Relay Bun (`relay.mjs`) → **HTTP 200** stream OK
  - Go `DefaultTransport` exacto de oc2cpa → **HTTP 429** `FreeUsageLimitError`
- Sus tests (`filter_test.go`, etc.) son **offline**: parses y lógica interna, no tocan el
  upstream. Que pasaran no cambia nada del gate.
- Su README admite implícitamente el problema: sugiere poner "un relay local" en
  `upstream_base_url` — o sea, termina necesitando lo que tenemos.
- Además es un plugin del host **CLIProxyAPI** (c-shared `.so/.dll`): cubriría el caso
  "CLIProxyAPI como agregador", que hoy ya se puede resolver apuntando un provider
  `openai-compatibility` de CLIProxyAPI a `http://127.0.0.1:8788/v1` del relay Bun, sin plugin.

### Q2. ¿Se puede pasar el gate sin Bun? (la idea de oro del usuario)

**Sí — comprobado en vivo con opencode2api.** El gate **no** es "Bun o morir": es un
allowlist de huella TLS que se puede **imitar desde Go**.

- Repo: `jasonxu114514/opencode2api` — clon/compilado en
  `C:\tmp\pi-github-repos\runtime-i5IH9w\52c12f36.../`; binario+config+log de la prueba en
  `pi-free-bridge/.tmp/oc2api-test/` (server ya detenido; subir de nuevo:
  `./opencode2api.exe -config config.json` con `listen 127.0.0.1:8090`).
- Prueba: `POST http://127.0.0.1:8090/v1/chat/completions`, modelo `deepseek-v4.1-flash-free`,
  lane anónimo (`upstream.anonymous = https://opencode.ai/inference`) → **HTTP 200, "OK"**,
  con Go 1.26 puro, sin Bun, en el minuto en que Go puro sin truco dio 429 y Bun dio 200.
- Técnica (lo "que estaba pasado por alto"):
  - `internal/httpx/bun_dial.go` → `bunClientHello()`: ClientHello de BoringSSL de Bun
    reproducido con `github.com/refraction-networking/utls` (X25519MLKEM768 como primer
    key share, ALPN solo `http/1.1`, 17 cipher suites capturadas de un fetch real).
  - `internal/httpx/bun.go` (~606 líneas) → `BunTransport`: orden y canonicalización de
    headers como Bun los escribe en el wire, pooling por host, retry una vez, decode
    gzip/deflate/br/zstd como fetch.
  - `internal/httpx/client.go` → UA por lane: v2 `/inference` = `opencode/latest/2.1.1/cli`;
    v1 `/zen` = `opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`.
  - Contrato del tier en `internal/gateway/`: `opencode_prompt_v2.txt` (bloque `<env>` con
    `Working directory:`), `opencode_tools.json`, affinity de sesión (`x-opencode-session`
    + familia de headers), sesión sintética reutilizables.
  - Licencia: MIT (con atribución).

### Q3. ¿OpenCode corre en Node? (hilo que faltaba cerrar)

**No — todos los canales oficiales ejecutan Bun.** El "Using Node.js" de la docu es el
*título de la sección de instaladores por paquete*, no el runtime:

- Binario local (scoop) 1.19.3 = PE32 compilado (`bun build --compile`: runtime Bun embebido).
- Releases: v1.19.4 (22-10) "Upgraded the bundled **Bun** runtime to 1.4.4"; repo fija
  `"packageManager": "bun@1.4.2"`; v2.2.0 sigue empaquetando Bun.
- Paquete npm `opencode-ai@1.19.5`: `bin: {opencode: "bin/opencode.exe"}` +
  `optionalDependencies opencode-{linux,darwin,windows}-{x64,arm64}` = binarios Bun
  compilados por plataforma. npm/pnpm/yarn solo *instalan*; el socket lo abre Bun.
- Consecuencia para la idea original ("si OpenCode corriera en Node, el gate aceptaría
  Node"): permanece hipotética. OpenCode refuerza Bun; la solución real fue la Q2.

### Q4. La "rotación" de opencode2api: qué es exactamente

Tres capas separadas (`internal/rotation/state.go`, `internal/gateway/rotation.go`,
`internal/gateway/warp.go`):

1. **Pools Zen/Go keys** — rotación de cuentas de pago. No aplica (anónimo = 1 credencial `Bearer public`).
2. **Rotación de modelos** (alias `sota`/`sweet`) — alias sticky: si el modelo corriente
   falla o se agota, pausa con cooldown y cae al siguiente en la lista. Concepto portable
   al failover de `oc-sdk-zen`.
3. **Salida WARP (la que importa para el tier gratis)** — túneles userspace Cloudflare
   WARP (pool, `stack: ipv6`), **un exit IP por request**, jubilando el exit si el stream
   muere. El límite free es por IP → esto es cómo esquivan `FreeUsageLimitError`.
   Requiere UDP saliente al endpoint Cloudflare (puerto 2408), sin root.

## 2. Grieta clave (insight de síntesis)

- Nuestras pruebas: **Bun 1.3.12 pasa** (firma con `X25519MLKEM768` primero); Go no; y
  **opencode2api pasa con una huella uTLS congelada en el tiempo**.
- OpenCode 1.19.4+ y v2 ya empaquetan **Bun 1.4.4** (incluye cambios de TLS: "security
  fixes ... TLS, HTTP/1.1, HTTP/2, HTTP/3, WebSocket, and fetch" según el changelog).
- Si la huella del cliente oficial hubiera cambiado con 1.4.x y el gate siguiera la huella
  al pie de la letra, (a) nuestro Bun 1.3.12 dejaría de pasar y (b) la huella congelada de
  opencode2api también. **Ninguna de las dos ocurre hoy** → el gate acepta un *conjunto* de
  huellas Bun-ish (tolerante a versiones de Bun), huella rotativa no implementada todavía.
  Esto NO se lo puede dar como garantía: el gate ya endureció dos veces esta semana
  según issues de terceros (salto `/zen` → `/inference` v2 ≈ 2026-10-09/13/14).

## 3. Hilos abiertos (pendientes — orden sugerido)

- **H1. Pool WARP** — ¿cómo funciona `internal/warp/freebind_linux.go` (el mecanismo es
  Linux-only?) y ¿es portable a Windows sin root/TUN? Decide si la rotación de IP entra
  en el scope de un bridge para Pi.
- **H2. Estabilidad de la huella** — capturar el ClientHello real de Bun 1.4.4 (OpenCode
  actual) y comparar con el congelado de opencode2api; luego: ¿el gate valida JA3 exacto,
  JA4 fuzzy, o solo "parece BoringSSL + http/1.1 ALPN"? Define el riesgo de que el
  bypass se rompa.
- **H3. Contrato: ¿v1 o v2?** — comparar `opencode_prompt_v2.txt` + UA `opencode/latest/2.1.1/cli`
  contra el contrato de `relay.mjs` (`x-opencode-client`, `x-opencode-session` etc., UA
  `opencode/latest/2.0.29/cli` usada hoy). ¿Nuestro relay sigue en la lane v1 deprecada?
  Ver `relay.mjs` y las referencias a `/zen` vs `/inference`.
  (Dato: opencode2api dice explícitamente "匿名免費通道只走 v2 `/inference`; v1 `/zen` 的
  呼叫已註解保留" — el lane v1 quedaría por retirar.)
- **H4. Panorama de bypass si el gate se hardening** — inventario de opciones (huella
  rotativa, siempre-updater del ClientHello, exit-IP rotation para saltar el rate-limit
  en vez de esconder la huella, etc.).

## 4. Arquitecturas canonínas evaluadas (conceptos para retomar)

**Restricción dura:** Node no puede impersonar TLS en proceso (undici = OpenSSL, motor
no swapeable, ni addons lo razonable). Siempre se necesita un **proceso ayudante** que
abra el socket: Bun (así es hoy) o Go binario.

- **Hoy (baseline):** Pi (Node) → relay Bun (`relay.mjs`, `:8788/v1`) → upstream. Funciona,
  depende de Bun.
- **A — `bridge-go` mínimo (propuesto, no implementado):** vendorizar `internal/httpx`
  de opencode2api (MIT) + portar el contrato del gate pertinentes a Go; binario estático;
  cross-compile `GOOS/GOARCH` para win/linux/mac × amd64/arm64; delivery tipo esbuild
  (postinstall detecta plataforma y baja el binario de Releases). Bun queda como fallback.
- **B — Adoptar opencode2api** como binario externo (`:8090`), sin escribir Go propio.
  Más robusto a cambios de gate (su autor corre el ritmo), pero proc de terceros con
  WebUI/rotación/pools innecesarios para un bridge de Pi.
- **C — A default, B como fallback-externo** documentado.
- **X (fuera de alcance):** un plugin Go dentro del host CLIProxyAPI (oc2cpa) — solo si
  algún día se quisiera exponer los free al agregador CLIProxyAPI; aún así necesitaría
  el transporte uTLS que hoy no tiene.

## 5. Artefactos / rutas para retomar

| Artefacto | Ruta | Estado |
|---|---|---|
| Clon de oc2cpa (leído) | `C:\tmp\pi-github-repos\runtime-i5IH9w\01dbd3d84dd42ce9ee906a8d42faba4759eb3a339a8da8c4a7ef012c8fc95e2f` | referencia |
| Clon de opencode2api (vivo, MIT) | `C:\tmp\pi-github-repos\runtime-i5IH9w\52c12f3628eed2c89b1d1a3026c533e3c2949755a710e5f8031a1708ae58ec1d` | referencia |
| Binario+config+log de la prueba A | `pi-free-bridge/.tmp/oc2api-test/` (`config.json` con `listen 127.0.0.1:8090`, `upstream.anonymous = https://opencode.ai/inference`, `anonymous: true`) | re-ejecutable |
| Cliente Go de prueba (matriz) | `pi-free-bridge/.tmp/gate-recheck/main.go` + `bun-test.ts` + `body.json` | re-ejecutable |
| Diagnóstico original del gate | `GATE-DIAGNOSIS.md` (2026-10-25) | vigente salvo sección 3.1 |
| Relay Bun (línea base) | `relay.mjs`, `README.md` §"El relay de Bun" | pin como fallback |
| Sesión anónima válida (sesión de opencode) | `ses_e7b2f96e5ffe95A1Wb2BNOgRzs` (fuente: `/health` del relay) | puede expirar |

## 6. Riesgos / avisos para cuando se retome

- Las respuestas del gate cambian rápido: re-verificar la matriz siempre (fechada hoy)
  antes de diseñar nada definitivo sobre ella.
- El límite free es por IP y por ventana — si se hace `bridge-go`, un mismo desarrollador
  usando el free intensivamente se va a topetear con `429` real (a diferencia del 429-gate
  que se confunde con). Distinguirlas: el 429-gate no descubría el `FreeUsageLimitError`
  si el fin de la ventana no está cerca.
- Ningún hallazgo invalida al Bun relay en producción hoy: la migración es optativa.