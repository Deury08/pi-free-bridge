# Feature: proxy failover for the pi-free-bridge relay

Direct-first egress for the Pi free-tier relay: the relay keeps calling OpenCode
directly from Bun exactly as today, and only falls back to a pool of HTTP CONNECT
proxies when the direct path fails, discarding dead proxies until the pool is
refreshed from its source.

## Specs

- **S1** — user: "siempre quise ponerle a mi bridge proxys para rotar". With no
  proxy configured the relay behaves byte-for-byte as today (zero regression).
- **S2** — user: "los proxies solo se usan cuando la IP sin proxy lo necesita".
  Direct is the permanent preferred egress; proxies are a rescue pool only.
- **S3** — user trigger choice: "Sobre error + cooldown" plus "Quedarse en el
  último proxy sano". The relay sticks to the last candidate that served a
  request; a candidate is only abandoned after it fails.
- **S4** — a failing candidate (network error from `fetch`, or HTTP 429 from
  upstream) is discarded for the current pool refresh cycle and the next
  candidate is tried. Preference order per fresh attempt: direct, then proxies.
  A 429 from the gate is ambiguous (GATE-DIAGNOSIS.md) but retrying through one
  other egress is harmless; the session id never changes during failover.
- **S5** — pool source: `RELAY_PROXY_SOURCE` (URL to a raw list, one proxy per
  line). Entries with an explicit scheme: only `http`/`https` are kept; `socks4`
  /`socks5` are dropped (evidence: Bun fetch rejects `UnsupportedProxyProtocol`,
  probe 2026-11). Bare `host:port` lines are treated as `http`. Blanks, dups and
  garbage are dropped; the pool is capped (default 5).
- **S6** — static pool: `RELAY_PROXY_STATIC` (comma-separated, same scheme
  rules). Explicit plugin config in `~/.pi/agent/pi-free-bridge.json`
  (`"proxy": { "static": [...], "source": "<url>", "refreshMinutes": n }`) is
  passed to the relay env by `index.ts`; explicit env wins over config.
- **S7** — proxy paths serve only the `/v1/*` upstream forward. `/health`, the
  session harvest and every other route are unaffected.
- **S8** — no transparent retry once any body byte has been relayed to the
  client (SSE must never be replayed or duplicated). Retries happen only before
  headers hit the client socket.
- **S9** — an attempt timeout (default 15 s, `RELAY_PROXY_TIMEOUT_MS`) bounds
  only the time until upstream headers arrive; after that the SSE stream runs
  unbounded as today.
- **S10** — the pool refreshes from the source every `refreshMinutes` (default
  30); a refresh failure keeps the previous list. Discarded-expiry resets on
  refresh. No running timer is added beyond the refresh cycle.

- **S11** — user: "debemos tener un modo proxy para hacer test". The relay exposes
  `GET /proxies`: the configured pool, the effective preference order and a
  per-candidate reachability probe (`direct` included, `{ok,status,latencyMs}` or
  `{ok:false,error}`). Pi exposes `/free-bridge-proxy`, which prints that report
  and explains what to configure when no pool exists.

## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S1-S10 | docs | (this file) |
| T2 | S3-S6 | test RED + impl: pool parse + failover driver helpers | feat/proxy-failover |
| T3 | S4, S8, S9 | impl: `forward()` integration (headers-pre-retry, attempt timeout) | feat/proxy-failover |
| T4 | S6, S7 | impl: `index.ts` config plumbing + env passthrough | feat/proxy-failover |
| T5 | S1-S10 | docs: README section (Spanish, repo convention) | feat/proxy-failover |
| T6 | S5, S8 | verify: local mock CONNECT proxy + fake upstream e2e under Bun | feat/proxy-failover |

## Log

- L1 — user: "Bueno si siempre quise ponerle a mi bridge proxys para rotarlo"
  (add proxy rotation to the bridge).
- L2 — user: "otra cosa, los proxys solo se usan cuando la IP sin proxy lo
  necesita" (direct-first, proxies as rescue).
- L3 — user trigger pick: "Sobre error + cooldown"; recovery pick: "Quedarse en
  el último proxy sano".
- L4 — user: "GRATIS" + "no hay algo en internet por ahí" → free public proxy
  lists were chosen as the default source; consumer-disposable pool (dead
  proxies are discarded, not healed).
- L5 — design agreement: direct-first, stick-to-last-healthy, discard-on-error,
  refresh from public source; v1 pools are http/https CONNECT only after the
  Bun probe showed socks5 unsupported.
