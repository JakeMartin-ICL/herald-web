// ---- Constants ----

const VIRTUAL_BOX_ID_OFFSET = 'virtual-';
const RECONNECT_INTERVAL_MS = 5000;

// ---- State ----

const state = {
  connected: false,
  gameActive: false,
  gameMode: 'clockwise',
  boxes: {},        // keyed by hwid
  boxOrder: [],     // hwiDs in seat order
  activeBoxId: null,
  nextVirtualIndex: 0,
  hubHwid: null,

  // Box display names — persisted in localStorage
  // hwid -> { name }
  boxNames: JSON.parse(localStorage.getItem('herald-box-names') || '{}'),

  // Eclipse state
  eclipse: {
    phase: null,
    passOrder: [],
    turnOrder: [],
    firstPlayerId: null,
    round: 0,
  },

  ti: {
  phase: null,        // 'strategy', 'action', 'status', 'agenda', 'status2'
  round: 0,
  speakerHwid: null,
  turnOrder: [],      // sorted by initiative during action phase
  secondaryMode: 'fast', // 'fastest', 'fast', 'standard'
  mecatolControlled: false,

  // Per-player TI state, keyed by hwid
  players: {},
  // {
  //   hwid,
  //   strategyCards: [],  // [{ id, name, color, initiative, used }]
  //   passed: false,
  //   confirmedSecondary: false,
  // }

  // Tag mappings — persisted in localStorage
  // tagId -> { type: 'strategy'|'speaker'|'homesystem', id, label, color, initiative }
  tagMap: JSON.parse(localStorage.getItem('herald-ti-tags') || '{}'),

  // Active secondary state
  secondary: null,
  // {
  //   activeHwid,     // who played the strategy card
  //   cardId,         // which card
  //   cardColor,      // for lighting
  //   pendingHwids,   // who still needs to confirm
  // }
},
};

// ---- Box name persistence ----

function saveBoxNames() {
  localStorage.setItem('herald-box-names', JSON.stringify(state.boxNames));
}

function getBoxName(hwid) {
  return state.boxNames[hwid]?.name || null;
}

function setBoxName(hwid, name) {
  if (!state.boxNames[hwid]) state.boxNames[hwid] = {};
  state.boxNames[hwid].name = name;
  saveBoxNames();
}

function defaultBoxName(hwid) {
  // Generate default name based on seat position
  const index = state.boxOrder.indexOf(hwid);
  return `Player ${index + 1}`;
}

function saveTiTags() {
  localStorage.setItem('herald-ti-tags', JSON.stringify(state.ti.tagMap));
}

// ---- WebSocket ----

let ws = null;
let reconnectTimer = null;

function toggleConnect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    disconnect();
  } else {
    connect();
  }
}

function connect() {
  const address = document.getElementById('hub-address').value.trim();
  setStatus('connecting');
  log(`Connecting to ${address}...`, 'system');

  ws = new WebSocket(`ws://${address}`);

  ws.onopen = () => {
    send({ type: 'hello', client: 'app' });
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onerror = () => {
    setStatus('disconnected');
    log('Connection error', 'error');
  };

  ws.onclose = () => {
    setStatus('disconnected');
    log('Disconnected from hub', 'system');
    document.getElementById('connect-btn').textContent = 'Connect';
    ws = null;
    render();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Attempting reconnect...', 'system');
      connect();
    }
  }, RECONNECT_INTERVAL_MS);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) ws.close();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    log(`→ ${JSON.stringify(msg)}`, 'sent');
  }
}

function sendToBox(hwid, msg) {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
    handleBoxCommand(hwid, msg);
    return;
  }
  send({ ...msg, hwid });
}

// ---- Message handling ----

function handleMessage(msg) {
  if (msg.type !== 'hello_ack') {
    log(`← ${JSON.stringify(msg)}`, 'received');
  }

  switch (msg.type) {
    case 'hello_ack':
      setStatus('connected');
      log('Connected to hub', 'system');
      document.getElementById('connect-btn').textContent = 'Disconnect';
      // Resync LED state if game is active
      if (state.gameActive) {
        syncLeds();
      }
      break;
    case 'connected':
      addBox(msg.hwid, false);
      break;
    case 'disconnected':
      handleBoxDisconnect(msg.hwid);
      break;
    case 'endturn':
      handleEndTurn(msg.hwid);
      break;
    case 'pass':
      handlePass(msg.hwid);
      break;
    case 'longpress':
      handleLongPress(msg.hwid);
      break;
    case 'rfid':
      handleRfid(msg.hwid, msg.tagId);
      break;
  }

  render();
}

// ---- Box command handler (virtual boxes) ----

function handleBoxCommand(hwid, msg) {
  // Virtual boxes derive appearance from status, nothing to do here
}

// ---- Box management ----

function addBox(hwid, isVirtual) {
  console.log('addBox called', hwid, 'existing:', !!state.boxes[hwid], 'boxOrder:', state.boxOrder);
  if (state.boxes[hwid]) {
    // Box reconnected — update status
    state.boxes[hwid].status = 'idle';
    log(`Box ${getDisplayName(hwid)} reconnected`, 'system');
    // Resync its LED if game active
    if (state.gameActive) syncLeds();
    updateSetupUI();
    render();
    return;
  }

  if (!isVirtual && !state.hubHwid) {
    state.hubHwid = hwid;
    log(`Hub identified: ${getDisplayName(hwid)}`, 'system');
  }

  // Assign default name if not previously seen
  const seatIndex = state.boxOrder.length;
  if (!isVirtual && !getBoxName(hwid)) {
    setBoxName(hwid, `Player ${seatIndex + 1}`);
  }

  state.boxes[hwid] = {
    hwid,
    isVirtual,
    status: 'idle',
  };
  state.boxOrder.push(hwid);
  log(`${isVirtual ? 'Virtual box' : 'Box'} ${getDisplayName(hwid)} connected`, 'system');
  updateSetupUI();
  render();
}

function handleBoxDisconnect(hwid) {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].status = 'disconnected';
  log(`Box ${getDisplayName(hwid)} disconnected`, 'system');
  updateSetupUI();
}

function removeBox(hwid) {
  if (!state.boxes[hwid]) return;
  delete state.boxes[hwid];
  state.boxOrder = state.boxOrder.filter(b => b !== hwid);
  if (state.activeBoxId === hwid) state.activeBoxId = null;
  updateSetupUI();
}

function addVirtualBox() {
  const hwid = `${VIRTUAL_BOX_ID_OFFSET}${state.nextVirtualIndex++}`;
  addBox(hwid, true);
}

function getDisplayName(hwid) {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
    const index = state.boxOrder.indexOf(hwid);
    return `Player ${index + 1}`;
  }
  return getBoxName(hwid) || defaultBoxName(hwid);
}

// ---- Setup UI ----

function onGameModeChange() {
  updateSetupUI();
}

function updateSetupUI() {
  const count = Object.keys(state.boxes).length;
  const mode = document.getElementById('game-mode').value;
  const isEclipse = mode.startsWith('eclipse');
  const isTi = mode === 'ti';

  document.getElementById('player-count').textContent =
    `${count} box${count !== 1 ? 'es' : ''} connected`;
  document.getElementById('start-btn').disabled =
    count < 2 || state.gameActive;

  // Eclipse rows
  document.getElementById('first-player-row').style.display = isEclipse ? 'flex' : 'none';
  document.getElementById('eclipse-mode-row').style.display = isEclipse ? 'flex' : 'none';

  // TI rows
  document.getElementById('ti-speaker-row').style.display = isTi ? 'flex' : 'none';
  document.getElementById('ti-secondary-row').style.display = isTi ? 'flex' : 'none';
  document.getElementById('ti-learn-tags-btn').style.display = isTi ? 'block' : 'none';

  if (isEclipse) {
    const select = document.getElementById('first-player');
    select.innerHTML = state.boxOrder.map(hwid =>
      `<option value="${hwid}">${getDisplayName(hwid)}</option>`
    ).join('');
  }

  if (isTi) {
    const select = document.getElementById('ti-speaker');
    select.innerHTML = state.boxOrder.map(hwid =>
      `<option value="${hwid}">${getDisplayName(hwid)}</option>`
    ).join('');
  }
}

// ---- LED helpers ----

const LED_COUNT = 24;

function ledSolid(n, color) {
  return Array(n).fill(color);
}

function ledAlternate(n, color) {
  return Array.from({ length: n }, (_, i) => i % 2 === 0 ? color : '#000000');
}

function ledThirds(n, a, b, c) {
  return Array.from({ length: n }, (_, i) => {
    const third = Math.floor(i / (n / 3));
    return [a, b, c][third];
  });
}

function ledOff(n) {
  return Array(n).fill('#000000');
}

function ledRainbow(n) {
  return Array.from({ length: n }, (_, i) => {
    const hue = Math.round((i / n) * 360);
    return `hsl(${hue}, 100%, 50%)`;
  });
}

function ledAlternatePair(n, a, b) {
  return Array.from({ length: n }, (_, i) => i % 2 === 0 ? a : b);
}

function ledHalf(n, color, first) {
  return Array.from({ length: n }, (_, i) => (i < n / 2) === first ? color : '#000000');
}

function ledSectors(n, colors) {
  const count = colors.length;
  return Array.from({ length: n }, (_, i) => {
    const sector = Math.floor(i / (n / count));
    return colors[Math.min(sector, count - 1)];
  });
}

function ledStateForStatus(status, box = null) {
  switch (status) {
    case 'active':       return ledSolid(LED_COUNT, '#c9a84c');
    case 'can-react':    return ledOff(LED_COUNT);
    case 'reacting':     return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':       return ledSolid(LED_COUNT, '#1a1a3a');
    case 'combat':       return ledSolid(LED_COUNT, '#8a0000');
    case 'upkeep':       return ledThirds(LED_COUNT, '#ff69b4', '#ffff00', '#ffa500');
    case 'disconnected': return ledOff(LED_COUNT);
    case 'choosing':     return box?.choosingLeds || ledRainbow(LED_COUNT);
    case 'strategy':     return ledSolid(LED_COUNT, box?.strategyColor || '#ffffff');
    case 'secondary':    return ledAlternate(LED_COUNT, box?.strategyColor || '#ffffff');
    case 'status':       return ledSolid(LED_COUNT, '#8a0000');
    case 'status2':      return ledSolid(LED_COUNT, '#8a0000');
    case 'agenda_speaker': return ledAlternatePair(LED_COUNT, '#4444ff', '#ffffff');
    case 'when_agenda_revealed':  return ledHalf(LED_COUNT, '#ff6600', false);
    case 'after_agenda_revealed': return ledHalf(LED_COUNT, '#ff6600', true);
    case 'agenda_vote':  return ledSolid(LED_COUNT, '#0000ff');
    default:             return state.gameActive ? ledOff(LED_COUNT) : ledRainbow(LED_COUNT);
  }
}

function syncLeds() {
  const now = Date.now();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
    const leds = ledStateForStatus(box.status, box);
    box.leds = leds;
    if (!box.isVirtual) {
      sendToBox(hwid, { type: 'led', leds });
    }
  });
}

// ---- Game logic dispatch ----

function startGame() {
  state.gameActive = true;
  document.getElementById('setup-panel').style.display = 'none';
  state.gameMode = document.getElementById('game-mode').value;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].badges = [];
  });
  requestWakeLock();
  log(`Game started: ${state.gameMode} with ${state.boxOrder.length} players`, 'system');
  gameModeStart();
  render();
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

// ---- Clockwise mode ----

function clockwiseStart() {
  const firstId = state.boxOrder[0];
  state.activeBoxId = firstId;
  state.boxes[firstId].status = 'active';
  log(`Box ${getDisplayName(firstId)} goes first`, 'system');
}

function clockwiseNextPlayer() {
  const currentIndex = state.boxOrder.indexOf(state.activeBoxId);
  for (let i = 1; i <= state.boxOrder.length; i++) {
    const nextIndex = (currentIndex + i) % state.boxOrder.length;
    const nextId = state.boxOrder[nextIndex];
    const status = state.boxes[nextId].status;
    if (status !== 'passed' && status !== 'disconnected') {
      if (state.boxes[state.activeBoxId].status !== 'passed') {
        state.boxes[state.activeBoxId].status = 'idle';
      }
      state.activeBoxId = nextId;
      state.boxes[nextId].status = 'active';
      log(`${getDisplayName(nextId)}'s turn`, 'system');
      return;
    }
  }
  clockwiseEndRound();
}

function clockwiseEndTurn(hwid) {
  if (hwid !== state.activeBoxId) return;
  clockwiseNextPlayer();
}

function clockwisePass(hwid) {
  if (hwid !== state.activeBoxId) return;
  state.boxes[hwid].status = 'passed';
  log(`${getDisplayName(hwid)} passed`, 'system');

  const allDone = state.boxOrder.every(id =>
    state.boxes[id].status === 'passed' ||
    state.boxes[id].status === 'disconnected'
  );

  if (allDone) {
    clockwiseEndRound();
  } else {
    clockwiseNextPlayer();
  }
}

function clockwiseEndRound() {
  log('Round over — all players passed', 'system');
  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'idle';
    }
  });
  state.activeBoxId = null;
}

// ---- Eclipse mode ----

function eclipseStart() {
  const firstPlayerId = document.getElementById('first-player').value;
  state.eclipse.firstPlayerId = firstPlayerId;
  state.eclipse.passOrder = [];
  state.eclipse.phase = 'action';
  state.eclipse.round = 1;
  eclipseBuildTurnOrder(firstPlayerId);
  eclipseActivateNext();
  log(`Eclipse started — ${getDisplayName(firstPlayerId)} goes first`, 'system');
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
      state.activeBoxId = nextId;
      state.boxes[nextId].status = 'active';
      log(`${getDisplayName(nextId)}'s turn`, 'system');
      return;
    }

    if (status === 'can-react') {
      if (current !== null && state.boxes[current]?.status === 'idle') {
        state.boxes[current].status = 'idle';
      }
      state.activeBoxId = nextId;
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
  state.activeBoxId = null;
  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'combat';
    }
  });
}

function eclipseLongPress(hwid) {
  if (hwid !== state.hubHwid) return;
  switch (state.eclipse.phase) {
    case 'combat':
      eclipseStartUpkeep();
      break;
    case 'upkeep':
      eclipseEndRound();
      break;
  }
}

function eclipseStartUpkeep() {
  log('Upkeep phase', 'system');
  state.eclipse.phase = 'upkeep';
  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'upkeep';
    }
  });
}

function eclipseEndRound() {
  state.eclipse.round++;

  if (state.eclipse.round > 8) {
    log('Game over after 8 rounds!', 'system');
    state.gameActive = false;
    state.eclipse.phase = null;
    state.boxOrder.forEach(id => {
      state.boxes[id].status = 'idle';
    });
    state.activeBoxId = null;
    document.getElementById('start-btn').disabled = false;
    render();
    return;
  }

  log(`Round ${state.eclipse.round} begins`, 'system');
  state.eclipse.phase = 'action';

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
}

// ---- Simulator ----

function simulateButton(hwid, type) {
  log(`[SIM] ${getDisplayName(hwid)} pressed ${type}`, 'system');
  handleMessage({ type, hwid });
}

function getSimRfidOptions() {
  const mode = state.gameMode;
  if (mode === 'ti') {
    return Object.entries(state.ti.tagMap).map(([tagId, info]) => ({
      id: tagId,
      label: info.label,
    }));
  }
  if (mode.startsWith('eclipse')) {
    return Object.entries(state.eclipse?.tagMap || {}).map(([id, info]) => ({
      id,
      label: info.label,
    }));
  }
  return [];
}

function simulateRfid(hwid) {
  const safeId = hwid.replace(/:/g, '-');
  const select = document.getElementById(`rfid-select-${safeId}`);
  if (!select) return;
  const tagId = select.value;
  if (!tagId) return;
  log(`[SIM] ${getDisplayName(hwid)} tapped tag ${tagId}`, 'system');
  handleMessage({ type: 'rfid', hwid, tagId });
}

function simulateTagTap() {
  if (!tagLearningActive) return;
  // Generate a fake unique tag ID for this slot
  const tag = TI_TAGS_TO_LEARN[tagLearningIndex];
  const fakeTagId = `sim-tag-${tag.id}`;
  handleTagLearning(fakeTagId);
}

// ---- Table rendering ----

function getBoxPositions(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    const x = 50 + 42 * Math.cos(angle);
    const y = 50 + 38 * Math.sin(angle);
    positions.push({ x, y });
  }
  return positions;
}

function render() {
  syncLeds();
  renderBoxes();
  renderTableLabel();
}

function renderTableLabel() {
  const el = document.getElementById('table-label');
  const phaseControls = document.getElementById('phase-controls');
  const tiGameControls = document.getElementById('ti-game-controls');

  if (!state.gameActive) {
    el.innerHTML = '';
    phaseControls.style.display = 'none';
    const tiUndoControls = document.getElementById('ti-undo-controls');
    if (tiUndoControls) tiUndoControls.style.display = 'none';
    if (tiGameControls) tiGameControls.style.display = 'none';
    return;
  }

  const isTi = state.gameMode === 'ti';
  const isEclipse = state.gameMode.startsWith('eclipse');

  if (isTi) {
    const phase = state.ti.phase || '';
    const phaseLabel = phase.replace(/_/g, ' ').toUpperCase();
    el.innerHTML = `
      <div class="round-counter">Round ${state.ti.round}</div>
      <div class="game-mode-label">TWILIGHT IMPERIUM${phase ? ` — ${phaseLabel}` : ''}</div>
    `;
    const tiAdvancePhases = ['status', 'status2', 'agenda_reveal', 'when_agenda_revealed', 'after_agenda_revealed', 'agenda_vote'];
    phaseControls.style.display = tiAdvancePhases.includes(phase) ? 'block' : 'none';
    const tiUndoControls = document.getElementById('ti-undo-controls');
    if (tiUndoControls) tiUndoControls.style.display = phase === 'strategy' ? 'block' : 'none';
    if (tiGameControls) tiGameControls.style.display = 'block';
  } else {
    if (tiGameControls) tiGameControls.style.display = 'none';
    const roundDisplay = isEclipse
      ? `<div class="round-counter">Round ${state.eclipse.round} / 8</div>`
      : '';
    const phaseDisplay = state.eclipse.phase
      ? `<div class="game-mode-label">${state.gameMode.replace(/_/g, ' ').toUpperCase()} — ${state.eclipse.phase.toUpperCase()}</div>`
      : `<div class="game-mode-label">${state.gameMode.replace(/_/g, ' ').toUpperCase()}</div>`;
    el.innerHTML = roundDisplay + phaseDisplay;
    const showAdvance = ['combat', 'upkeep'].includes(state.eclipse.phase);
    phaseControls.style.display = showAdvance ? 'block' : 'none';
  }
}

function renderLedRing(leds) {
  const size = 44;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 17;
  const dotRadius = 3.5;
  const n = leds.length;

  const dots = leds.map((color, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    const isOn = color !== '#000000';
    const glow = isOn ? `filter: drop-shadow(0 0 2px ${color});` : '';
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${dotRadius}"
      fill="${color}" style="${glow}"/>`;
  }).join('');

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${radius + dotRadius + 1}"
      fill="none" stroke="#222" stroke-width="1"/>
    ${dots}
  </svg>`;
}

function renderBadges(box) {
  if (!box.badges || box.badges.length === 0) return '';

  const items = box.badges.map(badge => {
    switch (badge.type) {
      case 'icon':
        return `<span class="badge-icon" title="${badge.label || ''}">${badge.value}</span>`;
      case 'pill':
        return `<span class="badge-pill ${badge.faded ? 'faded' : ''}"
          style="background:${badge.color || '#555'}">${badge.value}</span>`;
      case 'text':
        return `<span class="badge-text"
          style="color:${badge.color || '#aaa'}">${badge.value}</span>`;
      default:
        return '';
    }
  }).join('');

  return `<div class="box-badges">${items}</div>`;
}

function renderSimControls(hwid) {
  const isOpen = simOpenCards.has(hwid);
  const rfidOptions = getSimRfidOptions();
  const rfidBtn = rfidOptions.length > 0
    ? `<button class="box-btn" onclick="openRfidDialog('${hwid}')">RFID</button>`
    : '';

  return `<div class="box-sim ${isOpen ? 'sim-open' : ''}">
    <div class="box-sim-row">
      <button class="box-btn" onclick="simulateButton('${hwid}', 'endturn')">End</button>
      <button class="box-btn" onclick="simulateButton('${hwid}', 'pass')">Pass</button>
      <button class="box-btn" onclick="simulateButton('${hwid}', 'longpress')">Long</button>
      ${rfidBtn}
    </div>
  </div>`;
}

function renderBoxes() {
  const container = document.getElementById('box-positions');
  container.innerHTML = '';

  const ids = state.boxOrder;
  if (ids.length === 0) return;

  const positions = getBoxPositions(ids.length);

  ids.forEach((hwid, index) => {
    const box = state.boxes[hwid];
    const pos = positions[index];
    const leds = box.leds || ledStateForStatus(box.status, box);

    const card = document.createElement('div');
    card.className = `box-card ${box.status}`;
    card.style.left = `${pos.x}%`;
    card.style.top = `${pos.y}%`;

    card.innerHTML = `
      ${box.isVirtual ? '<div class="box-virtual">SIM</div>' : ''}
      <div class="box-name">${getDisplayName(hwid)}</div>
      ${renderLedRing(leds)}
      <div class="box-status">${box.status}</div>
      ${renderBadges(box)}
      ${renderSimControls(hwid)}
    `;

    card.onclick = (e) => {
      if (e.target === card || e.target.classList.contains('box-name') ||
          e.target.classList.contains('box-status')) {
        toggleSim(hwid);
      }
    };

    container.appendChild(card);
  });
}

function setBoxBadges(hwid, badges) {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].badges = badges;
}

function clearBoxBadges(hwid) {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].badges = [];
}

function clearAllBadges() {
  state.boxOrder.forEach(id => clearBoxBadges(id));
}

// ---- Sim toggle ----

const simOpenCards = new Set();

function toggleSim(hwid) {
  if (simOpenCards.has(hwid)) {
    simOpenCards.delete(hwid);
  } else {
    simOpenCards.add(hwid);
  }
  render();
}

// ---- RFID dialog ----

let rfidDialogHwid = null;

function openRfidDialog(hwid) {
  rfidDialogHwid = hwid;
  const options = getSimRfidOptions();
  const list = document.getElementById('rfid-dialog-list');
  list.innerHTML = options.map(o =>
    `<button class="rfid-option" onclick="selectRfidOption('${o.id}')">${o.label}</button>`
  ).join('');
  document.getElementById('rfid-dialog-overlay').style.display = 'flex';
}

function selectRfidOption(tagId) {
  if (!rfidDialogHwid) return;
  const hwid = rfidDialogHwid;
  closeRfidDialog();
  log(`[SIM] ${getDisplayName(hwid)} tapped ${tagId}`, 'system');
  handleMessage({ type: 'rfid', hwid, tagId });
}

function closeRfidDialog() {
  document.getElementById('rfid-dialog-overlay').style.display = 'none';
  rfidDialogHwid = null;
}

// ---- Log ----

function log(message, type = 'system') {
  const logEl = document.getElementById('log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}

// ---- Status ----

function setStatus(status) {
  state.connected = status === 'connected';
  const el = document.getElementById('connection-status');
  el.className = `status ${status}`;
  el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
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
      eclipseLongPress(state.hubHwid || state.boxOrder[0]);
      break;
  }
  render();
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

// ---- TI Tag Learning ----

const TI_TAGS_TO_LEARN = [
  { type: 'speaker',    id: 'speaker',     label: 'Speaker Token',  color: '#ffffff', initiative: null },
  { type: 'strategy',   id: 'leadership',  label: 'Leadership',     color: '#cc0000', initiative: 1 },
  { type: 'strategy',   id: 'diplomacy',   label: 'Diplomacy',      color: '#ff8800', initiative: 2 },
  { type: 'strategy',   id: 'politics',    label: 'Politics',       color: '#dddd00', initiative: 3 },
  { type: 'strategy',   id: 'construction',label: 'Construction',   color: '#00aa00', initiative: 4 },
  { type: 'strategy',   id: 'trade',       label: 'Trade',          color: '#00aaaa', initiative: 5 },
  { type: 'strategy',   id: 'warfare',     label: 'Warfare',        color: '#0055ff', initiative: 6 },
  { type: 'strategy',   id: 'technology',  label: 'Technology',     color: '#000066', initiative: 7 },
  { type: 'strategy',   id: 'imperial',    label: 'Imperial',       color: '#660088', initiative: 8 },
];

let tagLearningIndex = 0;
let tagLearningActive = false;

function startTagLearning() {
  tagLearningIndex = 0;
  tagLearningActive = true;
  document.getElementById('tag-learning-overlay').style.display = 'flex';
  showNextTagPrompt();
}

function showNextTagPrompt() {
  if (tagLearningIndex >= TI_TAGS_TO_LEARN.length) {
    finishTagLearning();
    return;
  }
  const tag = TI_TAGS_TO_LEARN[tagLearningIndex];
  document.getElementById('tag-learning-prompt').textContent =
    `Tap the ${tag.label} on the hub box`;
  document.getElementById('tag-learning-status').textContent = 
    `${tagLearningIndex} of ${TI_TAGS_TO_LEARN.length} learned`;
}

function handleTagLearning(tagId) {
  if (!tagLearningActive) return false;
  const tag = TI_TAGS_TO_LEARN[tagLearningIndex];

  // Store mapping
  state.ti.tagMap[tagId] = {
    type: tag.type,
    id: tag.id,
    label: tag.label,
    color: tag.color,
    initiative: tag.initiative,
  };
  saveTiTags();

  document.getElementById('tag-learning-status').textContent =
    `✓ ${tag.label} learned`;

  tagLearningIndex++;
  setTimeout(showNextTagPrompt, 800);
  return true;
}

function finishTagLearning() {
  tagLearningActive = false;
  document.getElementById('tag-learning-overlay').style.display = 'none';
  log('Tag learning complete', 'system');
  updateSetupUI();
}

function cancelTagLearning() {
  tagLearningActive = false;
  tagLearningIndex = 0;
  document.getElementById('tag-learning-overlay').style.display = 'none';
}

function handleRfid(hwid, tagId) {
  // Tag learning intercepts all RFID during learning mode
  if (tagLearningActive) {
    // Only accept taps on the hub
    if (hwid === state.hubHwid) {
      handleTagLearning(tagId);
    }
    return;
  }

  // During gameplay, route to game mode handler
  if (!state.gameActive) return;
  switch (state.gameMode) {
    case 'ti':
      handleTiRfid(hwid, tagId);
      break;
  }
}

function tiMecatolChanged() {
  state.ti.mecatolControlled = document.getElementById('ti-mecatol').checked;
  log(`Mecatol Rex ${state.ti.mecatolControlled ? 'controlled' : 'not controlled'}`, 'system');
}

function tiMecatolActiveChanged() {
  state.ti.mecatolControlled = document.getElementById('ti-mecatol-active').checked;
  log(`Mecatol ${state.ti.mecatolControlled ? 'controlled' : 'not controlled'}`, 'system');
}

// ---- Wake Lock ----

let wakeLock = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      log('Screen wake lock active', 'system');
      wakeLock.addEventListener('release', () => {
        log('Screen wake lock released', 'system');
      });
    } catch (err) {
      log(`Wake lock failed: ${err.message}`, 'error');
    }
  } else {
    log('Wake lock not supported on this device', 'error');
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// ---- TI mode ----

const TI_STRATEGY_COLORS = {
  leadership:   '#cc0000',
  diplomacy:    '#ff8800',
  politics:     '#dddd00',
  construction: '#00aa00',
  trade:        '#00aaaa',
  warfare:      '#0055ff',
  technology:   '#000066',
  imperial:     '#660088',
};

function tiStart() {
  const speakerHwid = document.getElementById('ti-speaker').value;
  state.ti.speakerHwid = speakerHwid;
  state.ti.secondaryMode = document.getElementById('ti-secondary-mode').value;
  state.ti.round = 1;
  state.ti.phase = null;
  state.ti.players = {};

  // Initialise per-player state
  state.boxOrder.forEach(hwid => {
    state.ti.players[hwid] = {
      hwid,
      strategyCards: [],
      passed: false,
      confirmedSecondary: false,
    };
  });

  log(`TI started — Round 1, Speaker: ${getDisplayName(speakerHwid)}`, 'system');
  tiStartStrategyPhase();
}

// ---- TI Status Phase ----

function tiStartStatusPhase(isPostAgenda = false) {
  state.ti.phase = isPostAgenda ? 'status2' : 'status';
  state.activeBoxId = null;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = isPostAgenda ? 'status2' : 'status';
  });
  log(`Status phase — long press hub to continue`, 'system');
  updateTiBadges();
}

function tiLongPress(hwid) {
  if (hwid !== state.hubHwid) return;
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

// ---- TI Strategy Phase ----

function tiStartStrategyPhase() {
  state.ti.phase = 'strategy';
  state.activeBoxId = null;

  // Reset all strategy cards
  state.boxOrder.forEach(hwid => {
    state.ti.players[hwid].strategyCards = [];
    state.ti.players[hwid].passed = false;
    state.boxes[hwid].status = 'idle';
  });

  // Build clockwise order from speaker
  const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid);
  state.ti.turnOrder = [
    ...state.boxOrder.slice(speakerIndex),
    ...state.boxOrder.slice(0, speakerIndex),
  ];

  // For 4 or fewer players, go around twice
  if (state.boxOrder.length <= 4) {
    state.ti.turnOrder = [...state.ti.turnOrder, ...state.ti.turnOrder];
  }

  state.ti.strategyTurnIndex = 0;
  tiActivateStrategyTurn();
  log('Strategy phase', 'system');
}

function tiActivateStrategyTurn() {
  // Skip players who already have 2 cards (4- player case)
  while (state.ti.strategyTurnIndex < state.ti.turnOrder.length) {
    const hwid = state.ti.turnOrder[state.ti.strategyTurnIndex];
    const player = state.ti.players[hwid];
    if (player.strategyCards.length < 2) break;
    state.ti.strategyTurnIndex++;
  }

  if (state.ti.strategyTurnIndex >= state.ti.turnOrder.length) {
    // All players have their cards
    tiEndStrategyPhase();
    return;
  }

  const hwid = state.ti.turnOrder[state.ti.strategyTurnIndex];
  if (state.activeBoxId && state.activeBoxId !== hwid) {
    state.boxes[state.activeBoxId].status = 'idle';
  }
  state.activeBoxId = hwid;
  state.boxes[hwid].status = 'choosing';
  state.boxes[hwid].choosingLeds = ledSectors(LED_COUNT, [
    '#cc0000', '#ff8800', '#dddd00', '#00aa00',
    '#00aaaa', '#0055ff', '#000066', '#660088',
  ]);
  log(`${getDisplayName(hwid)} picks a strategy card`, 'system');
  updateTiBadges();
}

function tiUndoStrategyPick() {
  // Find previous player who has a card and remove their last pick
  let idx = state.ti.strategyTurnIndex - 1;
  while (idx >= 0) {
    const hwid = state.ti.turnOrder[idx];
    const player = state.ti.players[hwid];
    if (player.strategyCards.length > 0) {
      const removed = player.strategyCards.pop();
      log(`Undid ${getDisplayName(hwid)}'s pick: ${removed.label}`, 'system');
      state.ti.strategyTurnIndex = idx;
      // Reactivate that player
      if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
      state.activeBoxId = hwid;
      state.boxes[hwid].status = 'choosing';
      state.boxes[hwid].choosingLeds = ledSectors(LED_COUNT, [
        '#cc0000', '#ff8800', '#dddd00', '#00aa00',
        '#00aaaa', '#0055ff', '#000066', '#660088',
      ]);
      updateTiBadges();
      return;
    }
    idx--;
  }
  log('Nothing to undo', 'system');
}

function tiEndStrategyPhase() {
  log('Strategy phase complete', 'system');
  if (state.activeBoxId) {
    state.boxes[state.activeBoxId].status = 'idle';
    state.activeBoxId = null;
  }
  tiStartActionPhase();
}

// ---- TI Action Phase ----

function tiStartActionPhase() {
  state.ti.phase = 'action';
  state.ti.secondary = null;

  // Reset passed state
  state.boxOrder.forEach(hwid => {
    state.ti.players[hwid].passed = false;
    state.ti.players[hwid].confirmedSecondary = false;
    state.boxes[hwid].status = 'idle';
  });

  // Build turn order by lowest initiative
  state.ti.turnOrder = [...state.boxOrder].sort((a, b) => {
    const aInit = tiLowestInitiative(a);
    const bInit = tiLowestInitiative(b);
    return aInit - bInit;
  });

  state.ti.actionTurnIndex = 0;
  tiActivateActionTurn();
  log('Action phase', 'system');
}

function tiLowestInitiative(hwid) {
  const cards = state.ti.players[hwid].strategyCards;
  if (cards.length === 0) return 999;
  return Math.min(...cards.map(c => c.initiative));
}

function tiActivateActionTurn() {
  // Find next non-passed player
  const order = state.ti.turnOrder;
  let found = false;

  for (let i = 0; i < order.length; i++) {
    const idx = (state.ti.actionTurnIndex + i) % order.length;
    const hwid = order[idx];
    const player = state.ti.players[hwid];
    if (!player.passed && state.boxes[hwid].status !== 'disconnected') {
      if (state.activeBoxId && state.activeBoxId !== hwid) {
        state.boxes[state.activeBoxId].status = 'idle';
      }
      state.ti.actionTurnIndex = idx;
      state.activeBoxId = hwid;
      state.boxes[hwid].status = 'active';
      log(`${getDisplayName(hwid)}'s turn`, 'system');
      found = true;
      break;
    }
  }

  if (!found) {
    tiEndActionPhase();
  }
  updateTiBadges();
}

function tiEndTurn(hwid) {
  switch (state.ti.phase) {
    case 'strategy':
      // End turn without picking — shouldn't normally happen
      // but allow advancing if hub presses
      if (hwid === state.hubHwid) {
        state.ti.strategyTurnIndex++;
        tiActivateStrategyTurn();
      }
      break;

    case 'action':
      if (state.ti.secondary) {
        tiConfirmSecondary(hwid);
      } else {
        if (hwid !== state.activeBoxId) return;
        // Regular action end turn
        state.ti.actionTurnIndex =
          (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
        tiActivateActionTurn();
      }
      break;

    case 'agenda_reveal':
      if (hwid === state.activeBoxId) tiAdvanceAgendaPhase();
      break;
    case 'when_agenda_revealed':
    case 'after_agenda_revealed':
    case 'agenda_vote':
      tiAgendaEndTurn(hwid);
      break;
  }
}

function tiPass(hwid) {
  switch (state.ti.phase) {
    case 'strategy':
      // Pass on hub undoes previous pick
      if (hwid === state.hubHwid) {
        tiUndoStrategyPick();
      }
      break;

    case 'action':
      if (state.ti.secondary) {
        if (hwid === state.ti.secondary.activeHwid) {
          // Active player cancels their strategy card use
          const secondary = state.ti.secondary;
          const card = state.ti.players[hwid].strategyCards.find(c => c.id === secondary.cardId);
          if (card) card.used = false;
          // Reset all secondary boxes to idle
          secondary.pendingHwids.forEach(id => {
            if (state.boxes[id].status === 'secondary') {
              state.boxes[id].status = 'idle';
            }
          });
          state.ti.secondary = null;
          state.boxes[hwid].status = 'active';
          log(`${getDisplayName(hwid)} cancels ${secondary.cardId} use`, 'system');
          updateTiBadges();
        } else {
          // Other player skips secondary
          tiConfirmSecondary(hwid);
        }
      } else {
        if (hwid !== state.activeBoxId) return;
        // Can only pass if all strategy cards used
        const player = state.ti.players[hwid];
        const allUsed = player.strategyCards.every(c => c.used);
        if (!allUsed) {
          log(`${getDisplayName(hwid)} can't pass — strategy cards not used`, 'system');
          return;
        }
        player.passed = true;
        state.boxes[hwid].status = 'passed';
        log(`${getDisplayName(hwid)} passes`, 'system');

        const allPassed = state.boxOrder.every(id =>
          state.ti.players[id].passed ||
          state.boxes[id].status === 'disconnected'
        );

        if (allPassed) {
          tiEndActionPhase();
        } else {
          state.ti.actionTurnIndex =
            (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
          tiActivateActionTurn();
        }
      }
      break;
  }
}

// ---- TI Strategy Card Use ----

function tiUseStrategyCard(hwid, card) {
  if (hwid !== state.activeBoxId) return;
  if (state.ti.phase !== 'action') return;
  if (card.used) {
    // Cancel strategy card use — return to normal active state
    state.boxes[hwid].status = 'active';
    state.ti.secondary = null;
    log(`${getDisplayName(hwid)} cancels ${card.label} use`, 'system');
    updateTiBadges();
    return;
  }

  // Mark card as being used — light box in card colour alternating white
  state.boxes[hwid].status = 'strategy';
  state.boxes[hwid].strategyColor = card.color;
  card.used = true;

  const otherPlayers = state.boxOrder.filter(id =>
    id !== hwid && state.boxes[id].status !== 'disconnected'
  );

  state.ti.secondary = {
    activeHwid: hwid,
    cardId: card.id,
    cardColor: card.color,
    pendingHwids: [...otherPlayers],
  };

  // Reset all confirmed secondary flags
  state.boxOrder.forEach(id => {
    state.ti.players[id].confirmedSecondary = false;
  });

  log(`${getDisplayName(hwid)} uses ${card.label} — secondaries pending`, 'system');

  const mode = state.ti.secondaryMode;
  if (mode === 'fastest') {
    // Light up all other players immediately
    otherPlayers.forEach(id => {
      state.boxes[id].status = 'secondary';
      state.boxes[id].strategyColor = card.color;
    });
  } else if (mode === 'fast') {
    // Will light up when active player presses end turn
    // Nothing to do yet
  } else if (mode === 'standard') {
    // Light up first player clockwise from active
    tiActivateNextSecondary();
  }

  updateTiBadges();
}

function tiActivateNextSecondary() {
  const secondary = state.ti.secondary;
  if (!secondary) return;

  // Find next unconfirmed player clockwise from active
  const activeIndex = state.boxOrder.indexOf(secondary.activeHwid);
  for (let i = 1; i <= state.boxOrder.length; i++) {
    const idx = (activeIndex + i) % state.boxOrder.length;
    const hwid = state.boxOrder[idx];
    if (secondary.pendingHwids.includes(hwid) &&
        !state.ti.players[hwid].confirmedSecondary &&
        state.boxes[hwid].status !== 'disconnected') {
      state.boxes[hwid].status = 'secondary';
      state.boxes[hwid].strategyColor = secondary.cardColor;
      log(`${getDisplayName(hwid)} secondary`, 'system');
      return;
    }
  }
}

function tiConfirmSecondary(hwid) {
  const secondary = state.ti.secondary;
  if (!secondary) return;

  if (hwid === secondary.activeHwid) {
    if (state.ti.secondaryMode === 'fast') {
      // Active player ends their turn — light up all others for secondary
      secondary.pendingHwids.forEach(id => {
        if (state.boxes[id].status !== 'disconnected') {
          state.boxes[id].status = 'secondary';
          state.boxes[id].strategyColor = secondary.cardColor;
        }
      });
      secondary.activeTurnEnded = true;
      state.boxes[hwid].status = 'idle';
      state.activeBoxId = null;
    } else if (state.ti.secondaryMode === 'fastest') {
      // Active player finished primary — secondaries already running
      secondary.activeTurnEnded = true;
      state.boxes[hwid].status = 'idle';
      state.activeBoxId = null;
      // Secondaries may have all confirmed already — check and advance if so
      const allConfirmed = secondary.pendingHwids.every(id =>
        state.ti.players[id].confirmedSecondary ||
        state.boxes[id].status === 'disconnected'
      );
      if (allConfirmed) {
        log('All secondaries confirmed — advancing turn', 'system');
        state.ti.secondary = null;
        state.ti.actionTurnIndex =
          (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
        tiActivateActionTurn();
      }
    }
    // In standard mode the active player doesn't end turn while secondaries run
    return;
  }

  // Other players confirming secondary
  if (!secondary.pendingHwids.includes(hwid)) return;
  state.ti.players[hwid].confirmedSecondary = true;
  state.boxes[hwid].status = 'idle';

  if (state.ti.secondaryMode === 'standard') {
    tiActivateNextSecondary();
  }

  // Check if all confirmed
  const allConfirmed = secondary.pendingHwids.every(id =>
    state.ti.players[id].confirmedSecondary ||
    state.boxes[id].status === 'disconnected'
  );

  if (allConfirmed) {
    log('All secondaries confirmed — advancing turn', 'system');
    state.ti.secondary = null;

    if (secondary.activeTurnEnded) {
      // Active player already ended their turn (fast mode) — advance now
      state.ti.actionTurnIndex =
        (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
      tiActivateActionTurn();
    } else {
      // Fastest/standard — active player still needs to end their turn
      // In fastest mode they're still executing their primary (strategy status);
      // in standard mode secondaries go sequentially so active is done with primary.
      const wasStrategy = state.boxes[secondary.activeHwid].status === 'strategy';
      state.boxes[secondary.activeHwid].status = wasStrategy ? 'strategy' : 'active';
      state.activeBoxId = secondary.activeHwid;
    }
    updateTiBadges();
    render();
  }

  updateTiBadges();
}

function tiEndActionPhase() {
  log('Action phase over', 'system');
  state.activeBoxId = null;
  tiStartStatusPhase();
}

// ---- TI Agenda Phase ----

function tiStartAgendaPhase() {
  state.ti.phase = 'agenda_reveal';
  state.ti.agendaCount = 0; // 0 or 1 (two agendas per round)
  state.activeBoxId = null;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
  });

  // Speaker lights up blue+white
  state.boxes[state.ti.speakerHwid].status = 'agenda_speaker';
  state.activeBoxId = state.ti.speakerHwid;
  log('Agenda phase — speaker reads agenda', 'system');
  updateTiBadges();
}

function tiAdvanceAgendaPhase() {
  switch (state.ti.phase) {
    case 'agenda_reveal':
      // Move to "when revealed" action cards
      tiStartAgendaWhen();
      break;
    case 'when_agenda_revealed':
      tiStartAgendaAfter();
      break;
    case 'after_agenda_revealed':
      tiStartAgendaVote();
      break;
    case 'agenda_vote':
      state.ti.agendaCount++;
      if (state.ti.agendaCount < 2) {
        // Second agenda
        state.ti.phase = 'agenda_reveal';
        state.boxes[state.ti.speakerHwid].status = 'agenda_speaker';
        state.activeBoxId = state.ti.speakerHwid;
        log('Second agenda — speaker reads', 'system');
      } else {
        // Agenda phase complete
        tiStartStatusPhase(true);
      }
      break;
  }
  updateTiBadges();
}

function tiStartAgendaWhen() {
  state.ti.phase = 'when_agenda_revealed';
  // Build clockwise order from speaker
  const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid);
  state.ti.agendaTurnOrder = [
    ...state.boxOrder.slice(speakerIndex),
    ...state.boxOrder.slice(0, speakerIndex),
  ];
  state.ti.agendaTurnIndex = 0;
  if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
  tiActivateAgendaTurn('when_agenda_revealed');
  log('Agenda — "when revealed" action cards', 'system');
}

function tiStartAgendaAfter() {
  state.ti.phase = 'after_agenda_revealed';
  state.ti.agendaTurnIndex = 0;
  if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
  tiActivateAgendaTurn('after_agenda_revealed');
  log('Agenda — "after revealed" action cards', 'system');
}

function tiStartAgendaVote() {
  state.ti.phase = 'agenda_vote';
  // Voting starts with player left of speaker
  const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid);
  const leftIndex = (speakerIndex + 1) % state.boxOrder.length;
  state.ti.agendaTurnOrder = [
    ...state.boxOrder.slice(leftIndex),
    ...state.boxOrder.slice(0, leftIndex),
  ];
  state.ti.agendaTurnIndex = 0;
  if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
  tiActivateAgendaTurn('agenda_vote');
  log('Agenda — voting', 'system');
}

function tiActivateAgendaTurn(phase) {
  const order = state.ti.agendaTurnOrder;
  if (state.ti.agendaTurnIndex >= order.length) {
    state.activeBoxId = null;
    tiAdvanceAgendaPhase();
    return;
  }
  const hwid = order[state.ti.agendaTurnIndex];
  if (state.activeBoxId && state.activeBoxId !== hwid) {
    state.boxes[state.activeBoxId].status = 'idle';
  }
  state.activeBoxId = hwid;
  state.boxes[hwid].status = phase;
}

function tiAgendaEndTurn(hwid) {
  if (hwid !== state.activeBoxId) return;
  state.boxes[hwid].status = 'idle';
  state.ti.agendaTurnIndex++;
  tiActivateAgendaTurn(state.ti.phase);
  updateTiBadges();
}

// ---- TI Round end ----

function tiEndRound() {
  log(`Round ${state.ti.round} complete`, 'system');
  state.ti.round++;

  // Advance speaker if politics was played
  // (handled via RFID tap on speaker token during action phase)
  // Reset all boxes
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.ti.players[hwid].strategyCards = [];
    state.ti.players[hwid].passed = false;
  });
  state.activeBoxId = null;
  state.ti.secondary = null;

  tiStartStrategyPhase();
}

// ---- TI RFID ----

function handleTiRfid(hwid, tagId) {
  const tag = state.ti.tagMap[tagId];
  if (!tag) {
    log(`Unknown tag: ${tagId}`, 'error');
    return;
  }

  if (tag.type === 'speaker') {
    // Active player taps speaker token — they become speaker
    if (hwid === state.activeBoxId) {
      state.ti.speakerHwid = hwid;
      log(`${getDisplayName(hwid)} takes the speaker token`, 'system');
      updateTiBadges();
    }
    return;
  }

  if (tag.type === 'strategy') {
    if (state.ti.phase === 'strategy') {
      // Assign card to active player
      if (hwid !== state.activeBoxId) return;
      const player = state.ti.players[hwid];

      // Check card not already taken
      const alreadyTaken = state.boxOrder.some(id =>
        state.ti.players[id].strategyCards.some(c => c.id === tag.id)
      );
      if (alreadyTaken) {
        log(`${tag.label} already taken`, 'error');
        return;
      }

      player.strategyCards.push({
        id: tag.id,
        label: tag.label,
        color: tag.color,
        initiative: tag.initiative,
        used: false,
      });

      log(`${getDisplayName(hwid)} takes ${tag.label}`, 'system');
      updateTiBadges();

      // Temporarily override leds for pulse, bypassing syncLeds
      const pulseLeds = ledSolid(LED_COUNT, tag.color);
      state.boxes[hwid].leds = pulseLeds;
      state.boxes[hwid].ledOverrideUntil = Date.now() + 800;
      if (!state.boxes[hwid].isVirtual) sendToBox(hwid, { type: 'led', leds: pulseLeds });
      renderBoxes();
      setTimeout(() => {
        state.boxes[hwid].ledOverrideUntil = null;
        state.ti.strategyTurnIndex++;
        tiActivateStrategyTurn();
        render();
      }, 800);

    } else if (state.ti.phase === 'action') {
      // Use strategy card as primary action
      if (hwid !== state.activeBoxId) return;
      const player = state.ti.players[hwid];
      const card = player.strategyCards.find(c => c.id === tag.id);
      if (!card) {
        log(`${getDisplayName(hwid)} doesn't have ${tag.label}`, 'error');
        return;
      }
      tiUseStrategyCard(hwid, card);
    }
  }
}

// ---- TI Badges ----

function updateTiBadges() {
  if (state.gameMode !== 'ti') return;
  state.boxOrder.forEach(hwid => {
    const player = state.ti.players[hwid];
    if (!player) return;
    const badges = [];

    // Speaker crown
    if (hwid === state.ti.speakerHwid) {
      badges.push({ type: 'icon', value: '👑', label: 'Speaker' });
    }

    // Strategy cards
    player.strategyCards.forEach(card => {
      badges.push({
        type: 'pill',
        value: card.label.substring(0, 4),
        color: card.color,
        faded: card.used,
      });
    });

    setBoxBadges(hwid, badges);
  });
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

// ---- Init ----

render();