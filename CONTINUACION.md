# Continuación: Implementación WARP real + Integración completa

> Branch: `invest/bun-comparison` (pi-free-bridge)  
> Estado: **warp-minimal v0.1.0 publicado (stubs)** · bridge-go completo (MIT) · pi-free-bridge integrado  
> Próxima sesión: Implementar WARP real en warp-minimal + conectar bridge-go + test E2E

---

## Contexto rápido

| Componente | Estado | Qué falta |
|------------|--------|-----------|
| **warp-minimal** | v0.1.0 publicado (stubs) | Registro Cloudflare real + túnel WireGuard + proxy uTLS |
| **bridge-go** | Completo (MIT) | Conectar `warp_proxy` en coordinator |
| **pi-free-bridge** | Integrado (postinstall, doctor, relay) | Test E2E con Pi real |

---

## Tareas pendientes (orden de ejecución)

### 1. warp-minimal: WARP real (3-4h)

#### 1.1 `internal/warp/register.go` — Registro Cloudflare
```go
// Implementar:
// 1. Generar X25519 key pair (ecdh.X25519())
// 2. POST https://api.cloudflareclient.com/v0a2158/reg
//    Body: { key: base64(pub), install_id: "", fcm_token: "", model: "PC", 
//            serial_number: <16 hex>, locale: "en_US", warp_enabled: true,
//            type: "windows", app_version: "6.23", os_version: "10.0.19045" }
//    Headers: Content-Type: application/json, User-Agent: okhttp/4.9.3,
//             Cf-Client-Version: 6.23
// 3. Parse response → WireGuardConfig
// 4. HKDF-ChaCha20Poly1305 key derivation (shared secret + salt "cloudflare warp" + info "wireguard")
// 5. Return WireGuardConfig{PrivateKey, PeerPublicKey, Endpoint, ClientIPv6, Reserved}
```

**Referencia**: Cliente 1.1.1.1 / opencode2api `internal/warp/registrar.go`

#### 1.2 `internal/warp/tunnel.go` — WireGuard userspace
```go
// Usar:
// - golang.zx2c4.com/wireguard/device
// - gvisor.dev/gvisor/pkg/tcpip/stack + netstack
// 
// Pasos:
// 1. Parse private key + peer public key (base64)
// 2. device.NewDevice(tun, bind, logger) — tun = netstack.CreateNetTUN()
// 3. dev.SetConfiguration(`private_key=...`)
// 4. dialer = &net.Dialer{Control: network.ControlFunc()}
// 5. dev.Up()
// 6. DialContext usa dialer.DialContext()
```

**Referencia**: opencode2api `internal/warp/exit.go` + `internal/warp/pool.go`

#### 1.3 `internal/warp/proxy.go` — uTLS + dial
```go
// 1. Acquire exit from pool
// 2. exit.DialContext(ctx, "tcp", host:port) → net.Conn
// 3. Si HTTPS: utls.UClient(conn, &utls.Config{ServerName, NextProtos: ["http/1.1"]}, utls.HelloCustom)
//    tlsConn.ApplyPreset(bunClientHelloSpec()) // JA4 t13d1713h1
// 4. tlsConn.HandshakeContext(ctx)
// 5. r.Write(conn) / http.ReadResponse()
// 6. Release exit on response close
```

#### 1.4 Test local
```bash
cd warp-minimal
go build -o warp-minimal ./cmd/warp-minimal
./warp-minimal -config config.json
# En otra terminal:
curl -x http://127.0.0.1:8789 https://httpbin.org/ip
# Debe mostrar IPv6 de Cloudflare (2a09:bac5:...)
```

### 2. bridge-go: Conectar warp_proxy (30 min)

En `bridge-go/internal/egress/coordinator.go`:
```go
// En RoundTrip(), fase WARP:
if c.config.WarpProxy != "" && !c.local.IsCooledDown() {
    // Forward a warp-minimal
    req.URL, _ = url.Parse(c.config.WarpProxy)
    req.Host = "127.0.0.1:8789"
    return http.DefaultClient.Do(req)
}
```

En `bridge-go/cmd/bridge-go/main.go` config:
```json
{
  "warp_enabled": true,
  "warp_proxy": "http://127.0.0.1:8789"
}
```

### 3. Test E2E completo (1h)

```bash
# Terminal 1: warp-minimal
cd warp-minimal && ./warp-minimal -config config.json

# Terminal 2: bridge-go
cd pi-free-bridge/bridge-go && ./bridge-go -config config.json

# Terminal 3: Pi (o curl directo)
curl -x http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer test" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"OK"}]}'
# Debe responder 200 con respuesta del modelo
```

### 4. pi-free-bridge: Postinstall WARP opcional (30 min)

En `scripts/postinstall.mjs`:
```javascript
// Si process.env.PI_FREE_BRIDGE_WARP === "true" o flag --warp
if (process.env.PI_FREE_BRIDGE_WARP === "true") {
  await downloadBinary("warp-minimal", version, BIN_DIR);
}
```

Actualizar `package.json`:
```json
"scripts": {
  "postinstall": "node scripts/postinstall.mjs",
  "postinstall:warp": "PI_FREE_BRIDGE_WARP=true node scripts/postinstall.mjs"
}
```

---

## Archivos clave (referencia rápida)

| Repo | Archivo | Qué toca |
|------|---------|----------|
| warp-minimal | `internal/warp/register.go` | Registro Cloudflare |
| warp-minimal | `internal/warp/tunnel.go` | WireGuard + gVisor |
| warp-minimal | `internal/warp/proxy.go` | uTLS + HTTP proxy |
| bridge-go | `internal/egress/coordinator.go` | Fallback a warp_proxy |
| bridge-go | `cmd/bridge-go/main.go` | Config warp_proxy |
| pi-free-bridge | `scripts/postinstall.mjs` | Descarga warp-minimal opcional |
| pi-free-bridge | `index.ts` | Doctor muestra warp-minimal status |

---

## Notas técnicas importantes

### Cloudflare WARP Registration
- Endpoint: `https://api.cloudflareclient.com/v0a2158/reg`
- Versión cliente: `6.23` (actualizable)
- Clave pública Cloudflare: `bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=`
- Key derivation: HKDF-ChaCha20Poly1305(salt="cloudflare warp", info="wireguard")

### uTLS Bun ClientHello (JA4 t13d1713h1)
```go
&utls.ClientHelloSpec{
    TLSVersMin: utls.VersionTLS12, TLSVersMax: utls.VersionTLS13,
    CipherSuites: [17 suites: AES128-GCM, AES256-GCM, CHACHA20, ECDHE-ECDSA, ECDHE-RSA, RSA],
    Extensions: SNI, EMS, Renegotiation, Curves(X25519MLKEM768, X25519, P256, P384),
                Points, SessionTicket, ALPN(http/1.1), StatusRequest,
                SigAlgs(ECDSA+P256, PSS, PKCS1, ECDSA+P384, PSS, PKCS1)
}
```

### Red
- **UDP 2408 salida** obligatorio (registro + keepalive WARP)
- Si bloqueado → pool vacío → `/health` = `healthy: 0` → fallback a local/proxies

---

## Comandos útiles próximo inicio

```bash
# warp-minimal
cd /c/Users/Polanco/warp-minimal
go build -o warp-minimal.exe ./cmd/warp-minimal
./warp-minimal.exe -config config.json

# bridge-go
cd /c/Users/Polanco/pi-free-bridge/bridge-go
go build -o bridge-go.exe ./cmd/bridge-go
./bridge-go.exe -config config.json

# pi-free-bridge tests
cd /c/Users/Polanco/pi-free-bridge
npm run test  # 38/38 pass

# Git status
cd /c/Users/Polanco/pi-free-bridge && git status
cd /c/Users/Polanco/warp-minimal && git status
```

---

## Branch actual
- **pi-free-bridge**: `invest/bun-comparison` (commit `dcdd8dd` + `a916e54` + `c0ed5d5`)
- **warp-minimal**: `main` (tag `v0.1.0` publicado)

---

## Próxima sesión: empezar por `warp-minimal/internal/warp/register.go`

> Objetivo: `curl -x http://127.0.0.1:8789 https://httpbin.org/ip` devuelve IPv6 de Cloudflare (2a09:bac5:...)