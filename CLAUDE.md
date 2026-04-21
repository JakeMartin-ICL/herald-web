# Herald Web App — Codebase Guide

A TypeScript + Vite app that connects over WebSocket to a Herald hub box and manages turn order for board games.

## File Structure

```
index.html       — Single page app shell + all dialog overlays (no inline onclick handlers)
style.css        — All styles
public/
  factions.json  — Faction data for TI and Eclipse (names, colours, IDs, expansion)
  tags.json      — RFID tag definitions for each game (display name + internalId);
                   wildcard entries { display: "*", id: "game:faction:*" } expand to
                   faction tags at load time using factions.json
  expansions.json — Expansion definitions per game (id + display name)
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
                   syncLeds(); brightness: setBrightness(hwid,value), sendBrightnessToBox(hwid),
                   receiveBoxBrightness(hwid,value)
  tags.ts        — Loads and expands tags.json into state.allTags; filterTags(game, fn)
                   automatically filters faction tags by enabled expansions;
                   getRelevantTagsForBox(hwid) — returns context-aware tag list for sim
                   RFID dialog (empty = hide button); delegates to mode.getRelevantTags()
  expansions.ts  — loadExpansions() fetches expansions.json into state.expansions;
                   isExpansionEnabled(game, expansionId) checks state.selectedExpansions
                   (absent key = all enabled); renderExpansionUI(mode) renders checkboxes
                   in #expansion-row; selection persisted to localStorage 'herald-expansions'
  timers.ts      — Per-player turn timers, phase timing (startPhase/endPhase), formatDuration()
  graphs.ts      — Stats/graphs overlay (openGraphOverlay, openGraphOverlayWithLog, renderGraph,
                   renderStats, renderScores, captureGameStats, snapshotPlayer, renderTimerInfo);
                   'log' graphSource for viewing historical GameLog data; 'Scores' option added
                   dynamically when source is 'log'
  guided-phase.ts — Generic guided phase: startGuidedPhase(steps)/advanceGuidedPhase()/
                   clearGuidedPhase(); state stored in state.guidedPhaseSteps/Index;
                   display.ts reads currentGuidedStep() to override OLED name/status;
                   TI uses it for 8-step status phase walkthrough (guidedStatusPhase toggle)
  display.ts     — OLED display sync (syncDisplay); sends { type: 'display', name, status,
                   round?, timerRunning?, timerSecs? } to each connected real box on every
                   render(); if guided phase active, overrides name/status with current step;
                   extras sent based on per-box DisplayBoxSettings
  countdown.ts      — Countdown timers: sendCountdown/cancelCountdown (send { type:'countdown',
                   durationMs, color } to box); popup for manual start (10s/30s/1m/custom);
                   syncLeds skips countdownActive boxes; auto-countdown in game.ts maybeAutoCountdown()
  display-settings.ts — "Box Settings" dialog: per-box OLED extras (round number, turn timer)
                   and LED brightness (5 steps: 20/40/60/80/100%); per-box toggles + "all boxes"
                   buttons; calls syncDisplay() after OLED changes, setBrightness() for LED changes
  render.ts      — Table rendering (renderBoxes, renderGameControls, renderTableLabel),
                   box cards, drag-to-reorder, name editing, sim toggle,
                   endGame() (opens score-entry dialog), finaliseEndGame() (actual state reset,
                   called by score-entry.ts after log is saved),
                   togglePause() (pauses timers + blanks LEDs; blocked input while paused),
                   setWakeLockHandlers(), isManuallyRenamed()
  game.ts        — Game start (startGame), mode dispatch (handleEndTurn, handlePass,
                   handleLongPress), debug skip; calls snapshotForUndo() before each dispatch
  rfid.ts        — RFID dialog (openRfidDialog uses getRelevantTagsForBox),
                   tag writing flow (buildTagQueue, startTagWriting, handleRfidWriteResult),
                   faction scan (startFactionScan, stopFactionScan), simulateButton()
  hwtest.ts      — Hardware test dialog (openHwTestDialog, closeHwTestDialog); per-box test
                   for End Turn button, Pass button, and RFID scan; intercepts endturn/pass/rfid
                   events via handleHwTestEvent/handleHwTestRfid (called from websockets.ts);
                   lights 1/3 of ring green per passing test using led_thirds; auto-exits after
                   2s delay once all 3 tests pass; sets box.leds to preserve state across syncLeds
  ota.ts         — OTA firmware update dialog (openOtaDialog, renderOtaDialog, identifyBox)
  settings.ts    — WiFi credentials dialog + debug logging dialog
  gamelog.ts     — Game log: buildGameLog() captures full game state before endGame resets it;
                   saveGameLog()/importGameLog()/loadGameLog()/loadGameLogIndex() store logs
                   per-game in localStorage ('herald-game-log-{filename}') plus a lightweight
                   index ('herald-game-logs-index') for history browsing
  github-config.ts — Credentials storage: loadGitHubConfig()/saveGitHubConfig() — localStorage
                   key 'herald-github-config'; no API calls; safe to import anywhere
  gist.ts        — GitHub Gist API: createGist(pat) → new gist ID; syncWithGist(config, onStatus?)
                   → fetches gist, uploads missing local games, downloads missing remote games,
                   patches _index.json atomically; all sync done in the browser
  score-entry.ts — Score entry dialog: intercepts endGame() flow; openScoreEntryDialog(finaliseEndGame)
                   calls buildGameLog() while state is still intact, shows score inputs, then
                   calls finaliseEndGame() + saveGameLog() + auto-sync on confirm/skip;
                   cancelScoreEntry() dismisses without ending the game
  github-settings.ts — GitHub Sync dialog: PAT input, Gist ID field, Create/Save/Sync buttons;
                   saves to localStorage + sends github_config_set to hub via sendSilent
  history-browser.ts — History browser dialog (openHistoryBrowser, closeHistoryBrowser,
                   renderHistoryBrowser); auto-syncs gist on open (silent fail); filter by
                   game mode; clicking a game calls openGraphOverlayWithLog() in graphs.ts
  removePlayer.ts — Remove Player dialog (debug panel): removePlayer(hwid) snapshots undo,
                   sets box.status='disconnected', calls mode.onPlayerRemoved?(), removes from
                   boxOrder (box object kept for stats); each GameMode implements onPlayerRemoved
                   to advance the turn and clean up mode-specific order arrays
  undo.ts        — In-memory undo stack (32 snapshots); snapshotForUndo() called before each
                   game action; undo() restores last snapshot; clearUndoHistory() on game start/end
  persist.ts     — Game state persistence: localStorage + hub SPIFFS backup (persistState,
                   restoreState, offerResume); extractPersistableState + restoreState also used
                   by undo.ts; compression via CompressionStream (gzip/base64)
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
    kemet.ts     — KemetMode class; action phase (5 turns each, sequential) → night phase
                   (guided or manual) → reorder dialog → next round; auto-opens reorder
                   dialog at game start and after each night phase
    inis.ts      — InisMode class; Assembly Phase (6 steps: brenn selection, victory check,
                   advantage cards, Flock of Crows direction, deal cards, draft) → Season
                   Phase (consecutive-pass tracking; round ends when all pass in sequence);
                   uses ASSEMBLY_GREEN led_alternate_pair, getBoxDisplay() for per-box OLED
                   overrides, buildTurnOrder() for CW/ACW from Brenn, updateBrennBadge()
    arcs.ts      — ArcsMode class; tap_leader phase (all RFID enabled, wait for arcs:initiative
                   tag tap) → action phase (clockwise from leader; pass = out permanently this
                   round; cycle ends when cycleRemaining exhausted → tap_leader again) → when
                   all passed: status phase (manual button) → round++ → tap_leader;
                   leader tracked via leaderHwid + gold "Leader" badge; syncRfid/onResume
                   re-enables RFID after undo/resume
    coc.ts       — ClashOfCulturesMode class; first_player phase (simple: all RFID enabled,
                   wait for coc:token:first_player tap → clockwise from scanner; advanced:
                   reorder dialog) → action phase (3 turns each, sequential like Kemet) →
                   status phase (always guided: Complete objectives*, Free advance, Draw 1
                   Action card, Draw 1 Objective card*, Raze size 1 city?, Change government
                   type? — *omitted when disableObjectives enabled) → first_player again;
                   hub end turn advances guided steps, long press skips; advancedOrder +
                   disableObjectives toggles in renderControls
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
  onPlayerRemoved?(hwid: string): void; // called before boxOrder removal; box.status already 'disconnected'
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
