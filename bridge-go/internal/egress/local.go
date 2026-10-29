package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/Deury08/pi-free-bridge/bridge-go/internal/httpx"
)

// LocalConfig configures the local IP egress.
type LocalConfig struct {
	CooldownDuration time.Duration
	DialTimeout      time.Duration
	ResponseTimeout  time.Duration
}

// LocalEgress handles requests via local IP with cooldown tracking.
type LocalEgress struct {
	mu         sync.Mutex
	cooldowns  map[string]time.Time // IP -> cooldown until
	config     LocalConfig
	transport  *http.Transport
	bunTransport *httpx.BunTransport
}

func NewLocalEgress(cfg LocalConfig) (*LocalEgress, error) {
	if cfg.CooldownDuration == 0 {
		cfg.CooldownDuration = 30 * time.Minute
	}
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 10 * time.Second
	}
	if cfg.ResponseTimeout == 0 {
		cfg.ResponseTimeout = 30 * time.Second
	}

	// Regular HTTP transport for local IP (used for non-gate requests or fallback)
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   cfg.DialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   256,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   cfg.DialTimeout,
		ResponseHeaderTimeout: cfg.ResponseTimeout,
		ExpectContinueTimeout: 1 * time.Second,
	}

	// Bun transport for gate requests (uTLS with Bun fingerprint)
	bunTrans, err := httpx.NewBunTransport(httpx.BunTransportOptions{
		ConnectTimeout:        cfg.DialTimeout,
		ResponseHeaderTimeout: cfg.ResponseTimeout,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   256,
	})
	if err != nil {
		return nil, fmt.Errorf("create BunTransport: %w", err)
	}

	return &LocalEgress{
		cooldowns:     make(map[string]time.Time),
		config:        cfg,
		transport:     transport,
		bunTransport:  bunTrans,
	}, nil
}

// IsCooledDown checks if local IP is in cooldown.
func (e *LocalEgress) IsCooledDown() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if until, ok := e.cooldowns["local"]; ok {
		if time.Now().Before(until) {
			return true
		}
		delete(e.cooldowns, "local")
	}
	return false
}

// SetCooldown marks local IP as cooled down.
func (e *LocalEgress) SetCooldown() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cooldowns["local"] = time.Now().Add(e.config.CooldownDuration)
}

// ClearCooldown removes local IP cooldown.
func (e *LocalEgress) ClearCooldown() {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.cooldowns, "local")
}

// RoundTrip executes request via local IP.
// Returns (response, error, isNetworkError, isUpstream503).
func (e *LocalEgress) RoundTrip(ctx context.Context, req *http.Request, useBunFingerprint bool) (*http.Response, error, bool, bool) {
	// Check cooldown
	if e.IsCooledDown() {
		return nil, fmt.Errorf("local IP in cooldown"), false, false
	}

	var tr http.RoundTripper = e.transport
	if useBunFingerprint {
		tr = e.bunTransport
	}

	var isUpstream503 bool
	client := &http.Client{Transport: tr}

	resp, err := client.Do(req.WithContext(ctx))
	if err != nil {
		// Classify network error vs upstream
		var netErr net.Error
		if errors.As(err, &netErr) {
			// If it's a timeout or temporary network error, treat as firewall/local issue
			if netErr.Timeout() || netErr.Temporary() {
				return nil, err, true, false
			}
		}
		// Other errors (TLS, etc.) also treated as network/local
		return nil, err, true, false
	}

	// Check for upstream 503 (with body from upstream)
	if resp.StatusCode == http.StatusServiceUnavailable {
		isUpstream503 = true
	}

	// If we got 429 rate limit, trigger cooldown
	if resp.StatusCode == http.StatusTooManyRequests {
		e.SetCooldown()
	}

	return resp, nil, false, isUpstream503
}

func (e *LocalEgress) Close() {
	e.transport.CloseIdleConnections()
	e.bunTransport.CloseIdleConnections()
}
