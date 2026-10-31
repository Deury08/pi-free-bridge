// Temporary diagnostic harness: reproduces chatCompletionsHandler's upstream
// call step by step and prints the raw error verbatim (the shipped handler
// maps every 502 to a generic message, hiding the real cause).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/Deury08/pi-free-bridge/bridge-go/internal/gate"
	"github.com/Deury08/pi-free-bridge/bridge-go/internal/httpx"
	utls "github.com/refraction-networking/utls"
)

// runBunExact sends the same full gated request, but dials via uTLS with the
// exact captured Bun 1.3.12 ClientHello (bun_exact.go). Body shape is IDENTICAL
// to runPlain's; only the TLS layer changes.
func runBunExact() error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	seed, err := gate.HarvestSessionID()
	fmt.Printf("harvested session: %q (err=%v)\n", seed, err)
	if seed == "" {
		return fmt.Errorf("no session id available")
	}

	bodyBytes, err := relayShapedBody()
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://opencode.ai/inference/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("x-opencode-session", seed)
	req.Header.Set("x-opencode-session-id", seed)
	req.Header.Set("Authorization", "Bearer public")
	req.Header.Set("User-Agent", "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")

	// Transport that dials via uTLS with the exact Bun ClientHello.
	client := &http.Client{
		Transport: &http.Transport{
			DialTLSContext: func(_ context.Context, _, addr string) (net.Conn, error) {
				return dialBunExact(addr)
			},
			ForceAttemptHTTP2: false,
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	fmt.Printf("RESPONSE PROTO: %s\n", resp.Proto)
	fmt.Printf("STATUS: %s\n", resp.Status)
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	fmt.Printf("BODY: %s\n", string(respBody))
	return nil
}

// runBT sends the same full gated request through the PRODUCTION transport
// (httpx.NewBunTransport) to verify the internal BunTransport fix.
func runBT() error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	seed, err := gate.HarvestSessionID()
	fmt.Printf("harvested session: %q (err=%v)\n", seed, err)
	if seed == "" {
		return fmt.Errorf("no session id available")
	}

	bodyBytes, err := relayShapedBody()
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://opencode.ai/inference/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("x-opencode-session", seed)
	req.Header.Set("x-opencode-session-id", seed)
	req.Header.Set("Authorization", "Bearer public")
	req.Header.Set("User-Agent", "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")

	transport, err := httpx.NewBunTransport(httpx.BunTransportOptions{})
	if err != nil {
		return fmt.Errorf("NewBunTransport: %w", err)
	}
	client := &http.Client{Transport: transport}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("roundtrip: %w", err)
	}
	defer resp.Body.Close()
	fmt.Printf("RESPONSE PROTO: %s\n", resp.Proto)
	fmt.Printf("STATUS: %s\n", resp.Status)
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	fmt.Printf("BODY: %s\n", string(respBody))
	return nil
}

func main() {
	mode := "plain"
	if len(os.Args) >= 3 && os.Args[1] == "--mode" {
		mode = os.Args[2]
	}
	switch mode {
	case "bun":
		if err := runBunExact(); err != nil {
			fmt.Fprintf(os.Stderr, "harness: %v\n", err)
			os.Exit(1)
		}
	case "bt":
		if err := runBT(); err != nil {
			fmt.Fprintf(os.Stderr, "harness: %v\n", err)
			os.Exit(1)
		}
	case "self":
		// Dump our own synthesized ClientHello via the local capture server.
		_, _ = dialBunExact("127.0.0.1:9443")
		fmt.Println("hello sent (capture server should have saved it)")
	case "selfbt":
		// Dump the PRODUCTION BunTransport hello the same way: replicate the
		// exact construction used by (t *BunTransport).dialTLS.
		conn, derr := net.Dial("tcp", "127.0.0.1:9443")
		if derr != nil {
			fmt.Println("dial:", derr)
			os.Exit(1)
		}
		defer conn.Close()
		uconn := utls.UClient(conn, httpx.BunTLSConfig("127.0.0.1"), utls.HelloCustom)
		if err := uconn.ApplyPreset(httpx.BunClientHelloSpec()); err != nil {
			fmt.Println("ApplyPreset:", err)
			os.Exit(1)
		}
		_ = uconn.Handshake()
		fmt.Println("production hello sent (capture server should have saved it)")
	default:
		if err := runPlain(); err != nil {
			fmt.Fprintf(os.Stderr, "harness: %v\n", err)
			os.Exit(1)
		}
	}
}

// relayShapedBody builds the EXACT relay.mjs wire body:
// - <env> block appended to the system message (2-space indent + Platform)
// - nested OpenAI tool declarations, tool_choice pinned to "none"
// - stream: true
func relayShapedBody() ([]byte, error) {
	envBlock := fmt.Sprintf("<env>\n  Working directory: %s\n  Platform: %s\n</env>",
		"C:/Users/Polanco/pi-free-bridge", "win32")

	body := map[string]any{
		"model": "deepseek-v4.1-flash-free",
		"messages": []any{
			map[string]any{"role": "system", "content": envBlock},
			map[string]any{"role": "user", "content": "Reply with exactly: OK"},
		},
		"tools": []any{
			map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        "read",
					"description": "read (injected by pi-free-bridge for the OpenCode free-tier gate)",
					"parameters": map[string]any{
						"type":       "object",
						"properties": map[string]any{},
					},
				},
			},
			map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        "bash",
					"description": "bash (injected by pi-free-bridge for the OpenCode free-tier gate)",
					"parameters": map[string]any{
						"type":       "object",
						"properties": map[string]any{},
					},
				},
			},
		},
		"tool_choice": "none",
		"stream":      true,
	}
	return json.Marshal(body)
}

// runPlain is the decisive test: full gated chat request over STANDARD Go TLS
// (http.DefaultTransport) with session headers and gate tools injected. If the
// upstream accepts this, the Bun uTLS fingerprint is not required.
func runPlain() error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	seed, err := gate.HarvestSessionID()
	fmt.Printf("harvested session: %q (err=%v)\n", seed, err)
	if seed == "" {
		return fmt.Errorf("no session id available")
	}

	bodyBytes, err := relayShapedBody()
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://opencode.ai/inference/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("x-opencode-session", seed)
	req.Header.Set("x-opencode-session-id", seed)
	req.Header.Set("Authorization", "Bearer public")
	req.Header.Set("User-Agent", "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{} // STANDARD transport
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	fmt.Printf("STATUS: %s\n", resp.Status)
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	fmt.Printf("BODY: %s\n", string(respBody))
	return nil
}
