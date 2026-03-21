# Herald Web App — Codebase Guide

A plain HTML/CSS/JS app (no build tool) that connects over WebSocket to a Herald hub box and manages turn order for board games.

## File Structure

```
index.html       — Single page app shell + all dialog overlays
style.css        — All styles
factions.json    — Faction data for TI and Eclipse (names, colours, IDs)
tags.json        — RFID tag definitions for each game (display name + internalId);
                   wildcard entries { display: "*", id: "game:faction:*" } expand to
                   faction tags at load time using factions.json
js/
  state.js       — Global constants (VIRTUAL_BOX_ID_OFFSET etc.) and the `state` object
  firmware.js    — Firmware version comparison helpers + fetchLatestFirmware()
  boxes.js       — Box names, getDisplayName(), box management (add/remove/disconnect),
                   box substitution dialog, setup UI (updateSetupUI)
  websockets.js  — WebSocket connection, send/sendToBox, message dispatch (handleMessage),
                   RFID enable/disable helpers
  leds.js        — LED colour helpers (ledSolid, ledOff, ledSectors…), ledStateForStatus(),
                   syncLeds()
  tags.js        — Loads and expands tags.json into state.allTags; filterTags(game, fn);
                   getRelevantTagsForBox(hwid) — returns context-aware tag list for sim
                   RFID dialog (empty = hide button); delegates to mode-specific
                   *RelevantTags(hwid) functions
  timers.js      — Per-player turn timers, phase timing (startPhase/endPhase), formatDuration()
  graphs.js      — Stats/graphs overlay (openGraphOverlay, renderGraph, renderStats,
                   captureGameStats, snapshotPlayer)
  render.js      — Table rendering (renderBoxes, renderGameControls, renderTableLabel),
                   box cards, drag-to-reorder, name editing, sim toggle
  game.js        — Game start/end (startGame, endGame), mode dispatch (handleEndTurn,
                   handlePass, handleLongPress), phase advance, debug skip
  rfid.js        — RFID dialog (openRfidDialog uses getRelevantTagsForBox),
                   tag writing flow (buildTagQueue, startTagWriting, handleRfidWriteResult),
                   faction scan, faction display helpers
  ota.js         — OTA firmware update dialog (openOtaDialog, renderOtaDialog, identifyBox)
  settings.js    — WiFi credentials dialog + debug logging dialog
  persist.js     — Game state persistence: localStorage + hub SPIFFS backup (persistState,
                   restoreState, offerResume); compression via CompressionStream (gzip/base64)
  init.js        — log(), setStatus(), wake lock, battery tip, silent audio keepalive,
                   init() entry point, loadFactions(), loadTags()
  modes/
    clockwise.js — Clockwise and Clockwise with Passing game mode
    eclipse.js   — Eclipse game mode + upkeep animation + eclipseRelevantTags(hwid);
                   simple vs advanced turn order is a setup-time setting
                   (state.eclipse.advancedOrder), not a separate game mode
    ti.js        — Twilight Imperium game mode (all phases: strategy, action, status, agenda)
                   + tiRelevantTags(hwid)
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
- **RFID tags**: tags contain an `internalId` string (e.g. `ti:strategy:leadership`, `eclipse:faction:hades`). Defined in `tags.json`, loaded into `state.allTags` by `tags.js`. The hub writes these via MFRC522 on request; the app drives the write flow via `buildTagQueue(game)` → `startTagWriting()`. Sim RFID options are driven by `getRelevantTagsForBox(hwid)` which returns only contextually relevant tags (e.g. active player's strategy cards during TI strategy phase).
- **Virtual boxes**: simulate real boxes in the browser for testing. `VIRTUAL_BOX_ID_OFFSET = 'virtual-'` prefix.
