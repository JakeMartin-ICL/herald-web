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
  if (!getBoxName(hwid)) {
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
  document.getElementById('ti-mecatol-row').style.display = isTi ? 'flex' : 'none';
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

function ledStateForStatus(status) {
  switch (status) {
    case 'active':       return ledSolid(LED_COUNT, '#c9a84c');
    case 'can-react':    return ledOff(LED_COUNT);
    case 'reacting':     return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':       return ledSolid(LED_COUNT, '#1a1a3a');
    case 'combat':       return ledSolid(LED_COUNT, '#8a0000');
    case 'upkeep':       return ledThirds(LED_COUNT, '#ff69b4', '#ffff00', '#ffa500');
    case 'disconnected': return ledOff(LED_COUNT);
    default:             return state.gameActive ? ledOff(LED_COUNT) : ledRainbow(LED_COUNT);
  }
}

function syncLeds() {
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    const leds = ledStateForStatus(box.status);
    box.leds = leds;
    if (!box.isVirtual) {
      sendToBox(hwid, { type: 'led', leds });
    }
  });
}

// ---- Game logic dispatch ----

function startGame() {
  state.gameActive = true;
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
  }
}

function handleLongPress(hwid) {
  if (!state.gameActive) return;
  switch (state.gameMode) {
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseLongPress(hwid);
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

  if (!state.gameActive) {
    el.innerHTML = '';
    phaseControls.style.display = 'none';
    return;
  }

  const isEclipse = state.gameMode.startsWith('eclipse');
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
  const rfidOptions = getSimRfidOptions();
  const rfidBtn = rfidOptions.length > 0
    ? `<button class="box-btn" onclick="openRfidDialog('${hwid}')">RFID</button>`
    : '';

  return `<div class="box-sim">
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
    const leds = box.leds || ledStateForStatus(box.status);

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
  handleLongPress(state.hubHwid || state.boxOrder[0]);
  render();
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

// ---- Init ----

render();