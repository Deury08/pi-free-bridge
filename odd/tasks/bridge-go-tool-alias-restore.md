# bridge-go tool alias parse + SSE restore

## Objective

Pi no longer receives tool calls named `bridge__271`, `bridge__333`, etc.
("Tool bridge__271 not found"). Tool declarations sent to the gate use the
client's real names wrapped in deterministic `bridge_<name>` aliases, and the
upstream SSE stream restores the real names on the way back.

## Problem (observed live 2026-10-31)

Two independent defects in `chatCompletionsHandler`:

1. **Parse shape**: Pi sends tools in the nested OpenAI shape
   `{"type":"function","function":{"name":...}}` — the same shape
   `gate.Tool.MarshalJSON` writes. The handler parsed the flat form,
   reading `tt["name"]`, so EVERY client tool arrived with an empty name;
   the aliaser produced `bridge_` + counter suffixes (`bridge__271`).
2. **Restore never wired**: `sseHandler` was accepted by the handler but
   never used — responses were piped with a raw `io.Copy`. Even a correct
   alias would have reached Pi un-restored. The existing `RestoreNames`
   string-replace path is also unsafe (replaces inside content text,
   misses aliases split across chunk boundaries).

## Scope

- `bridge-go/cmd/bridge-go/main.go` — tool parsing (both shapes) + wire the
  SSE pipe replacing `io.Copy`.
- `bridge-go/internal/gate/` — `ToolsFromOpenAI` helper (testable) and a
  JSON-path SSE restore (`SSEHandler.Pipe`), replacing the string-replace
  `TransformStream`.
- New Go tests `bridge-go/internal/gate/tools_sse_test.go`.

Out of scope: egress coordinator, session harvest WIP (user's uncommitted
gate changes stay uncommitted; the rebuilt binary still contains them).

## Tasks

- [x] T1: RED Go tests — nested/flat tool parse, alias roundtrip,
      RestoreChunk JSON-path, SSE line preservation, alias-split immunity.
- [x] T2: implement `ToolsFromOpenAI` + `RestoreChunk` + `Pipe`.
- [x] T3: main.go wiring (parse fix + `sseHandler.Pipe` after RoundTrip).
- [x] T4: verify — `go build ./...`, `go test ./internal/gate/`, vet.
- [x] T5: rebuild + replace repo and persistent binaries; sync installed
      Pi checkout (binary lives in the persistent bin dir).
- [x] T6: work-unit commit.

## Additional work discovered during verification

- `SSEHandler.Pipe` could never be exercised without an https upstream: the
  egress BunTransport hard-rejected http. Added a scoped fallback: plain TCP
  for loopback hosts only (127.0.0.1/localhost/::1, explicit port required);
  https keeps the Bun fingerprint path. `finishRoundTrip` extracted to share
  write/read/bookkeeping between TLS and plain conns.

## Verification evidence

- RED→GREEN: tools_sse_test.go 11 cases (nested/flat parse, junk dropped,
  alias roundtrip, JSON-path restore, arguments/content untouched,
  passthrough junk, message.tool_calls fallback, SSE framing incl \r\n,
  fragmented one-byte reads).
- E2E smoke against a local loopback fake upstream (non-supported http path
  now allowed as loopback): upstream received tools
  ["read","bridge_bash","bash"] (gate decls + real-name alias, no
  unnamed bridge__N), response restored "bash", no bridge_* tool names,
  literal alias text inside content untouched, [DONE] preserved.
- Deployed: rebuilt pi-free-bridge.exe with -ldflags "-X main.Version=v0.1.0"
  (plain go build yields "dev" which the extension's version check would
  flag), replaced persistent bin (hash E50BD9C8…), running stale instance
  pid 508 killed via the new identity-guarded killer (isBridgeGoPid true →
  kill true) so the next Pi request respawns on the fixed binary; health 200.
- go build ./... + go vet ./internal/httpx/ ./internal/gate/ clean;
  user's uncommitted gate WIP untouched and excluded from the commit.

## Acceptance

- Client tools parse from the nested `function{}` shape (and tolerate the
  flat form) with their real names.
- Alias map is alias→real; the SSE pipe rewrites only
  `choices[].delta.tool_calls[].function.name` (plus `message.tool_calls`
  fallback on non-stream JSON) and passes every other byte through.
- Content text is never string-replaced; aliases split across chunk
  boundaries cannot survive (whole SSE data lines are JSON-parsed).

## Route notes

Author's inline fix in one bounded area already mapped; Go toolchain present.

## Follow-up defect: Content-Length overrun on error bodies (2026-10-31)

**Problem (observed live):** after T5 deploy, every upstream error response
(4xx/5xx JSON with an exact `Content-Length`) killed the client connection:
`SSEHandler.Pipe` re-emitted the final line always terminated with `\n`, but
upstream error bodies end without a newline — the copied body ran one byte
over the declared `Content-Length` and Go's server aborted
("http: wrote more than the declared Content-Length"; client sees
`UND_ERR_SOCKET other side closed`). Pi therefore got a dead socket instead
of the error — "no me responde" with no diagnostic.

**Fix (test-first, RED→GREEN):**

- `SSEHandler.Pipe` now re-terminates each line exactly as the source did
  (`hadTerm := err == nil` — ReadBytes returns nil only when it found `\n`).
  Unterminated final lines flush byte-bare. Non-SSE JSON passthrough is now
  byte-exact. `\r\n` framing unchanged.
- New test `TestPipeUnterminatedFinalLineIsByteExact` (was RED: got +1 `\n`;
  now GREEN).
- `chatCompletionsHandler`: for upstream ≥400 responses the body is read
  (≤4 KB), logged to stderr for diagnostics, and written literally — exact
  length match with the copied headers; the restore pipe no longer touches
  error bodies. SSE-shaped error bodies (leading `data:`) replay the
  snapshot through the pipe.
- Removed the temporary debug body/MultiReader hack which could double-serve
  bytes.

**Evidence:** rebuild + temp instance on 8791 → upstream 400 now returns
complete body (92 bytes incl the mapped upstream message), client fetch
resolves cleanly (no `terminated`); happy-path SSE against the real
upstream (`glm-5.3-flash-free`) still 200 with `[DONE]`, tools restored;
`go test ./...` and vet clean. Error-map paths (decoder/roundtrip failures)
write their own status+body and are unaffected.
