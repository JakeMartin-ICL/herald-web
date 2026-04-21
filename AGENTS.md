# AGENTS.md

Working notes for coding agents in `herald-web`.

## What This App Is

Herald is a browser UI for Herald hardware boxes. The app connects to one hub over WebSocket, tracks turn order for several board games, and keeps the browser UI, box LEDs, OLED displays, RFID flows, timers, and local persistence in sync.

This is a Vite + TypeScript SPA with a largely module-driven architecture and a single HTML shell.

## Fast Start

- Install deps: `npm install`
- Dev server: `npm run dev`
- Build: `npm run build`
- Type-check: `npm run typecheck`
- Lint: `npm run lint`

## Source Of Truth

Do not copy interfaces into docs unless there is a strong reason.

- Shared types and the current `GameMode` contract live in [src/types.ts](/home/jake/Documents/herald-web/src/types.ts)
- Global mutable app state lives in [src/state.ts](/home/jake/Documents/herald-web/src/state.ts)
- The active/setup mode holders used to avoid circular imports live in [src/currentGame.ts](/home/jake/Documents/herald-web/src/currentGame.ts)
- The mode factory and mode IDs live in [src/modes/index.ts](/home/jake/Documents/herald-web/src/modes/index.ts)

If docs and code disagree, trust the code.

## Architecture In Practice

- [index.html](/home/jake/Documents/herald-web/index.html) is the single app shell and contains the overlay/dialog DOM.
- [src/main.ts](/home/jake/Documents/herald-web/src/main.ts) wires DOM events and boots the app.
- [src/websockets.ts](/home/jake/Documents/herald-web/src/websockets.ts) owns hub connection state, outbound sends, and inbound message dispatch.
- [src/render.ts](/home/jake/Documents/herald-web/src/render.ts) is the main browser render path.
- [src/game.ts](/home/jake/Documents/herald-web/src/game.ts) handles start-game flow and routes hardware actions into the current mode.
- Each game mode is a class in [src/modes](/home/jake/Documents/herald-web/src/modes) implementing `GameMode`.

Useful mental model:

1. The browser talks only to the hub.
2. `state` is the shared truth inside the app.
3. Modes decide game-specific turn logic.
4. Render/display/LED/RFID modules project that state outward.

## Files You’ll Reach For Often

- [src/boxes.ts](/home/jake/Documents/herald-web/src/boxes.ts): box naming, connect/disconnect, substitution, setup UI
- [src/leds.ts](/home/jake/Documents/herald-web/src/leds.ts): LED command helpers and synchronization
- [src/display.ts](/home/jake/Documents/herald-web/src/display.ts): OLED display sync
- [src/rfid.ts](/home/jake/Documents/herald-web/src/rfid.ts): simulated and real RFID flows
- [src/tags.ts](/home/jake/Documents/herald-web/src/tags.ts): tag loading/filtering
- [src/persist.ts](/home/jake/Documents/herald-web/src/persist.ts): resume/backup state persistence
- [src/gamelog.ts](/home/jake/Documents/herald-web/src/gamelog.ts) and [src/graphs.ts](/home/jake/Documents/herald-web/src/graphs.ts): history and stats
- [public/factions.json](/home/jake/Documents/herald-web/public/factions.json), [public/tags.json](/home/jake/Documents/herald-web/public/tags.json), [public/expansions.json](/home/jake/Documents/herald-web/public/expansions.json): content data

## Project Conventions

- Prefer updating the real type in `src/types.ts` over documenting a duplicate shape.
- Keep game-specific logic inside the relevant file under `src/modes/` unless it truly belongs in shared infrastructure.
- Avoid hardcoded game-mode branching in shared modules. Prefer mode methods over `switch`/`if` trees on mode IDs.
- If keeping game-specific logic inside a mode requires expanding the generic `GameMode` contract in `src/types.ts`, stop and run that change by the user before proceeding.
- Avoid introducing new circular imports. The existing `currentGame.ts` pattern is there for a reason.
- Virtual boxes are first-class for testing. Be careful not to accidentally send hardware-only messages to them.
- This repo leans on direct DOM access rather than a framework. Match existing patterns unless there is a clear reason to refactor.

## When Changing Game Modes

- Update the mode class in `src/modes/*.ts`
- Update shared types in `src/types.ts` if the contract or mode state changes
- If you add a new mode, wire it into `src/modes/index.ts` and the setup select in `index.html`

## Practical Guardrails

- The app is stateful and many modules observe the same data, so regressions often come from missing secondary updates rather than the primary change.
- Box substitution, undo/resume, and mid-game reconnects are easy places to break assumptions.
- If you touch anything involving messages from the hub, scan `handleMessage()` in `src/websockets.ts` and the matching outbound helpers before changing behavior.

## Documentation Hygiene

Keep this file short. It should help an agent get productive quickly, not narrate the whole codebase.
