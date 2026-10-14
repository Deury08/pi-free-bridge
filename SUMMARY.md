# Resumen de sesión — OpenCode free tier descifrado + handoff pi-free-bridge

**Fecha:** 2026-10-14 · **Proyecto:** polanco · **Estado:** investigación completa, implementación delegada

---

## Objetivo

Descifrar por qué los modelos free de OpenCode devuelven 403 desde clientes de terceros (Pi), dejar Pi funcionando y documentar todo para delegar la construcción de un bridge propio.

## Instrucciones del usuario

- Usuario en español rioplatense; artefactos técnicos en inglés.
- Pedido explícito: frenar la implementación, dejar todo documentado para enviar **otro agente** a implementar, más un MD de cómo se solucionó.
- El bridge nuevo debe ser free-only y "nuestro" (`pi-free-bridge`); el provider id se mantiene `oc-sdk-zen`.

## Descubrimientos clave

- **Superficie viva:** `https://opencode.ai/inference/v1` (ruta oficial del CLI 1.19.0 según la tabla de docs). `/zen/v1` devuelve `403 FreeTierError` incluso con bytes byte-idénticos oficiales (A/B decisiva; fingerprint TLS descartado).
- **Headers (bisect ~25 probes):** core6 obligatorio = `content-type`, `user-agent` con `opencode/`, `authorization: Bearer public`, `x-opencode-client`, `x-opencode-session`, `x-opencode-session-id`; **mínimo 7 headers totales** (core6 solos → 403; core6 + `x-foo` → 200). `x-opencode-project` y `x-opencode-request` dispensables si el conteo se mantiene.
- **Body:** `stream:true` + mensaje `system`/`developer` inicial (contenido libre) + `tools` no vacío (nombres no inspeccionados en inference).
- **Pi e2e OK:** `mimo-v2.6-flash-free`, `space-bunny-free`, `big-pickle`, `cat-jam-free`, `nemotron-3.5-lightning-free`, `step-5-preview-free` (429 transitorio una vez). `longcat-2.5-preview-free` sin probar e2e.
- **Excluidos:** `muse-spark-1.2/1.3-contributor-free` y `jev-1.13-free` → 400 `ModelProtocolUnsupported` en chat/completions (403 en `/messages`). **GO** (`zen/go/v1`): key válida pero `429 GoUsageLimitError` (cuota agotada) → descartado.
- Premium + `Bearer public` en inference → `400 Model is unavailable` → filtro free obligatorio.
- **Pi ExtensionAPI:** `registerProvider(name, ProviderConfig)` soporta `headers`, `authHeader` y overrides `api`/`baseUrl` por modelo; `pi install ./local/path` soportado; `Symbol.for("pi-oc-sdk:registered")` colisiona entre puentes → no coexistir.
- Engram MCP degradado (transport) esta sesión → sin persistencia vía MCP.

## Logrado

- Gate decodificado completo con bisect y `repro.mjs` autocontenido (HANDOFF §4.5).
- Parches stopgap aplicados y verificados:
  - `pi-opencode-bridge/index.ts:15` → `ZEN_BASE_URL = "https://opencode.ai/inference/v1"`
  - `pi-opencode-bridge/README.md:57` actualizado
  - `settings.json`: eliminada la entrada muerta `oc-sdk-zen/jev-1.13-free` (warning de cada arranque)
- Creados en `C:\Users\Polanco\pi-free-bridge\`:
  - **`HANDOFF.md`** — spec completa para el agente implementador (contrato del gate, facts de Pi, decisiones cerradas D1–D7, checklist T1–T9, criterios de aceptación, riesgos)
  - **`SOLUTION.md`** — narrativa de cómo se solucionó (hipótesis muertas, breakthrough, bisect, matriz e2e, causa raíz)
  - **`SUMMARY.md`** — este archivo

## Próximos pasos

1. Enviar `HANDOFF.md` al agente implementador para construir `pi-free-bridge` (T1–T9).
2. **T6 crítico:** probar precedencia extensión vs config nativa (quitar headers estáticos de `models.json` y re-verificar e2e).
3. **O3:** `profiles.json` referencia `nemotron-3-ultra-free`, ausente en la lista live → reportar al usuario, no editar sin autorizar.

## Archivos relevantes

| Ruta | Qué |
|---|---|
| `C:\Users\Polanco\pi-free-bridge\HANDOFF.md` | spec completa para el implementador |
| `C:\Users\Polanco\pi-free-bridge\SOLUTION.md` | cómo se solucionó |
| `C:\Users\Polanco\pi-free-bridge\SUMMARY.md` | este resumen |
| `C:\Users\Polanco\.pi\agent\npm\node_modules\pi-opencode-bridge\index.ts` | stopgap `ZEN_BASE_URL` (línea 15) — muere con `pi update` |
| `C:\Users\Polanco\.pi\agent\settings.json` | packages / enabledModels / defaultProvider |
| `C:\Users\Polanco\.pi\agent\models.json` | headers estáticos `oc-sdk-zen` a limpiar en T6 |
