# bun-upgrades — port go-native improvements to the Bun relay

> Branch: `feat/bun-upgrades` (based on `master`)
> Port the go-native improvements into the Bun build. Go work is stopped
> (long conversations break there); Bun stays the platform.

## Specs

- S1: "por ahoranos quedamos en main que usa bun, que estounciona perfecto pero le vamos a traer mejoras de las que trae el go" — all changes live on the Bun relay (`master` line); no Go binary work.
- S2: "la cosecha se hace en la extencio y tambien en el proceso aparte, para poder ejecutar en remoto en caso de que opencode y pi esten emmaquinas separadas" — hybrid harvest: both the Pi extension and the relay process harvest the OpenCode session id; the id travels from Pi to the relay for separated machines.
- S3: "lo de validar los id de secion" — the gate only trusts OpenCode-created ids: never mint synthetic ids; harvested or user override only; report the source (`opencode.db`, `session-diff`, override) in diagnostics.
- S4: "ya tenemos listo wl warp asi que podemos integralo en la opcion de bun" — integrate warp-minimal (already built, `C:/Users/Polanco/warp-minimal`, listens on 127.0.0.1:8789) into the Bun relay as an alternate egress.
- S5 (WARP modes): "auto: primero sin warp y se aparece el rait limit usamos el warp" / "encendido: todo pasa por el warp" / "apagado: sin el warp" — `warpEnabled: "off" | "auto" | "on"` in config, `off` default:
  - `off`: never touches WARP.
  - `auto`: local egress first; on a rate-limit (`429`) failure the relay retries through WARP (failover only before the first byte is delivered downstream).
  - `on`: every request goes through WARP.
  - Mid-stream failure never triggers failover or a retry: the stream terminates as-is.

## Tasks

- T1 (S2,S3): hybrid session harvest — extension harvests and passes the id to the relay via env; relay keeps its local harvest as fallback; precedence override > Pi-supplied > relay-local; doctor reports the source.
- T2 (S3): 429 diagnostics — actionable message on gate rejection (`/free-bridge-session`), no synthetic minting anywhere.
- T3 (S5): WARP egress modes in relay.mjs — `warpEnabled` config (`off|auto|on`), failover-before-first-byte, local backoff after WARP attempt in `auto`.
- T4 (S4,S5): warp-minimal supervisor in index.ts (spawn/reuse/health probe, mirroring the relay supervisor) plus the Pi command (`/free-bridge-warp off|auto|on`) that persists the mode, disabled by default.
- T5: tests + README/docs for the new config and behavior.

## Log

- L1 (user, verbatim): "hola, mira al migrar a go se corta digamso el streamng , por ejempo hace una tarea y al final no me responde, etc, entonces lo que vamso a hacer es que opor ahoranos quedamos en main que usa bun, que estounciona perfecto pero le vamos a traer mejoras de las que trae el go, por ejemplo la cosecha se hace en la extencio y tambien en el proceso aparte, para poder ejecutar en remoto en caso de que opencode y pi esten emmaquinas separadas; tambien lo de validar los id de secion esto no se si ya esta en go pero si hay un md sobre esto; ademas ya tenemos listo wl warp asi que podemos integralo en la opcion de bun. dime si entendiste y si recomiendas alguna otra cosa qu etraigamos de lo que hay n go haci bun; pero como te comente por ahorano vamos a trabajar en go porqeu vamsoa decir corta las conversaciones."
- L2 (user, verbatim): "feat/bun-upgrades si esta rama, recuerda que para el warp debemos tener la opcion de auto: primero sin warp y se aparece el rait limit usamos el warp; encendido: todo pasa por el warp; apagado: sin el warp , me entiendes?"
- L3: Branch `feat/bun-upgrades` created from `master` (it did not exist yet).
- L4 (user): "para los modosdel warp aparecen en pi" — the WARP modes are selectable from Pi itself: a Pi command persists `warpEnabled` (off/auto/on) in the bridge config; the relay reads it at startup.
