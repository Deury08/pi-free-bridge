package httpx

import (
	"encoding/hex"
	"net"
	"time"

	utls "github.com/refraction-networking/utls"
)

// echCarrierData is the raw payload of Bun's extension 0xfe0d (ECH draft
// carrier, draft-ietf-tls-esni-17), captured from the real Bun 1.3.12 runtime
// against a local TLS listener (byte-verified, 218 bytes; see
// cmd/debug-roundtrip/bun_exact.go for the capture recipe).
const echCarrierData = "000001000178002076329f59a656f605c32a4cee25abc400b63358ef46c92a8604a97c3f464c587c00b0ca852c958adb915c04880566b39ee90f157179577e4c34c62ef4658460a15d4db4e6e80d88ad3f262f778df035f4428170c43b24ce44e701e53a0170d36da63c0d643412a680bac09443557556a8366b07f5141d30fb98b450a544e7950e3ab94de52a0f8d33d806cca2a5e2832b2319d5176e060f4b24635f58d92ae1e49bfde22c66dd19735d3e7190dd22bd2c1b432fdd94458db36db18ca9d6daa3eb45aa80fe8acca2cea736adbb3f071a724c7c"

// BunClientHelloSpec returns a uTLS ClientHelloSpec that matches the REAL
// Bun 1.3.12 ClientHello byte-for-byte (cipher order, extension order,
// payloads), differing only in random, session_id, and SNI — all of which utls
// manages. The OpenCode free-tier gate rejects requests whose ClientHello does
// not match Bun's fingerprint with a 429 that mimics a quota error.
func BunClientHelloSpec() *utls.ClientHelloSpec {
	echData, _ := hex.DecodeString(echCarrierData)
	return &utls.ClientHelloSpec{
		// NOTE: TLSVersMin/TLSVersMax deliberately unset — the wire-verified
		// capture leaves the legacy version handling to utls.
		// Cipher suites, exact capture order (17).
		CipherSuites: []uint16{
			utls.TLS_AES_128_GCM_SHA256,
			utls.TLS_AES_256_GCM_SHA384,
			utls.TLS_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			0xcca9, 0xcca8, // ECDHE CHACHA20_POLY1305
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []uint8{0},
		Extensions: []utls.TLSExtension{
			// SNI first — BoringSSL's internet-hello order.
			&utls.SNIExtension{},
			// 0xfe0d: opaque replay of Bun's ECH-carrier bytes (218).
			&utls.GenericExtension{Id: 0xfe0d, Data: echData},
			&utls.ExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SupportedCurvesExtension{ // 0x000a: x25519, p256, p384
				Curves: []utls.CurveID{utls.X25519, utls.CurveP256, utls.CurveP384},
			},
			&utls.SupportedPointsExtension{SupportedPoints: []uint8{0}}, // 0x000b
			&utls.SessionTicketExtension{},                              // 0x0023 (empty)
			&utls.ALPNExtension{ // 0x0010
				AlpnProtocols: []string{"http/1.1"},
			},
			&utls.StatusRequestExtension{}, // 0x0005
			&utls.SignatureAlgorithmsExtension{ // 0x000d: 9 algs, exact order
				SupportedSignatureAlgorithms: []utls.SignatureScheme{
					0x0403, 0x0804, 0x0401, 0x0503,
					0x0805, 0x0501, 0x0806, 0x0601, 0x0201,
				},
			},
			&utls.SCTExtension{}, // 0x0012
			&utls.KeyShareExtension{ // 0x0033: x25519, auto-generated
				KeyShares: []utls.KeyShare{{Group: utls.X25519}},
			},
			&utls.PSKKeyExchangeModesExtension{ // 0x002d
				Modes: []uint8{1},
			},
			&utls.SupportedVersionsExtension{ // 0x002b
				Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12},
			},
			&utls.GenericExtension{Id: 0x0015, Data: make([]byte, 35)}, // padding
		},
	}
}

// BunDialer creates a net.Dialer with Bun-like TCP keepalive settings.
func BunDialer() *net.Dialer {
	return &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
}

// BunTLSConfig returns a uTLS Config pre-configured for Bun-like behavior.
// NextProtos is intentionally NOT set: the ALPN http/1.1 comes from the
// extension in the spec, and a config value makes uTLS emit a duplicate ALPN
// extension, which servers reject with a decode error.
func BunTLSConfig(serverName string) *utls.Config {
	return &utls.Config{
		ServerName:         serverName,
		ClientSessionCache: nil, // utls doesn't share session cache type with crypto/tls
	}
}
