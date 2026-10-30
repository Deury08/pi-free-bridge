# Feature: WARP real implementation + bridge-go integration

Branch: `invest/bun-comparison` (pi-free-bridge) + `warp-minimal` repo (`/c/Users/Polanco/warp-minimal`)
Goal: `curl -x http://127.0.0.1:8789 https://httpbin.org/ip` returns a Cloudflare WARP IPv6 (2a09:bac5:...)

## Specs

S1 (warp-minimal `internal/warp/register.go`): "Generar X25519 key pair (ecdh.X25519())", "POST https://api.cloudflareclient.com/v0a2158/reg", Body: `{ key: base64(pub), install_id: "", fcm_token: "", model: "PC", serial_number: <16 hex>, locale: "en_US", warp_enabled: true, type: "windows", app_version: "6.23", os_version: "10.0.19045" }`, Headers: `Content-Type: application/json, User-Agent: okhttp/4.9.3, Cf-Client-Version: 6.23`, "Parse response → WireGuardConfig", "HKDF-ChaCha20Poly1305 key derivation (shared secret + salt 'cloudflare warp' + info 'wireguard')", Return `WireGuardConfig{PrivateKey, PeerPublicKey, Endpoint, ClientIPv6, Reserved}`.

S2 (warp-minimal `internal/warp/tunnel.go`): "Usar golang.zx2c4.com/wireguard/device", "gvisor.dev/gvisor/pkg/tcpip/stack + netstack", `device.NewDevice(tun, bind, logger)` — tun = netstack.CreateNetTUN(), `dev.SetConfiguration(\`private_key=...\`)`, `dialer = &net.Dialer{Control: network.ControlFunc()}`, `dev.Up()`, `DialContext usa dialer.DialContext()`.

S3 (warp-minimal `internal/warp/proxy.go`): "Acquire exit from pool", `exit.DialContext(ctx, "tcp", host:port) → net.Conn`, "Si HTTPS: utls.UClient(conn, &utls.Config{ServerName, NextProtos: ["http/1.1"]}, utls.HelloCustom)", `tlsConn.ApplyPreset(bunClientHelloSpec())` // JA4 t13d1713h1, `tlsConn.HandshakeContext(ctx)`, `r.Write(conn) / http.ReadResponse()`, "Release exit on response close".

S4 (bridge-go `internal/egress/coordinator.go`): "En RoundTrip(), fase WARP: if c.config.WarpProxy != '' && !c.local.IsCooledDown() { Forward a warp-minimal }".

S5 (bridge-go `cmd/bridge-go/main.go`): config JSON `{ "warp_enabled": true, "warp_proxy": "http://127.0.0.1:8789" }`.

S6 (pi-free-bridge `scripts/postinstall.mjs`): "Si process.env.PI_FREE_BRIDGE_WARP === 'true' o flag --warp", download binary "warp-minimal", `package.json` scripts `postinstall` and `postinstall:warp`.

S7 E2E: warp-minimal :8789 + bridge-go :8788 + Pi/curl → `200` con respuesta del modelo.

## Tasks

T1: Implement register.go — Cloudflare WARP registration + HKDF key derivation (S1). Commit: feat(warp-minimal): implement Cloudflare WARP device registration
T2: Implement tunnel.go — WireGuard userspace tunnel via gVisor netstack (S2). Commit: feat(warp-minimal): implement userspace WireGuard tunnel
T3: Implement proxy.go — uTLS Bun HTTP proxy over WARP exits (S3). Commit: feat(warp-minimal): implement uTLS HTTP proxy
T4: Connect warp_proxy in bridge-go coordinator + config (S4, S5). Commit: feat(bridge-go): route WARP phase through warp-minimal proxy
T5: Optional WARP binary download in postinstall + package.json scripts (S6). Commit: feat(pi-free-bridge): optional WARP binary download on postinstall
T6: E2E test warp-minimal + bridge-go + Pi (S7). Commit: test: end-to-end WARP proxy chain

## Log

L1: CONTINUACION.md — Implementar WARP real en warp-minimal + conectar bridge-go + test E2E (next session: empezar por warp-minimal/internal/warp/register.go)
