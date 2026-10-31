package gate

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// HarvestSessionID busca un ID de sesión válido de OpenCode.
// El gate de OpenCode solo confía en IDs que el cliente oficial creó;
// los IDs mintidos localmente casi siempre son rechazados (429).
//
// Prioridad:
// 1. PI_FREE_BRIDGE_SESSION_ID (override explícito por variable de entorno)
// 2. ~/.pi/agent/pi-free-bridge.json (config persistida por el usuario)
// 3. ~/.local/share/opencode/opencode.db (SQLite: authoritative, paridad con relay.mjs)
// 4. ~/.local/share/opencode/storage/session_diff/ses_*.json (más reciente por mtime; puede estar stale)
func HarvestSessionID() (string, error) {
	// 1. Override por variable de entorno.
	if id := os.Getenv("PI_FREE_BRIDGE_SESSION_ID"); id != "" {
		return id, nil
	}

	// 2. Config persistida.
	if id := readPersistedSessionID(); id != "" {
		return id, nil
	}

	// 3. opencode.db (SQLite, fuente autoritativa; paridad con relay.mjs).
	if id := harvestFromOpenCodeDB(); id != "" {
		return id, nil
	}

	// 4. Archivos de session_diff (más reciente por mtime; puede estar stale).
	if id := harvestFromSessionDiff(); id != "" {
		return id, nil
	}

	return "", fmt.Errorf("no OpenCode session id found")
}

// readPersistedSessionID lee el ID guardado por el usuario en ~/.pi/agent/pi-free-bridge.json.
func readPersistedSessionID() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	cfgPath := filepath.Join(home, ".pi", "agent", "pi-free-bridge.json")
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return ""
	}
	var cfg struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}
	return cfg.SessionID
}

// harvestFromSessionDiff lee el ID más reciente de
// ~/.local/share/opencode/storage/session_diff/ses_*.json.
func harvestFromSessionDiff() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	diffDir := filepath.Join(home, ".local", "share", "opencode", "storage", "session_diff")
	entries, err := os.ReadDir(diffDir)
	if err != nil {
		return ""
	}

	var newestID string
	var newestTime time.Time
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "ses_") || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		info, err := entry.Info()
		if err != nil || info.IsDir() {
			continue
		}
		if newestID == "" || info.ModTime().After(newestTime) {
			newestID = id
			newestTime = info.ModTime()
		}
	}
	return newestID
}
