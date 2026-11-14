# Pendientes de 0.6.0

Lo único que sigue abierto después de la rama `feat/bun-precedence`.

---

## 1. Ciclo de vida del proxy WARP a través de un swap

Sin verificar. Cuando se reemplaza el binario del relay (`swapRelayBinary`), no
está comprobado qué pasa con el proxy WARP que el relay anterior tenía levantado:
si el nuevo lo hereda, lo rearma o queda huérfano escuchando en el puerto 8789.

Es una **incógnita, no un defecto confirmado**: no hay reproducción ni evidencia
de que falle. Anotado para que no se pierda el hilo.

---

## Cerrados en esta rama

- **`/free-bridge-doctor` revienta con `ReferenceError`** — arreglado. La línea
  `live ids` se borró (el binding `live` ya no existía) y `discovered.skipped`
  pasó a `discovered.skippedCount`, con el mismo texto que el dry-run. Tiene
  test: invoca el handler con un `ctx` falso y un `HOME` temporal.
- **`test/smoke.mjs` falla** — borrado, no reescrito. No podía afirmar nada
  verdadero: llamaba a `bridge(pi)` sin `await` sobre un entry point `async` que
  publica el provider después de sus esperas; con `DRY_RUN=1` le prohibía al
  relay el catálogo del que depende el registro; y comparaba contra
  `~/.cache/opencode/models.json`, una fuente que el producto dejó de leer.
