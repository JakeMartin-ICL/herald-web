# Herald Web App — Codebase Guide

A TypeScript + Vite app that connects over WebSocket to a Herald hub box and manages turn order for board games.

## File Structure

```
index.html       — Single page app shell + all dialog overlays (no inline onclick handlers)
style.css        — All styles
factions.json    — Faction data for TI and Eclipse (names, colours, IDs)
tags.json        — RFID tag definitions for each game (display name + internalId);
                   wildcard entries { display: "*", id: "game:faction:*" } expand to
                   faction tags at load time using factions.json
src/
  main.ts        — Entry point: imports all modules, wires all DOM event listeners
  types.ts       — All shared TypeScript interfaces and types (GameMode, AppState,
                   BoxStatus, Badge, Tag, TiState, EclipseState, etc.)
  state.ts       — The `state` singleton (initial values for all AppState fields)
  currentGame.ts — Neutral holder for the active GameMode instance (avoids circular deps)
  firmware.ts    — Firmware version comparison helpers + fetchLatestFirmware()
  boxes.ts       — Box names, getDisplayName(), box management (add/remove/disconnect),
                   box substitution dialog, setup UI (updateSetupUI), setBoxBadges(),
                   setAutoName()
  websockets.ts  — WebSocket connection, send/sendToBox, message dispatch (handleMessage),
                   RFID enable/disable helpers
  leds.ts        — LED colour helpers (ledSolid, ledOff, ledSectors…), ledStateForStatus(),
                   syncLeds()
  tags.ts        — Loads and expands tags.json into state.allTags; filterTags(game, fn);
                   getRelevantTagsForBox(hwid) — returns context-aware tag list for sim
                   RFID dialog (empty = hide button); delegates to mode.getRelevantTags()
  timers.ts      — Per-player turn timers, phase timing (startPhase/endPhase), formatDuration()
  graphs.ts      — Stats/graphs overlay (openGraphOverlay, renderGraph, renderStats,
                   captureGameStats, snapshotPlayer, renderTimerInfo)
  display.ts     — OLED display sync (syncDisplay); sends { type: 'display', name, status }
                   to each connected real box on every render(); status is a friendly label
                   (e.g. 'Can React') or empty string when idle
  render.ts      — Table rendering (renderBoxes, renderGameControls, renderTableLabel),
                   box cards, drag-to-reorder, name editing, sim toggle, endGame(),
                   setWakeLockHandlers(), isManuallyRenamed()
  game.ts        — Game start (startGame), mode dispatch (handleEndTurn, handlePass,
                   handleLongPress), debug skip
  rfid.ts        — RFID dialog (openRfidDialog uses getRelevantTagsForBox),
                   tag writing flow (buildTagQueue, startTagWriting, handleRfidWriteResult),
                   faction scan (startFactionScan, stopFactionScan), simulateButton()
  ota.ts         — OTA firmware update dialog (openOtaDialog, renderOtaDialog, identifyBox)
  settings.ts    — WiFi credentials dialog + debug logging dialog
  persist.ts     — Game state persistence: localStorage + hub SPIFFS backup (persistState,
                   restoreState, offerResume); compression via CompressionStream (gzip/base64)
  logger.ts      — log() and clearLog() for the event log panel
  init.ts        — Wake lock, battery tip, silent audio keepalive, init() entry point,
                   showBatteryTipIfNeeded(), dismissBatteryTip()
  modes/
    index.ts     — createGameMode(id) factory: maps mode ID string → GameMode instance
    clockwise.ts — ClockwiseMode and ClockwisePassMode classes
    eclipse.ts   — EclipseMode class + upkeep animation; getFactionForBox() helper used
                   by other modules; simple vs advanced turn order is a setup-time setting
                   (state.eclipse.advancedOrder), not a separate game mode
    ti.ts        — TwilightImperiumMode class (all phases: strategy, action, status, agenda)
```

## Module Architecture

- **ES modules via Vite**: all files use `import`/`export`. No globals.
- **Entry point**: `src/main.ts` imports everything and wires DOM event listeners.
- **Circular dependency prevention**: `src/currentGame.ts` is a neutral holder for the active `GameMode` instance. Modules that need to dispatch game events import from `currentGame.ts` rather than from each other.
- **Wake lock injection**: `render.ts` exposes `setWakeLockHandlers(release, audioCtx)`. Called from `init.ts` to inject these without creating a circular import.
- **Dynamic imports**: used for `rfid.ts` (in render.ts sim buttons), `settings.ts` (in websockets.ts wifi handler), `init.ts` (in game.ts and persist.ts for wake lock / silent audio).

## Game Mode Interface

Each game mode is a class implementing `GameMode` from `src/types.ts`:

```typescript
interface GameMode {
  id: string;
  start(): void;
  onEndTurn(hwid: string): void;
  onPass(hwid: string): void;
  onLongPress(hwid: string): void;
  advancePhase?(): void;
  onRfid?(hwid: string, game: string, category: string, id: string): void;
  getRelevantTags(hwid: string): Tag[];
  renderControls(statusLines: string[], actionDefs: ActionDef[]): void;
  debugSkip?(): void;
  onFactionChanged?(): void;
}
```

## Key Exports

- `state` — single source of truth for all game state (`state.ts`)
- `send(msg)` / `sendToBox(hwid, msg)` — WebSocket send helpers (`websockets.ts`)
- `log(message, type)` — append to event log (`logger.ts`)
- `render()` — full UI re-render (`render.ts`)
- `LED_COUNT = 24` — ring LED count per box (`leds.ts`)
- `getFactionForBox(hwid)` — looks up faction data for a box (`modes/eclipse.ts`)

## Architecture Notes

- **Hub/client model**: one ESP32 acts as hub (WebSocket server + connects to app), others are clients that relay through it. The app always talks to the hub.
- **RFID tags**: tags contain an `internalId` string (e.g. `ti:strategy:leadership`, `eclipse:faction:hades`). Defined in `tags.json`, loaded into `state.allTags` by `tags.ts`. The hub writes these via MFRC522 on request; the app drives the write flow via `buildTagQueue(game)` → `startTagWriting()`. Sim RFID options are driven by `getRelevantTagsForBox(hwid)` which delegates to `currentGame.getRelevantTags(hwid)`.
- **Virtual boxes**: simulate real boxes in the browser for testing. `VIRTUAL_BOX_ID_OFFSET = 'virtual-'` prefix.
- **Box names**: stored in `state.boxNames[hwid] = { name?, manual? }`. `manual: true` means user explicitly renamed it (suppresses auto-name from faction scan). `setAutoName(hwid, name)` from `boxes.ts` handles both virtual and real boxes.
