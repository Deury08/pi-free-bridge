# Feature: Bun-ClientHello gate bypass for bridge-go

## Objective
Make bridge-go (Go runtime) pass the OpenCode free-tier gate without a real
Bun runtime, so `gentle-shell`/Pi can use free models end-to-end.

## Problem
The gate rejects requests whose TLS ClientHello is not Bun's, returning an
HTTP 429 `FreeUsageLimitError` that mimics a quota error. bridge-go used a
hand-written uTLS spec for Bun that produced "downgrade attempt detected" /
"error decoding message"; the old plain-TLS path was also rejected (429).

## Why the fix is correct (evidence)
- Captured the REAL ClientHello bytes of Bun 1.3.12 (local raw TCP listener,
  `cmd/capture-hello`): 17 cipher suites (no GREASE), extension order
  `0xfe0d(ECH carrier 218B), EMS, reneg, curv(x25519,p256,p384), fmt, ticket,
  ALPN http/1.1, OCSP, sigalgs(9), SCT, keyshare(x25519), pskmodes, vers[1.3,1.2],
  padding 35B`.
- A uTLS spec built from those bytes reached `200 OK` over the exact relay.mjs
  body shape (cmd/debug-roundtrip/mode=bun and mode=bt), while plain Go TLS
  still gets 429 (mode=plain) — proving fingerprint validation.
- End-to-end through the full bridge binary (handler→egress→BunTransport):
  two consecutive HTTP 200 SSE responses on 127.0.0.1:8790.

## Scope
- bridge-go/internal/httpx/bun_clienthello.go — rewritten spec (wire-verified).
- bridge-go/internal/httpx/bun_transport.go — emit Content-Length in
  writeRequest (body is fully buffered; undeclared length broke upstream).
- bridge-go/cmd/bridge-go/main.go — permanent stderr log of real RoundTrip
  errors before the generic 502 mapping.
- bridge-go/cmd/capture-hello/ — reusable ClientHello capture tool.
- bridge-go/cmd/debug-roundtrip/ — harness modes: plain / bun / bt / self /
  selfbt, shared relayShapedBody().
- index.ts — earlier session fixes (dirname import, stderr listen detection).

## Acceptance criteria
- [x] Harness mode=bt returns HTTP 200 with streamed model content.
- [x] POST http://127.0.0.1:8790/v1/chat/completions returns HTTP 200 SSE (x2).
- [x] go build ./... && go vet ./... clean.
- [ ] Real `gentle-shell` session conversation through Pi free models.
- [ ] Work-unit commit on the feature branch.

## Notes
- Do NOT trust bare curl `-d` inline bodies on PowerShell 5.1; write the JSON
  file BOM-less ([System.IO.File]::WriteAllText with UTF8Encoding($false)).
- The ECH carrier bytes (0xfe0d) were hand-truncated once; fix = re-derive
  from the dump via script (extract-fe0d.cjs), never retype hex by hand.
- The deployed runtime binary lives in ~/.pi/agent/pi-free-bridge/bin/
  (first in resolveBinaryPath()); also updated the repo copy.
