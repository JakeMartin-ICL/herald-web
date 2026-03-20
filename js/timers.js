// ---- Turn timers ----

const timerSettings = { showCurrent: false, showTotal: false, showGameTimer: false };
let _timerTrackedActiveId = null;
let _currentTimerInterval = null;

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  return `${rs}s`;
}

function onTurnStart(hwid) {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].turnStartTime = Date.now();
}

function getCurrentRound() {
  return state.round || null;
}

function onTurnEnd(hwid) {
  const box = state.boxes[hwid];
  if (!box || !box.turnStartTime) return;
  const elapsed = Date.now() - box.turnStartTime;
  box.totalTurnTime = (box.totalTurnTime || 0) + elapsed;
  if (!box.turnHistory) box.turnHistory = [];
  if (elapsed > 0) box.turnHistory.push({ duration: elapsed, round: getCurrentRound() });
  box.turnStartTime = null;
}

function updateTurnTimers() {
  const current = state.activeBoxId;
  if (current === _timerTrackedActiveId) return;
  if (_timerTrackedActiveId) onTurnEnd(_timerTrackedActiveId);
  if (current) onTurnStart(current);
  _timerTrackedActiveId = current;
}

function resetTurnTimers() {
  _timerTrackedActiveId = null;
  state.boxOrder.forEach(hwid => {
    if (state.boxes[hwid]) {
      state.boxes[hwid].turnStartTime = null;
      state.boxes[hwid].totalTurnTime = 0;
      state.boxes[hwid].turnHistory = [];
    }
  });
}

function startCurrentTimerInterval() {
  if (_currentTimerInterval) return;
  _currentTimerInterval = setInterval(() => {
    if (!state.gameActive) return;
    if (timerSettings.showCurrent) renderBoxes();
    if (timerSettings.showGameTimer) renderTableLabel();
  }, 1000);
}

function stopCurrentTimerInterval() {
  if (_currentTimerInterval) { clearInterval(_currentTimerInterval); _currentTimerInterval = null; }
}

function needsTimerInterval() {
  return timerSettings.showCurrent || timerSettings.showGameTimer;
}

// ---- Phase timing ----

function startPhase(name) {
  endPhase();
  state.currentPhaseStart = { name, startTime: Date.now() };
}

function endPhase() {
  if (!state.currentPhaseStart) return;
  const duration = Date.now() - state.currentPhaseStart.startTime;
  state.phaseLog.push({ phase: state.currentPhaseStart.name, duration, round: state.round });
  state.currentPhaseStart = null;
}
