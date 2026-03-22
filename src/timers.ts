import { state } from './state';
import { renderBoxes, renderTableLabel } from './render';

export const timerSettings = { showCurrent: false, showTotal: false, showGameTimer: false };

let _timerTrackedActiveId: string | null = null;
let _currentTimerInterval: ReturnType<typeof setInterval> | null = null;

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  return `${rs}s`;
}

export function getCurrentRound(): number | null {
  return state.round || null;
}

function onTurnStart(hwid: string): void {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].turnStartTime = Date.now();
}

function onTurnEnd(hwid: string): void {
  const box = state.boxes[hwid];
  if (!box?.turnStartTime) return;
  const elapsed = Date.now() - box.turnStartTime;
  box.totalTurnTime = (box.totalTurnTime ?? 0) + elapsed;
  box.turnHistory ??= [];
  if (elapsed > 0) box.turnHistory.push({ duration: elapsed, round: getCurrentRound() });
  box.turnStartTime = null;
}

export function updateTurnTimers(): void {
  const current = state.activeBoxId;
  if (current === _timerTrackedActiveId) return;
  if (_timerTrackedActiveId) onTurnEnd(_timerTrackedActiveId);
  if (current) onTurnStart(current);
  _timerTrackedActiveId = current;
}

export function substituteTimerTracking(oldHwid: string, newHwid: string): void {
  if (_timerTrackedActiveId === oldHwid) _timerTrackedActiveId = newHwid;
}

export function resetTurnTimers(): void {
  _timerTrackedActiveId = null;
  state.boxOrder.forEach(hwid => {
    if (state.boxes[hwid]) {
      state.boxes[hwid].turnStartTime = null;
      state.boxes[hwid].totalTurnTime = 0;
      state.boxes[hwid].turnHistory = [];
    }
  });
}

export function startCurrentTimerInterval(): void {
  if (_currentTimerInterval) return;
  _currentTimerInterval = setInterval(() => {
    if (!state.gameActive) return;
    if (timerSettings.showCurrent) renderBoxes();
    if (timerSettings.showGameTimer) renderTableLabel();
  }, 1000);
}

export function stopCurrentTimerInterval(): void {
  if (_currentTimerInterval) { clearInterval(_currentTimerInterval); _currentTimerInterval = null; }
}

export function needsTimerInterval(): boolean {
  return timerSettings.showCurrent || timerSettings.showGameTimer;
}

// ---- Phase timing ----

export function startPhase(name: string): void {
  endPhase();
  state.currentPhaseStart = { name, startTime: Date.now() };
}

export function endPhase(): void {
  if (!state.currentPhaseStart) return;
  const duration = Date.now() - state.currentPhaseStart.startTime;
  state.phaseLog.push({ phase: state.currentPhaseStart.name, duration, round: state.round });
  state.currentPhaseStart = null;
}
