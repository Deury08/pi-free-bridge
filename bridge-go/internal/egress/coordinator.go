package egress

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// CoordinatorConfig configures the egress fallback chain.
type CoordinatorConfig struct {
	Strategy       string        // "local_warp_local" (only supported strategy)
	LocalCooldown  time.Duration
	MaxAttempts    int
	LocalConfig    LocalConfig
	WarpConfig     WarpConfig
	WarpProxy      string        // URL of warp-minimal HTTP proxy (e.g. "http://127.0.0.1:8789")
}

// Coordinator manages the fallback chain: Local -> WARP -> Local (with backoff).
type Coordinator struct {
	mu       sync.Mutex
	config   CoordinatorConfig
	local    *LocalEgress
	warp     *WarpEgress
	attempts int
}

func NewCoordinator(cfg CoordinatorConfig) (*Coordinator, error) {
	if cfg.Strategy == "" {
		cfg.Strategy = "local_warp_local"
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 6
	}
	if cfg.LocalConfig.CooldownDuration == 0 {
		cfg.LocalConfig.CooldownDuration = 30 * time.Minute
	}

	local, err := NewLocalEgress(cfg.LocalConfig)
	if err != nil {
		return nil, fmt.Errorf("create local egress: %w", err)
	}

	warp, err := NewWarpEgress(cfg.WarpConfig)
	if err != nil {
		return nil, fmt.Errorf("create warp egress: %w", err)
	}

	return &Coordinator{
		config: cfg,
		local:  local,
		warp:   warp,
	}, nil
}

// RoundTrip executes the full fallback chain.
// Returns (response, error, egressUsed).
func (c *Coordinator) RoundTrip(ctx context.Context, req *http.Request) (*http.Response, error, string) {
	if c.config.Strategy != "local_warp_local" {
		return nil, fmt.Errorf("unsupported strategy: %s", c.config.Strategy), ""
	}

	var lastResp *http.Response
	var lastErr error
	attempts := 0

	// Phase 1: Local IP (with Bun fingerprint for gate)
	for attempts < c.config.MaxAttempts {
		if c.local.IsCooledDown() {
			break
		}
		resp, err, isNetErr, isUpstream503 := c.local.RoundTrip(ctx, req, true)
		attempts++

		if err == nil && resp != nil {
			// Success
			c.attempts = attempts
			return resp, nil, "local"
		}

		lastResp, lastErr = resp, err

		// If network error (firewall/local), don't count against local cooldown - go to WARP
		if isNetErr {
			break
		}

		// If upstream 503, could be real upstream issue - go to WARP
		if isUpstream503 {
			break
		}

		// If 429, local cooldown was set in RoundTrip - go to WARP
		if resp != nil && resp.StatusCode == http.StatusTooManyRequests {
			break
		}

		// Other errors - retry local
		continue
	}

	// Phase 2: WARP pool via warp-minimal HTTP proxy
	if c.config.WarpProxy != "" && !c.local.IsCooledDown() {
		warpProxyURL, err := url.Parse(c.config.WarpProxy)
		if err == nil {
			attempts++
			resp, err := c.roundTripViaWarpProxy(ctx, req, warpProxyURL)
			if err == nil && resp != nil {
				c.attempts = attempts
				return resp, nil, "warp"
			}
			lastResp, lastErr = resp, err
		}
	}

	// Phase 3: Local IP with backoff (respecting cooldown)
	for attempts < c.config.MaxAttempts {
		if c.local.IsCooledDown() {
			// Wait for cooldown or break
			waitTime := time.Until(c.local.getCooldownUntil())
			if waitTime > 0 && waitTime < 5*time.Minute {
				select {
				case <-ctx.Done():
					return lastResp, ctx.Err(), "local"
				case <-time.After(waitTime):
					// Cooldown expired, try again
				}
			} else {
				break
			}
		}

		resp, err, isNetErr, isUpstream503 := c.local.RoundTrip(ctx, req, true)
		attempts++

		if err == nil && resp != nil {
			c.attempts = attempts
			return resp, nil, "local-backoff"
		}

		lastResp, lastErr = resp, err

		if isNetErr || isUpstream503 {
			break
		}
		if resp != nil && resp.StatusCode == http.StatusTooManyRequests {
			break
		}
	}

	c.attempts = attempts
	if lastResp != nil {
		return lastResp, nil, "local-exhausted"
	}
	return nil, lastErr, "failed"
}

// roundTripViaWarpProxy forwards the request through the warp-minimal HTTP proxy.
func (c *Coordinator) roundTripViaWarpProxy(ctx context.Context, req *http.Request, proxyURL *url.URL) (*http.Response, error) {
	transport := &http.Transport{
		Proxy:           http.ProxyURL(proxyURL),
		DialContext:     (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		ForceAttemptHTTP2: false,
		IdleConnTimeout: 90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}

	// Rewrite the request to go through the proxy: keep the target URL as-is,
	// the transport's Proxy will route it through warp-minimal.
	outReq := req.Clone(ctx)
	outReq.Host = req.URL.Host

	return client.Do(outReq)
}

// getCooldownUntil is a helper to check cooldown expiry (for coordinator).
func (e *LocalEgress) getCooldownUntil() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	if until, ok := e.cooldowns["local"]; ok {
		return until
	}
	return time.Time{}
}

// GetAttempts returns the number of attempts made in the last request.
func (c *Coordinator) GetAttempts() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attempts
}

// Close cleans up all egresses.
func (c *Coordinator) Close() {
	c.local.Close()
	c.warp.Close()
}

// HealthStatus returns health info for /health endpoint.
func (c *Coordinator) HealthStatus() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]any{
		"local_cooldown":    c.local.IsCooledDown(),
		"warp_enabled":      c.warp.config.Enabled,
		"warp_available":    c.warp.IsAvailable(),
		"warp_proxy":        c.config.WarpProxy,
		"strategy":          c.config.Strategy,
		"max_attempts":      c.config.MaxAttempts,
		"last_attempts":     c.attempts,
	}
}
