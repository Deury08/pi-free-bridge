package gate

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go SQLite driver
)

// harvestFromOpenCodeDB reads the newest OpenCode session id from
// ~/.local/share/opencode/opencode.db (table `session`, ORDER BY
// time_created DESC). This matches relay.mjs (bun:sqlite) and is the
// authoritative source: session_diff/ files go stale while the SQLite
// store keeps up with real OpenCode usage.
//
// It prefers sessions whose `directory` matches the current working
// directory, then falls back to the newest session overall.
func harvestFromOpenCodeDB() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dbPath := filepath.Join(home, ".local", "share", "opencode", "opencode.db")
	if _, err := os.Stat(dbPath); err != nil {
		return ""
	}

	// Open read-only so we never mutate the user's OpenCode store.
	dsn := "file:" + filepath.ToSlash(dbPath) + "?mode=ro"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return ""
	}
	defer db.Close()

	cwd, _ := os.Getwd()
	// Normalize to OpenCode's stored format: forward slashes, drive letter kept.
	dirFilter := filepath.ToSlash(cwd)

	// Prefer a session from this exact directory.
	row := db.QueryRow(
		`SELECT id FROM session
		 WHERE directory = ?
		 ORDER BY time_created DESC LIMIT 1`, dirFilter)
	var id string
	if err := row.Scan(&id); err == nil && id != "" {
		return id
	}

	// Fallback: newest session overall (same as relay.mjs behavior for
	// sessions run elsewhere).
	row = db.QueryRow(
		`SELECT id FROM session
		 WHERE directory IS NOT NULL AND directory != ''
		 ORDER BY time_created DESC LIMIT 1`)
	if err := row.Scan(&id); err == nil && id != "" {
		return id
	}
	return ""
}
