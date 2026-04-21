import { state } from './state';
import { log } from './logger';
import { render } from './render';
import { resetTurnTimers, stopCurrentTimerInterval, needsTimerInterval, startCurrentTimerInterval } from './timers';
import { persistState } from './persist';
import { snapshotForUndo, clearUndoHistory } from './undo';
import { currentGame, setCurrentGame } from './currentGame';
import { createGameMode } from './modes/index';
import { updateSetupUI } from './boxes';

// ---- Game start ----

export function startGame(): void {
  state.gameMode = (document.getElementById('game-mode') as HTMLSelectElement).value;
  const mode = createGameMode(state.gameMode);
  if (!mode) {
    log(`Unknown game mode: ${state.gameMode}`, 'error');
    return;
  }
  const startValidation = mode.getStartValidation?.();
  if (startValidation && !startValidation.valid) {
    log(startValidation.reason ?? `Cannot start ${state.gameMode}`, 'error');
    updateSetupUI();
    return;
  }

  state.gameActive = true;
  (document.getElementById('setup-panel') as HTMLElement).style.display = 'none';
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].badges = [];
  });
  resetTurnTimers();
  clearUndoHistory();
  state.gameStartTime = Date.now();
  state.phaseLog = [];
  state.currentPhaseStart = null;
  stopCurrentTimerInterval();
  if (needsTimerInterval()) startCurrentTimerInterval();
  void import('./init').then(({ requestWakeLock, initSilentAudio, showBatteryTipIfNeeded }) => {
    void requestWakeLock();
    initSilentAudio();
    showBatteryTipIfNeeded();
  });
  log(`Game started: ${state.gameMode} with ${state.boxOrder.length} players`, 'system');
  setCurrentGame(mode);
  mode.start();

  render();
  persistState();
}

// ---- Auto-countdown ----

function maybeAutoCountdown(): void {
  if (!state.autoCountdownSecs || !state.activeBoxId) return;
  const hwid = state.activeBoxId;
  const box = state.boxes[hwid];
  if (!box || box.isVirtual || box.status !== 'active') return;
  const ms = state.autoCountdownSecs * 1000;
  void import('./countdown').then(({ sendCountdown }) => sendCountdown(hwid, ms));
}

// ---- Event dispatch ----

export function handleEndTurn(hwid: string): void {
  if (!state.gameActive) return;
  if (state.paused) return;
  if (state.boxes[hwid]?.status === 'disconnected') return;
  snapshotForUndo();
  currentGame?.onEndTurn(hwid);
  maybeAutoCountdown();
  render();
  persistState();
}

export function handlePass(hwid: string): void {
  if (!state.gameActive) return;
  if (state.paused) return;
  if (state.boxes[hwid]?.status === 'disconnected') return;
  snapshotForUndo();
  currentGame?.onPass(hwid);
  maybeAutoCountdown();
  render();
  persistState();
}

export function handleLongPress(hwid: string): void {
  if (!state.gameActive) return;
  if (state.paused) return;
  snapshotForUndo();
  currentGame?.onLongPress(hwid);
  render();
}

// ---- Debug ----

export function toggleDebug(): void {
  const panel = document.getElementById('debug-panel') as HTMLElement;
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

export function debugSkipPhase(): void {
  if (!state.gameActive) {
    log('[DEBUG] No active game', 'system');
    return;
  }
  if (!currentGame?.debugSkip) {
    log('[DEBUG] Skip not supported for this game mode', 'system');
    render();
    return;
  }
  currentGame.debugSkip();
  render();
}
