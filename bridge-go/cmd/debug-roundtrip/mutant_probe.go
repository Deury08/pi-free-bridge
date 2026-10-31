// Temporary diagnostic harness #5: take the WORKING Chrome_Auto spec and mutate
// ONE property at a time toward the Bun spec to find which deviation breaks the
// handshake. All runs go against a LOCAL Go TLS 1.3 server (offline, fast).
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"net"
	"time"

	utls "github.com/refraction-networking/utls"

	"github.com/Deury08/pi-free-bridge/bridge-go/internal/httpx"
)

func tlsCfg() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: certSelf2()}
}

func mutantProbe() {
	ln, err := net.Listen("tcp", "127.0.0.1:18444")
	if err != nil {
		fmt.Println("listen err:", err)
		return
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				s := tls.Server(conn, tlsCfg())
				s.SetDeadline(time.Now().Add(3 * time.Second))
				_ = s.Handshake()
			}(c)
		}
	}()

	time.Sleep(200 * time.Millisecond)

	try := func(label string, spec *utls.ClientHelloSpec) {
		conn, err := net.Dial("tcp", "127.0.0.1:18444")
		if err != nil {
			fmt.Printf("%-46s dial err: %v\n", label, err)
			return
		}
		cfg := &utls.Config{ServerName: "localhost", InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}}
		uconn := utls.UClient(conn, cfg, utls.HelloCustom)
		if err := uconn.ApplyPreset(spec); err != nil {
			fmt.Printf("%-46s preset err: %v\n", label, err)
			conn.Close()
			return
		}
		if err := uconn.Handshake(); err != nil {
			fmt.Printf("%-46s FAIL: %v\n", label, err)
			return
		}
		fmt.Printf("%-46s OK\n", label)
	}

	base, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		fmt.Println("idtospec err:", err)
		return
	}
	bun := httpx.BunClientHelloSpec()
	try("chrome base (control)", &base)

	// 1. only ALPN changed to Bun's [http/1.1] (chrome's has no ALPN list? check)
	c1 := base
	for _, e := range c1.Extensions {
		if alpn, ok := e.(*utls.ALPNExtension); ok {
			alpn.AlpnProtocols = []string{"http/1.1"}
		}
	}
	try("chrome + ALPN=http/1.1", &c1)

	// 2. only curves changed to Bun's
	c2 := base
	for _, e := range c2.Extensions {
		if sc, ok := e.(*utls.SupportedCurvesExtension); ok {
			sc.Curves = []utls.CurveID{utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveP384}
		}
	}
	try("chrome + curves[MLKEM768,X25519,P256,P384]", &c2)

	// 3. only cipher list changed to Bun's
	c3 := base
	c3.CipherSuites = bun.CipherSuites
	c3.TLSVersMin = utls.VersionTLS12
	c3.TLSVersMax = utls.VersionTLS13
	try("chrome + Bun ciphers", &c3)

	// 4. only TLSVersMin=TLS12 (chrome may already be 13-only)
	c4 := base
	c4.TLSVersMin = utls.VersionTLS12
	try("chrome + TLSVersMin=TLS12", &c4)

	// 5. key shares replaced by Bun's pair
	c5 := base
	for _, e := range c5.Extensions {
		if ks, ok := e.(*utls.KeyShareExtension); ok {
			ks.KeyShares = []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}
		}
	}
	try("chrome + keyshares[MLKEM768,X25519]", &c5)

	// 6. signature algorithms replaced by Bun's
	c6 := base
	for _, e := range c6.Extensions {
		if sa, ok := e.(*utls.SignatureAlgorithmsExtension); ok {
			sa.SupportedSignatureAlgorithms = []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256, utls.PSSWithSHA256, utls.PKCS1WithSHA256,
				utls.PSSWithSHA384, utls.PKCS1WithSHA384,
			}
		}
	}
	try("chrome + Bun sigalgs", &c6)

	// 7. full original failing spec (control)
	try("bun original (control)", bun)
}

func certSelf2() []tls.Certificate {
	priv := mustGen2()
	return []tls.Certificate{{Certificate: mustCert2(priv), PrivateKey: priv}}
}

func mustGen2() *ecdsa.PrivateKey {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	return key
}

func mustCert2(priv *ecdsa.PrivateKey) [][]byte {
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		DNSNames:     []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		panic(err)
	}
	return [][]byte{der}
}
