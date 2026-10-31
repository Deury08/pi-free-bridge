package gate

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"testing/iotest"
)

// ---------------------------------------------------------------------------
// ToolsFromOpenAI — parse both OpenAI tool shapes with real names
// ---------------------------------------------------------------------------

func TestToolsFromOpenAINestedShape(t *testing.T) {
	raw := []any{
		map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        "bash",
				"description": "Run a shell command",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"command": map[string]any{"type": "string"},
					},
				},
			},
		},
	}

	tools := ToolsFromOpenAI(raw)
	if len(tools) != 1 {
		t.Fatalf("want 1 tool, got %d", len(tools))
	}
	if tools[0].Name != "bash" {
		t.Errorf("want real name %q, got %q", "bash", tools[0].Name)
	}
	if tools[0].Description != "Run a shell command" {
		t.Errorf("description not carried: %q", tools[0].Description)
	}
	if _, ok := tools[0].Parameters["properties"]; !ok {
		t.Errorf("parameters not carried: %#v", tools[0].Parameters)
	}
}

func TestToolsFromOpenAIFlatShape(t *testing.T) {
	raw := []any{
		map[string]any{"name": "grep", "description": "Find text", "parameters": map[string]any{}},
	}
	tools := ToolsFromOpenAI(raw)
	if len(tools) != 1 || tools[0].Name != "grep" {
		t.Fatalf("flat shape must parse too: %#v", tools)
	}
}

func TestToolsFromOpenAIJunkAndEmptyNames(t *testing.T) {
	raw := []any{
		"garbage", // not a map
		map[string]any{"type": "function"}, // no name at all
		map[string]any{"function": map[string]any{"name": "ok"}},
	}
	tools := ToolsFromOpenAI(raw)
	if len(tools) != 1 || tools[0].Name != "ok" {
		t.Fatalf("junk rows must be dropped, keep named ones: %#v", tools)
	}
}

// ---------------------------------------------------------------------------
// AliasTools roundtrip with the fixed parse — aliases are bridge_<realname>
// ---------------------------------------------------------------------------

func TestAliasToolsUsesRealNames(t *testing.T) {
	a := NewToolAliaser()
	client := []Tool{{Name: "bash", Description: "d"}, {Name: "read", Description: "d"}}
	aliased, _ := a.AliasTools(client)

	seen := map[string]bool{}
	for _, tl := range aliased {
		seen[tl.Name] = true
	}
	if !seen["bridge_bash"] || !seen["bridge_read"] {
		t.Fatalf("aliases must derive from real names: %#v", seen)
	}

	if got := a.reverse["bridge_bash"]; got != "bash" {
		t.Errorf("reverse[bridge_bash]=%q", got)
	}
	// The same client name re-aliased on a later request gets a unique alias
	// and both reverse entries stay valid (restore never loses names).
	_, _ = a.AliasTools([]Tool{{Name: "bash"}})
	if got := a.reverse["bridge_bash_2"]; got != "bash" {
		t.Errorf("second alias missing: reverse[bridge_bash_2]=%q", got)
	}
}

// ---------------------------------------------------------------------------
// RestoreChunk — JSON-path rewrite of tool-call function names
// ---------------------------------------------------------------------------

func TestRestoreChunkDeltaToolName(t *testing.T) {
	a := NewToolAliaser()
	a.reverse["bridge_bash"] = "bash"

	chunk := `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bridge_bash","arguments":"{\"command\":\"ls\"}"}}]}}]}`
	out := a.RestoreChunk([]byte(chunk))

	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("restored chunk is not valid json: %v", err)
	}
	name := got["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)["name"]
	if name != "bash" {
		t.Errorf("want restored name bash, got %v", name)
	}
}

func TestRestoreChunkNeverTouchesArgumentsOrContent(t *testing.T) {
	a := NewToolAliaser()
	a.reverse["bridge_bash"] = "bash"

	// The alias string inside arguments and inside assistant content must be
	// preserved byte-for-byte (the old string-replace corrupted these).
	chunk := `{"choices":[{"delta":{"content":"run bridge_bash?","tool_calls":[{"function":{"name":"bridge_bash","arguments":"alias bridge_bash here"}}]}}]}`
	out := string(a.RestoreChunk([]byte(chunk)))

	if !strings.Contains(out, `alias bridge_bash here`) {
		t.Errorf("arguments text must not be rewritten: %s", out)
	}
	if !strings.Contains(out, `run bridge_bash?`) {
		t.Errorf("content text must not be rewritten: %s", out)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	name := got["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)["name"]
	if name != "bash" {
		t.Errorf("name field must be restored atomically: %v", name)
	}
}

func TestRestoreChunkPassthroughOnUnknownOrInvalid(t *testing.T) {
	a := NewToolAliaser()

	plain := []byte(`{"choices":[{"delta":{"content":"hola"}}]}`)
	if !bytes.Equal(a.RestoreChunk(plain), plain) {
		t.Errorf("unknown chunk must pass through unchanged: %s", a.RestoreChunk(plain))
	}
	junk := []byte(`{not json`)
	if !bytes.Equal(a.RestoreChunk(junk), junk) {
		t.Errorf("invalid json must pass through")
	}
}

func TestRestoreChunkMessageToolCallsFallback(t *testing.T) {
	// Non-stream shape: message.tool_calls instead of delta.
	a := NewToolAliaser()
	a.reverse["bridge_read"] = "read"

	chunk := `{"choices":[{"message":{"tool_calls":[{"function":{"name":"bridge_read"}}]}}]}`
	out := string(a.RestoreChunk([]byte(chunk)))
	fn := out[strings.Index(out, `"function"`):]
	if !strings.Contains(fn, `"name":"read"`) {
		t.Errorf("message.tool_calls not restored: %s", out)
	}
}

// ---------------------------------------------------------------------------
// Pipe — SSE line framing preserved, data lines rewritten, robust to junk
// ---------------------------------------------------------------------------

func TestPipeRestoresSSEAndKeepsFraming(t *testing.T) {
	a := NewToolAliaser()
	a.reverse["bridge_bash"] = "bash"

	// Malformed JSON on one data line never kills the stream; \r\n endings
	// and non-data lines must survive.
	upstream := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"bridge_bash\"}}]}}]}\r\n" +
		"data: {not json}\r\n" +
		"data: [DONE]\r\n" +
		"event: ping\r\n" +
		"\r\n"

	var out bytes.Buffer
	if err := NewSSEHandler(a).Pipe(strings.NewReader(upstream), &out); err != nil {
		t.Fatalf("pipe: %v", err)
	}

	s := out.String()
	if !strings.Contains(s, `"name":"bash"`) {
		t.Errorf("tool name not restored in SSE: %s", s)
	}
	if !strings.Contains(s, "data: {not json}\r\n") {
		t.Errorf("malformed data line must pass through: %s", s)
	}
	if !strings.Contains(s, "data: [DONE]\r\n") {
		t.Errorf("[DONE] lost: %s", s)
	}
	if !strings.Contains(s, "event: ping\r\n") {
		t.Errorf("non-data lines lost: %s", s)
	}
	if n, want := strings.Count(s, "\r\n"), strings.Count(upstream, "\r\n"); n != want {
		t.Errorf("line count changed: %d != %d", n, want)
	}
}

// The parser must survive network-fragmented reads: iotest.OneByteReader
// gives the reader one byte at a time within a single Pipe call — the exact
// case that broke the old per-chunk string-replace.
func TestPipeHandlesChunkSplits(t *testing.T) {
	a := NewToolAliaser()
	a.reverse["bridge_bash"] = "bash"

	line := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"bridge_bash\"}}]}}]}\n"
	var out bytes.Buffer
	if err := NewSSEHandler(a).Pipe(iotest.OneByteReader(strings.NewReader(line)), &out); err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if !strings.Contains(out.String(), `"name":"bash"`) {
		t.Errorf("restore failed under fragmented reads: %s", out.String())
	}
}
