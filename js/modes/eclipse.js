// ---- Eclipse mode ----

function eclipseStart() {
  const firstPlayerId = document.getElementById('first-player').value;
  state.eclipse.firstPlayerId = firstPlayerId;
  state.eclipse.passOrder = [];
  state.eclipse.phase = 'action';
  state.round = 1;
  state.totalRounds = 8;
  startPhase('action');
  eclipseBuildTurnOrder(firstPlayerId);
  eclipseActivateNext();
  log(`Eclipse started — ${getDisplayName(firstPlayerId)} goes first`, 'system');
  updateEclipseBadges();
}

function eclipseBuildTurnOrder(firstPlayerId) {
  if (state.gameMode === 'eclipse_advanced' && state.eclipse.passOrder.length > 0) {
    state.eclipse.turnOrder = [...state.eclipse.passOrder];
  } else {
    const firstIndex = state.boxOrder.indexOf(firstPlayerId);
    state.eclipse.turnOrder = [
      ...state.boxOrder.slice(firstIndex),
      ...state.boxOrder.slice(0, firstIndex),
    ].filter(id => state.boxes[id].status !== 'disconnected');
  }
}

function eclipseActivateNext() {
  const current = state.activeBoxId;
  const order = state.eclipse.turnOrder;
  const currentIndex = current !== null ? order.indexOf(current) : -1;

  for (let i = 1; i <= order.length; i++) {
    const nextIndex = (currentIndex + i) % order.length;
    const nextId = order[nextIndex];
    const status = state.boxes[nextId]?.status;

    if (status === 'idle') {
      if (current !== null && state.boxes[current]?.status === 'idle') {
        state.boxes[current].status = 'idle';
      }
      disableAllRfid();
      state.activeBoxId = nextId;
      enableRfid(nextId);
      state.boxes[nextId].status = 'active';
      log(`${getDisplayName(nextId)}'s turn`, 'system');
      return;
    }

    if (status === 'can-react') {
      if (current !== null && state.boxes[current]?.status === 'idle') {
        state.boxes[current].status = 'idle';
      }
      disableAllRfid();
      state.activeBoxId = nextId;
      enableRfid(nextId);
      state.boxes[nextId].status = 'reacting';
      log(`${getDisplayName(nextId)} reaction opportunity`, 'system');
      return;
    }
  }

  eclipseEndActionPhase();
}

function eclipseEndTurn(hwid) {
  if (hwid !== state.activeBoxId) return;
  const box = state.boxes[hwid];

  if (box.status === 'reacting') {
    box.status = 'can-react';
    log(`${getDisplayName(hwid)} reaction done`, 'system');
  } else {
    box.status = 'idle';
  }

  eclipseActivateNext();
}

function eclipsePass(hwid) {
  if (hwid !== state.activeBoxId) return;
  const box = state.boxes[hwid];

  if (box.status === 'reacting') {
    box.status = 'passed';
    log(`${getDisplayName(hwid)} opts out of reactions`, 'system');
  } else if (box.status === 'active') {
    box.status = 'can-react';
    state.eclipse.passOrder.push(hwid);
    log(`${getDisplayName(hwid)} passes`, 'system');
  }

  const actionOver = state.boxOrder.every(id =>
    state.boxes[id].status === 'can-react' ||
    state.boxes[id].status === 'passed' ||
    state.boxes[id].status === 'disconnected'
  );

  if (actionOver) {
    eclipseEndActionPhase();
  } else {
    eclipseActivateNext();
  }
}

function eclipseEndActionPhase() {
  log('Action phase over — combat!', 'system');
  state.eclipse.phase = 'combat';
  startPhase('combat');
  disableAllRfid();
  state.activeBoxId = null;
  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'combat';
    }
  });
}

function eclipseAdvancePhase() {
  switch (state.eclipse.phase) {
    case 'combat':  eclipseStartUpkeep(); break;
    case 'upkeep':  eclipseEndRound(); break;
  }
}

function eclipseLongPress(hwid) {
  if (hwid !== state.hubHwid) return;
  eclipseAdvancePhase();
}

// ---- Upkeep animation ----

const UPKEEP_GOLD  = '#d4a017';
const UPKEEP_PINK  = '#e64da0';
const UPKEEP_BROWN = '#cc7700';

function buildUpkeepFrames() {
  const N = LED_COUNT;
  const T = N / 3; // 8 LEDs per third
  const OFF = '#000000';
  const frames = [];

  // 1. Brief reset
  frames.push({ leds: Array(N).fill(OFF), duration: 100 });

  // 2. Gold third fills clockwise one LED at a time
  for (let i = 1; i <= T; i++) {
    const leds = Array(N).fill(OFF);
    for (let j = 0; j < i; j++) leds[j] = UPKEEP_GOLD;
    frames.push({ leds, duration: 80 });
  }

  // 3. Pause — players do gold upkeep
  const afterGold = Array(N).fill(OFF);
  for (let j = 0; j < T; j++) afterGold[j] = UPKEEP_GOLD;
  frames.push({ leds: [...afterGold], duration: 2000 });

  // 4. Science (pink) fills clockwise, then materials (brown) fills clockwise
  for (let i = 1; i <= T; i++) {
    const leds = [...afterGold];
    for (let j = 0; j < i; j++) leds[T + j] = UPKEEP_PINK;
    frames.push({ leds, duration: 80 });
  }
  const afterPink = [...afterGold];
  for (let j = 0; j < T; j++) afterPink[T + j] = UPKEEP_PINK;
  for (let i = 1; i <= T; i++) {
    const leds = [...afterPink];
    for (let j = 0; j < i; j++) leds[T * 2 + j] = UPKEEP_BROWN;
    frames.push({ leds, duration: 80 });
  }

  // 5. Hold full ring
  const full = [...afterGold];
  for (let j = 0; j < T; j++) {
    full[T + j]     = UPKEEP_PINK;
    full[T * 2 + j] = UPKEEP_BROWN;
  }
  frames.push({ leds: full, duration: 5000 });

  return frames;
}

let upkeepAnimTimer = null;

function startUpkeepAnimation() {
  stopUpkeepAnimation();
  const frames = buildUpkeepFrames();
  let frameIndex = 0;

  function tick() {
    if (!state.gameActive || state.eclipse.phase !== 'upkeep') return;
    const { leds, duration } = frames[frameIndex];
    frameIndex = (frameIndex + 1) % frames.length;
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (box?.status === 'upkeep') {
        box.leds = leds;
        if (!box.isVirtual) sendToBox(hwid, { type: 'led', leds });
      }
    });
    renderBoxes();
    upkeepAnimTimer = setTimeout(tick, duration);
  }

  tick();
}

function stopUpkeepAnimation() {
  if (upkeepAnimTimer !== null) {
    clearTimeout(upkeepAnimTimer);
    upkeepAnimTimer = null;
  }
}

function eclipseStartUpkeep() {
  log('Upkeep phase', 'system');
  state.eclipse.phase = 'upkeep';
  startPhase('upkeep');
  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'upkeep';
    }
  });
  startUpkeepAnimation();
}

function eclipseEndRound() {
  stopUpkeepAnimation();
  state.round++;

  if (state.round > state.totalRounds) {
    log(`Game over after ${state.totalRounds} rounds!`, 'system');
    endPhase();
    captureGameStats();
    state.gameActive = false;
    state.eclipse.phase = null;
    state.boxOrder.forEach(id => {
      state.boxes[id].status = 'idle';
      state.boxes[id].factionId = null;
    });
    state.activeBoxId = null;
    document.getElementById('start-btn').disabled = false;
    render();
    return;
  }

  log(`Round ${state.round} begins`, 'system');
  state.eclipse.phase = 'action';
  startPhase('action');

  const nextFirst = state.eclipse.passOrder.length > 0
    ? state.eclipse.passOrder[0]
    : state.eclipse.firstPlayerId;

  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'idle';
    }
  });

  state.activeBoxId = null;
  state.eclipse.firstPlayerId = nextFirst;
  eclipseBuildTurnOrder(nextFirst);
  state.eclipse.passOrder = [];
  eclipseActivateNext();
  log(`New round — ${getDisplayName(nextFirst)} goes first`, 'system');
  updateEclipseBadges();
}

// ---- Eclipse badges ----

function updateEclipseBadges() {
}
