package gate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Session represents a synthetic OpenCode session.
type Session struct {
	ID        string
	CreatedAt time.Time
	Holder    string
}

// SessionManager manages synthetic sessions with 30min TTL.
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	ttl      time.Duration
}

func NewSessionManager(ttl time.Duration) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		ttl:      ttl,
	}
}

func (m *SessionManager) GetOrCreate(holder string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if s, ok := m.sessions[holder]; ok && now.Sub(s.CreatedAt) < m.ttl {
		return s
	}
	id := newSessionID()
	s := &Session{ID: id, CreatedAt: now, Holder: holder}
	m.sessions[holder] = s
	return s
}

func (m *SessionManager) Cleanup() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for holder, s := range m.sessions {
		if now.Sub(s.CreatedAt) >= m.ttl {
			delete(m.sessions, holder)
		}
	}
}

func newSessionID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return "ses_" + hex.EncodeToString(b)
}

func (s *Session) SessionHeaders() map[string]string {
	return map[string]string{
		"x-opencode-session":     s.ID,
		"x-opencode-session-id":  s.ID,
		"x-session-affinity":     s.ID,
		"X-Session-Id":           s.ID,
	}
}

type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
}

type ToolAliaser struct {
	mu      sync.Mutex
	forward map[string]string
	reverse map[string]string
	counter map[string]int
}

func NewToolAliaser() *ToolAliaser {
	return &ToolAliaser{
		forward: make(map[string]string),
		reverse: make(map[string]string),
		counter: make(map[string]int),
	}
}

func (a *ToolAliaser) AliasTools(clientTools []Tool) ([]Tool, map[string]string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	aliased := []Tool{{
		Name:        "read",
		Description: "Read a file",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string"},
			},
			"required": []string{"path"},
		},
	}}

	for _, t := range clientTools {
		base := "bridge_" + t.Name
		alias := base
		if n, exists := a.counter[base]; exists {
			a.counter[base] = n + 1
			alias = fmt.Sprintf("%s_%d", base, n+1)
		} else {
			a.counter[base] = 1
		}
		a.forward[t.Name] = alias
		a.reverse[alias] = t.Name
		aliased = append(aliased, Tool{
			Name:        alias,
			Description: t.Description,
			Parameters:  t.Parameters,
		})
	}
	return aliased, a.forward
}

func (a *ToolAliaser) RestoreNames(text string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for alias, orig := range a.reverse {
		text = strings.ReplaceAll(text, alias, orig)
	}
	return text
}

type PromptInjector struct {
	CWD string
}

func (p *PromptInjector) Inject(messages []map[string]any) []map[string]any {
	if p.CWD == "" {
		return messages
	}
	envBlock := fmt.Sprintf("<env>\nWorking directory: %s\n</env>\n", p.CWD)
	hasSystem := false
	for _, m := range messages {
		if m["role"] == "system" {
			content := ""
			if c, ok := m["content"].(string); ok {
				content = c
			}
			m["content"] = envBlock + content
			hasSystem = true
			break
		}
	}
	if !hasSystem {
		messages = append([]map[string]any{{"role": "system", "content": envBlock}}, messages...)
	}
	return messages
}

type ErrorMapper struct{}

func (e *ErrorMapper) Map(statusCode int, body string) map[string]any {
	switch statusCode {
	case http.StatusBadRequest:
		return map[string]any{
			"error": map[string]any{
				"type":    "invalid_request_error",
				"message": body,
			},
		}
	case http.StatusUnauthorized:
		return map[string]any{
			"error": map[string]any{
				"type":    "authentication_error",
				"message": "Invalid authentication",
			},
		}
	case http.StatusForbidden:
		return map[string]any{
			"error": map[string]any{
				"type":    "permission_error",
				"message": "Access forbidden",
			},
		}
	case http.StatusTooManyRequests:
		return map[string]any{
			"error": map[string]any{
				"type":    "rate_limit_error",
				"message": "Rate limit exceeded",
			},
		}
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return map[string]any{
			"error": map[string]any{
				"type":    "upstream_stream_error",
				"message": "Upstream connection failed",
			},
		}
	default:
		return map[string]any{
			"error": map[string]any{
				"type":    "internal_error",
				"message": fmt.Sprintf("Upstream error: %d", statusCode),
			},
		}
	}
}

type SSEHandler struct {
	aliaser *ToolAliaser
}

func NewSSEHandler(aliaser *ToolAliaser) *SSEHandler {
	return &SSEHandler{aliaser: aliaser}
}

func (h *SSEHandler) TransformStream(ctx context.Context, in <-chan string) <-chan string {
	out := make(chan string)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case chunk, ok := <-in:
				if !ok {
					return
				}
				out <- h.aliaser.RestoreNames(chunk)
			}
		}
	}()
	return out
}
