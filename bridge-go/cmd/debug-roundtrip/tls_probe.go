// Temporary diagnostic harness #2: isolates WHERE the TLS handshake fails by
// comparing fingerprints and endpoints. Uses utls v1.8.2 API (UClient/UConn).
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"

	utls "github.com/refraction-networking/utls"

	"github.com/Deury08/pi-free-bridge/bridge-go/internal/httpx"
)

func idPtr(id utls.ClientHelloID) *utls.ClientHelloID { return &id }

// probeAll compares TLS handshake outcomes across endpoints and fingerprints.
func probeAll() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dialer := &net.Dialer{Timeout: 10 * time.Second}

	// Bun spec + the two missing extensions: key share for the offered curves
	// and the supported_versions extension announcing TLS 1.3.
	bunSpecKv := httpx.BunClientHelloSpec()
	bunSpecKv.Extensions = append(bunSpecKv.Extensions,
		&utls.KeyShareExtension{KeyShares: []utls.KeyShare{
			{Group: utls.X25519MLKEM768},
			{Group: utls.X25519},
		}},
	)
	bunSpecSv := httpx.BunClientHelloSpec()
	bunSpecSv.Extensions = append(bunSpecSv.Extensions,
		&utls.SupportedVersionsExtension{},
	)
	bunSpecFixed := httpx.BunClientHelloSpec()
	bunSpecFixed.Extensions = append(bunSpecFixed.Extensions,
		&utls.SupportedVersionsExtension{},
		&utls.KeyShareExtension{KeyShares: []utls.KeyShare{
			{Group: utls.X25519MLKEM768},
			{Group: utls.X25519},
		}},
	)

	type row struct {
		label string
		host  string
		spec  *utls.ClientHelloSpec
		plain bool // true = standard crypto/tls HTTP probe
		auto  *utls.ClientHelloID
	}

	rows := []row{
		{label: "opencode.ai  Bun spec +KV", host: "opencode.ai", spec: bunSpecKv},
		{label: "opencode.ai  Bun spec +SV", host: "opencode.ai", spec: bunSpecSv},
		{label: "opencode.ai  Bun spec +KV+SV", host: "opencode.ai", spec: bunSpecFixed},
	}

	// Built-in utls fingerprints (well-generated, widely used) â€” if these also
	// fail, the problem is a middlebox, not our spec construction.
	rows = append(rows,
		row{label: "opencode.ai  HelloChrome_Auto", host: "opencode.ai", auto: idPtr(utls.HelloChrome_Auto)},
		row{label: "opencode.ai  HelloFirefox_Auto", host: "opencode.ai", auto: idPtr(utls.HelloFirefox_Auto)},
		row{label: "opencode.ai  HelloRandomized", host: "opencode.ai", auto: idPtr(utls.HelloRandomizedALPN)},
		row{label: "api.github.com HelloChrome_Auto", host: "api.github.com", auto: idPtr(utls.HelloChrome_Auto)},
		row{label: "www.google.com HelloChrome_Auto", host: "www.google.com", auto: idPtr(utls.HelloChrome_Auto)},
		row{label: "www.apple.com HelloChrome_Auto", host: "www.apple.com", auto: idPtr(utls.HelloChrome_Auto)},
	)

	for _, r := range rows {
		if r.plain {
			start := time.Now()
			code, err := plainGet(r.host)
			if err != nil {
				fmt.Printf("%-40s STD-ERR (%s): %v\n", r.label, time.Since(start).Round(time.Millisecond), err)
				continue
			}
			fmt.Printf("%-40s STD-OK (%s) -> %s\n", r.label, time.Since(start).Round(time.Millisecond), code)
			continue
		}

		name := r.label
		tcpConn, err := dialer.DialContext(ctx, "tcp", r.host+":443")
		if err != nil {
			fmt.Printf("%-40s DIAL-ERR: %v\n", name, err)
			continue
		}
		cfg := &utls.Config{ServerName: r.host, NextProtos: []string{"h2", "http/1.1"}}
		var uconn *utls.UConn
		start := time.Now()
		if r.spec != nil && r.auto == nil {
			uconn = utls.UClient(tcpConn, cfg, utls.HelloCustom)
			if err := uconn.ApplyPreset(r.spec); err != nil {
				fmt.Printf("%-40s PRESET-ERR: %v\n", name, err)
				tcpConn.Close()
				continue
			}
		} else {
			helloID := *r.auto
			uconn = utls.UClient(tcpConn, cfg, helloID)
		}
		if err := uconn.HandshakeContext(ctx); err != nil {
			fmt.Printf("%-40s TLS-ERR (%s): %v\n", name, time.Since(start).Round(time.Millisecond), err)
			tcpConn.Close()
			continue
		}
		fmt.Printf("%-40s OK (%s) alpn=%q\n", name, time.Since(start).Round(time.Millisecond), uconn.ConnectionState().NegotiatedProtocol)
		uconn.Close()
	}
}

// plainGet performs a standard crypto/tls HTTPS HEAD through Go's default
// transport (no uTLS) to confirm plain TLS works from Go itself.
func plainGet(host string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, "https://"+host, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	return resp.Status, nil
}