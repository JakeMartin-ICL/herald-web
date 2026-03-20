# Herald Web App — Codebase Guide

A plain HTML/CSS/JS app (no build tool) that connects over WebSocket to a Herald hub box and manages turn order for board games.

## File Structure

```
index.html       — Single page app shell + all dialog overlays
style.css        — All styles
factions.json    — Faction data for TI and Eclipse (names, colours, IDs)
js/
  state.js       — Global constants (VIRTUAL_BOX_ID_OFFSET etc.) and the `state` object
  firmware.js    — Firmware version comparison helpers + fetchLatestFirmware()
  boxes.js       — Box names, getDisplayName(), box management (add/remove/disconnect),
                   box substitution dialog, setup UI (updateSetupUI)
  websockets.js  — WebSocket connection, send/sendToBox, message dispatch (handleMessage),
                   RFID enable/disable helpers
  leds.js        — LED colour helpers (ledSolid, ledOff, ledSectors…), ledStateForStatus(),
                   syncLeds()
  timers.js      — Per-player turn timers, phase timing (startPhase/endPhase), formatDuration()
  graphs.js      — Stats/graphs overlay (openGraphOverlay, renderGraph, renderStats,
                   captureGameStats, snapshotPlayer)
  render.js      — Table rendering (renderBoxes, renderGameControls, renderTableLabel),
                   box cards, drag-to-reorder, name editing, sim toggle
  game.js        — Game start/end (startGame, endGame), mode dispatch (handleEndTurn,
                   handlePass, handleLongPress), phase advance, debug skip
  rfid.js        — RFID dialog, tag writing flow (startTagWriting, handleRfidWriteResult),
                   faction scan, faction display helpers, simulator helpers
  ota.js         — OTA firmware update dialog (openOtaDialog, renderOtaDialog, identifyBox)
  settings.js    — WiFi credentials dialog + debug logging dialog
  init.js        — log(), setStatus(), wake lock, battery tip, silent audio keepalive,
                   init() entry point, loadFactions()
  modes/
    clockwise.js — Clockwise and Clockwise with Passing game mode
    eclipse.js   — Eclipse (Simple + Advanced) game mode + upkeep animation
    ti.js        — Twilight Imperium game mode (all phases: strategy, action, status, agenda)
```

## Script Load Order

Scripts must be loaded in dependency order. `state.js` first (defines the `state` global everything else reads), `init.js` last (defines `init()`), then an inline `<script>init();</script>` to kick off. No module system — all globals are plain `var`/`let`/`const` at file scope.

## Key Globals

- `state` — single source of truth for all game state (defined in `state.js`)
- `send(msg)` / `sendToBox(hwid, msg)` — WebSocket send helpers (`websockets.js`)
- `log(message, type)` — append to event log (`init.js`)
- `render()` — full UI re-render (`render.js`)
- `LED_COUNT = 24` — ring LED count per box (`leds.js`)

## Architecture Notes

- **Hub/client model**: one ESP32 acts as hub (WebSocket server + connects to app), others are clients that relay through it. The app always talks to the hub.
- **Game modes**: each mode has `*Start`, `*EndTurn`, `*Pass`, `*LongPress` functions in `modes/`. `game.js` dispatches to them.
- **RFID tags**: tags contain an `internalId` string (e.g. `ti:strategy:leadership`, `eclipse:faction:hades`). The hub writes these via MFRC522 on request; the app drives the write flow.
- **Virtual boxes**: simulate real boxes in the browser for testing. `VIRTUAL_BOX_ID_OFFSET = 'virtual-'` prefix.
