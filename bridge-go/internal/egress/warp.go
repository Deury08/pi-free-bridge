package egress

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"
)

// WarpConfig configures the WARP egress (optional).
type WarpConfig struct {
	Enabled    bool
	PoolSize   int
	Stack      string // "ipv4" or "ipv6"
	SourceIPv6 string
}

// WarpEgress provides WARP exit rotation for free-tier requests.
// NOTE: Full implementation requires GPL-3.0 components from opencode2api
// (golang.zx2c4.com/wireguard + gvisor.dev/gvisor). This stub provides
// the interface for when those components are available.
// When disabled or unavailable, returns ErrWarpUnavailable.
type WarpEgress struct {
	mu       sync.Mutex
	config   WarpConfig
	pool     []*WarpExit
	healthy  int
}

// WarpExit represents a single WARP tunnel exit.
type WarpExit struct {
	EgressIP string
	Cooldown time.Time
	InUse    bool
}

// ErrWarpUnavailable indicates WARP is not available (disabled, pool empty, or registration failed).
var ErrWarpUnavailable = errors.New("WARP egress unavailable")

// NewWarpEgress creates a WARP egress. If disabled, returns a stub that always returns ErrWarpUnavailable.
func NewWarpEgress(cfg WarpConfig) (*WarpEgress, error) {
	if !cfg.Enabled {
		return &WarpEgress{config: cfg}, nil
	}
	if cfg.PoolSize <= 0 {
		cfg.PoolSize = 2
	}
	// TODO: Implement actual WARP registration using wireguard-go + gVisor netstack
	// This requires GPL-3.0 dependencies. For now, return stub.
	return &WarpEgress{config: cfg}, nil
}

// Acquire attempts to get a healthy WARP exit.
func (w *WarpEgress) Acquire(ctx context.Context) (*WarpExit, error) {
	if !w.config.Enabled {
		return nil, ErrWarpUnavailable
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	// TODO: Implement actual pool management with registration
	return nil, ErrWarpUnavailable
}

// Release returns an exit to the pool.
func (w *WarpEgress) Release(exit *WarpExit) {
	if exit == nil || !w.config.Enabled {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	exit.InUse = false
}

// Fail marks an exit as failed (cooldown).
func (w *WarpEgress) Fail(exit *WarpExit, reason string) {
	if exit == nil || !w.config.Enabled {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	exit.InUse = false
	exit.Cooldown = time.Now().Add(30 * time.Minute)
}

// IsAvailable returns true if WARP is enabled and has healthy exits.
func (w *WarpEgress) IsAvailable() bool {
	if !w.config.Enabled {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.healthy > 0
}

// RoundTrip executes request through WARP (stub).
func (w *WarpEgress) RoundTrip(ctx context.Context, req *http.Request) (*http.Response, error, bool) {
	if !w.config.Enabled {
		return nil, ErrWarpUnavailable, false
	}
	// TODO: Implement actual WARP dialing
	return nil, ErrWarpUnavailable, false
}

func (w *WarpEgress) Close() {
	// TODO: Cleanup WARP tunnels
}
