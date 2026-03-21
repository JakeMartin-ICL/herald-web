// ---- Game logic dispatch ----

function startGame() {
  state.gameActive = true;
  document.getElementById('setup-panel').style.display = 'none';
  state.gameMode = document.getElementById('game-mode').value;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].badges = [];
  });
  resetTurnTimers();
  state.gameStartTime = Date.now();
  state.phaseLog = [];
  state.currentPhaseStart = null;
  stopCurrentTimerInterval();
  if (needsTimerInterval()) startCurrentTimerInterval();
  requestWakeLock();
  initSilentAudio();
  showBatteryTipIfNeeded();
  log(`Game started: ${state.gameMode} with ${state.boxOrder.length} players`, 'system');
  gameModeStart();
  render();
  persistState();
}

function gameModeStart() {
  switch (state.gameMode) {
    case 'clockwise':
    case 'clockwise_pass':
      clockwiseStart();
      break;
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseStart();
      break;
    case 'ti':
      tiStart();
      break;
  }
}

function handleEndTurn(hwid) {
  if (!state.gameActive) return;
  if (state.boxes[hwid]?.status === 'disconnected') return;
  switch (state.gameMode) {
    case 'clockwise':
    case 'clockwise_pass':
      clockwiseEndTurn(hwid);
      break;
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseEndTurn(hwid);
      break;
    case 'ti':
      tiEndTurn(hwid);
      break;
  }
  persistState();
}

function handlePass(hwid) {
  if (!state.gameActive) return;
  if (state.boxes[hwid]?.status === 'disconnected') return;
  switch (state.gameMode) {
    case 'clockwise_pass':
      clockwisePass(hwid);
      break;
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipsePass(hwid);
      break;
    case 'ti':
      tiPass(hwid);
      break;
  }
  persistState();
}

function handleLongPress(hwid) {
  if (!state.gameActive) return;
  switch (state.gameMode) {
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseLongPress(hwid);
      break;
    case 'ti':
      tiLongPress(hwid);
      break;
  }
}

// ---- Phase advance ----

function advancePhase() {
  // UI button bypasses hub restriction — directly call phase logic
  switch (state.gameMode) {
    case 'ti':
      tiAdvancePhase();
      break;
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseAdvancePhase();
      break;
  }
  render();
  persistState();
}

function tiAdvancePhase() {
  switch (state.ti.phase) {
    case 'status':
      if (state.ti.mecatolControlled) {
        tiStartAgendaPhase();
      } else {
        tiEndRound();
      }
      break;
    case 'status2':
      tiEndRound();
      break;
    case 'agenda_reveal':
    case 'when_agenda_revealed':
    case 'after_agenda_revealed':
    case 'agenda_vote':
      tiAdvanceAgendaPhase();
      break;
  }
}

// ---- Debug ----

function toggleDebug() {
  const panel = document.getElementById('debug-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function debugSkipPhase() {
  if (!state.gameActive) {
    log('[DEBUG] No active game', 'system');
    return;
  }

  if (state.gameMode === 'ti') {
    const phase = state.ti.phase;
    log(`[DEBUG] Skipping TI phase: ${phase}`, 'system');
    // Reset all box statuses and secondary state before jumping
    state.boxOrder.forEach(hwid => { state.boxes[hwid].status = 'idle'; });
    state.activeBoxId = null;
    state.ti.secondary = null;

    switch (phase) {
      case 'strategy': tiStartActionPhase(); break;
      case 'action':   tiStartStatusPhase(); break;
      case 'status':
        if (state.ti.mecatolControlled) tiStartAgendaPhase();
        else tiEndRound();
        break;
      case 'agenda_reveal': tiStartAgendaWhen(); break;
      case 'when_agenda_revealed':   tiStartAgendaAfter(); break;
      case 'after_agenda_revealed':  tiStartAgendaVote(); break;
      case 'agenda_vote':   tiStartStatusPhase(true); break;
      case 'status2':       tiEndRound(); break;
      default: log('[DEBUG] Unknown TI phase', 'system');
    }
  } else if (state.gameMode.startsWith('eclipse')) {
    const phase = state.eclipse.phase;
    log(`[DEBUG] Skipping Eclipse phase: ${phase}`, 'system');
    switch (phase) {
      case 'action': eclipseEndActionPhase(); break;
      case 'combat': eclipseStartUpkeep(); break;
      case 'upkeep': eclipseEndRound(); break;
      default: log('[DEBUG] Unknown Eclipse phase', 'system');
    }
  } else {
    log('[DEBUG] Skip not supported for this game mode', 'system');
  }

  render();
}

