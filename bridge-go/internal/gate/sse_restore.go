package gate

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
)

// ToolsFromOpenAI parses the tools array of an OpenAI chat-completions request.
// Pi sends the nested function-declaration shape
// {"type":"function","function":{"name",...}} — the same shape gate.Tool
// marshals — but the flat form is tolerated. Rows without a name are dropped:
// an unnamed tool can never satisfy the gate, and aliasing one produced the
// unnamed "bridge__N" aliases Pi then rejected as unknown tools.
func ToolsFromOpenAI(raw []any) []Tool {
	tools := make([]Tool, 0, len(raw))
	for _, entry := range raw {
		row, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		var name, description string
		var parameters map[string]any
		if fn, ok := row["function"].(map[string]any); ok { // nested shape
			name = asString(fn["name"])
			description = asString(fn["description"])
			parameters, _ = fn["parameters"].(map[string]any)
		} else { // flat shape
			name = asString(row["name"])
			description = asString(row["description"])
			parameters, _ = row["parameters"].(map[string]any)
		}
		if name == "" {
			continue
		}
		tools = append(tools, Tool{Name: name, Description: description, Parameters: parameters})
	}
	return tools
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// RestoreChunk rewrites aliased tool names inside ONE upstream chat-completion
// response chunk using JSON paths — never a whole-text string replace, which
// corrupted tool arguments and assistant content and missed aliases split
// across network chunk boundaries.
//
// Handled shapes (first match wins per tool call):
//   - choices[].delta.tool_calls[].function.name   (streaming)
//   - choices[].message.tool_calls[].function.name (non-streaming)
//
// Anything that does not parse as a JSON object is returned byte-for-byte, so
// a malformed event can never break the stream mid-response.
func (a *ToolAliaser) RestoreChunk(data []byte) []byte {
	var chunk map[string]any
	if err := json.Unmarshal(data, &chunk); err != nil {
		return data
	}
	choices, ok := chunk["choices"].([]any)
	if !ok {
		return data
	}
	changed := false
	for _, choice := range choices {
		cm, ok := choice.(map[string]any)
		if !ok {
			continue
		}
		for _, container := range []string{"delta", "message"} {
			partial, ok := cm[container].(map[string]any)
			if !ok {
				continue
			}
			calls, ok := partial["tool_calls"].([]any)
			if !ok {
				continue
			}
			for _, call := range calls {
				tm, ok := call.(map[string]any)
				if !ok {
					continue
				}
				fn, ok := tm["function"].(map[string]any)
				if !ok {
					continue
				}
				name, ok := fn["name"].(string)
				if !ok || name == "" {
					continue
				}
				orig, aliased := a.lookup(name)
				if !aliased || orig == name {
					continue
				}
				fn["name"] = orig
				changed = true
			}
		}
	}
	if !changed {
		return data
	}
	out, err := json.Marshal(chunk)
	if err != nil {
		return data
	}
	return out
}

func (a *ToolAliaser) lookup(alias string) (string, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	orig, ok := a.reverse[alias]
	return orig, ok
}

// Pipe streams an upstream chat-completions response to the client while
// restoring aliased tool names. SSE framing is preserved exactly: every line
// is copied verbatim, and only complete `data:` lines whose payload starts
// with a JSON object brace are rewritten. Reads may arrive fragmented; the
// buffered reader reassembles lines, which the old per-chunk string-replace
// could not do. A final line without a terminator (upstream cut mid-event) is
// still flushed instead of dropped.
func (h *SSEHandler) Pipe(src io.Reader, dst io.Writer) error {
	// Checker: returns the bytes to write for one complete input line (no
	// terminator included) and whether the line carried a \r before the \n.
	emit := func(line []byte, hadCR bool) error {
		out := rewrite(h.aliaser, line)
		if hadCR {
			out = append(out, '\r')
		}
		out = append(out, '\n')
		_, err := dst.Write(out)
		return err
	}

	reader := bufio.NewReaderSize(src, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		hadCR := bytes.HasSuffix(line, []byte{'\r', '\n'})
		if index := bytes.LastIndexByte(line, '\n'); index >= 0 {
			line = line[:index]
		}
		var writeErr error
		if len(line) > 0 || hadCR || err == nil {
			// Emit complete lines; keep blank framing lines verbatim.
			if hadCR {
				line = line[:len(line)-1] // drop the trailing \r: re-added on emit
			}
			writeErr = emit(line, hadCR)
		}
		if err != nil {
			if err == io.EOF {
				return writeErr
			}
			return err
		}
		if writeErr != nil {
			return writeErr
		}
	}
}

// rewrite applies the tool-name restore to one complete SSE line without a
// terminator, or returns the line unchanged when it is not a rewritable
// "data: {json}" line.
func rewrite(aliaser *ToolAliaser, line []byte) []byte {
	payloadStart := payloadOfDataLine(line)
	if payloadStart < 0 {
		return line
	}
	payload := line[payloadStart:]
	endsWithCR := bytes.HasSuffix(payload, []byte{'\r'})
	if endsWithCR {
		payload = payload[:len(payload)-1]
	}
	trimmed := bytes.TrimRight(payload, " \t")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return line
	}
	restored := aliaser.RestoreChunk(trimmed)
	if bytes.Equal(restored, trimmed) {
		return line
	}
	out := make([]byte, 0, payloadStart+len(restored)+1)
	out = append(out, line[:payloadStart]...)
	out = append(out, restored...)
	if endsWithCR {
		out = append(out, '\r')
	}
	return out
}

// payloadOfDataLine returns the index where the JSON payload of an SSE data
// line starts (after "data:" and separating whitespace), or -1 when the line
// is not a data line. The search skips leading whitespace so "data:{...}" and
// "data:  {...}" both qualify.
func payloadOfDataLine(line []byte) int {
	trimmed := bytes.TrimLeft(line, " \t")
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return -1
	}
	rest := trimmed[len("data:"):]
	cut := -1
	for i := 0; i < len(rest); i++ {
		if rest[i] != ' ' && rest[i] != '\t' {
			cut = i
			break
		}
	}
	if cut < 0 {
		return -1
	}
	// Everything stripped so far belongs to the prefix; translate the index
	// back into the original slice space.
	skipped := len(line) - len(trimmed)
	return skipped + len("data:") + cut
}
