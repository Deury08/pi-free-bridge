package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// Replicates oc2cpa upstream.go transport exactly: http.DefaultTransport clone, no TLS tweaks.
func main() {
	body, _ := os.ReadFile("body.json")
	req, _ := http.NewRequest(http.MethodPost, "https://opencode.ai/inference/v1/chat/completions", bytes.NewReader(body))
	for k, v := range map[string]string{
		"Accept":                "text/event-stream",
		"Content-Type":          "application/json",
		"Authorization":         "Bearer public",
		"User-Agent":            "opencode/latest/2.0.29/cli",
		"x-opencode-client":     "cli",
		"x-opencode-project":    "global",
		"x-opencode-session":    os.Args[1],
		"x-opencode-session-id": os.Args[1],
		"x-session-affinity":    os.Args[1],
		"X-Session-Id":          os.Args[1],
	} {
		req.Header.Set(k, v)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 30 * time.Second
	tr.TLSHandshakeTimeout = 30 * time.Second
	client := &http.Client{Transport: tr}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("GO transport: ERROR", err)
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
	fmt.Printf("GO transport: HTTP %d\n%s\n", resp.StatusCode, b)
}
