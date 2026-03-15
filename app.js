// ---- Constants ----

const VIRTUAL_BOX_ID_OFFSET = 100;

// ---- State ----

const state = {
  connected: false,
  gameActive: false,
  gameMode: 'clockwise',
  boxes: {},
  boxOrder: [],        // seat order, fixed for the session
  activeBoxId: null,
  nextVirtualId: VIRTUAL_BOX_ID_OFFSET,

  // Eclipse state
  eclipse: {
    phase: null,       // 'action', 'combat', 'upkeep', 'end'
    passOrder: [],     // box ids in the order they entered can-react
    turnOrder: [],     // derived each round: seat order starting from first player
    firstPlayerId: null,
    round: 0,
  },
};

// ---- WebSocket ----

let ws = null;

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
  };
}

function disconnect() {
  if (ws) ws.close();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    log(`→ ${JSON.stringify(msg)}`, 'sent');
  }
}

function sendToBox(boxId, msg) {
  if (boxId >= VIRTUAL_BOX_ID_OFFSET) {
    return; // virtual boxes derive state from status, no message needed
  }
  send({ ...msg, box: boxId });
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
      break;
    case 'connected':
      addBox(msg.box, false);
      break;
    case 'disconnected':
      removeBox(msg.box);
      break;
    case 'endturn':
      handleEndTurn(msg.box);
      break;
    case 'pass':
      handlePass(msg.box);
      break;
    case 'longpress':
      handleLongPress(msg.box);
      break;
  }

  render();
}

// ---- Box management ----

function addBox(id, isVirtual) {
  if (state.boxes[id]) return;

  state.boxes[id] = {
    id,
    isVirtual,
    name: `Player ${Object.keys(state.boxes).length + 1}`,
    status: 'idle',
  };
  state.boxOrder.push(id);
  log(`${isVirtual ? 'Virtual box' : 'Box'} ${id} connected`, 'system');
  updateSetupUI();
  render();
}

function removeBox(id) {
  if (!state.boxes[id]) return;
  delete state.boxes[id];
  state.boxOrder = state.boxOrder.filter(b => b !== id);
  if (state.activeBoxId === id) state.activeBoxId = null;
  log(`Box ${id} disconnected`, 'system');
  updateSetupUI();
  render();
}

function addVirtualBox() {
  addBox(state.nextVirtualId++, true);
}

// ---- Setup UI ----

function onGameModeChange() {
  updateSetupUI();
}

function updateSetupUI() {
  const count = Object.keys(state.boxes).length;
  const mode = document.getElementById('game-mode').value;
  const isEclipse = mode.startsWith('eclipse');

  document.getElementById('player-count').textContent =
    `${count} box${count !== 1 ? 'es' : ''} connected`;

  document.getElementById('start-btn').disabled =
    count < 2 || state.gameActive;

  // Show first player picker for Eclipse
  const firstPlayerRow = document.getElementById('first-player-row');
  firstPlayerRow.style.display = isEclipse ? 'flex' : 'none';

  // Show reaction card option for Eclipse
  const eclipseModeRow = document.getElementById('eclipse-mode-row');
  eclipseModeRow.style.display = isEclipse ? 'flex' : 'none';

  // Populate first player dropdown
  if (isEclipse) {
    const select = document.getElementById('first-player');
    select.innerHTML = state.boxOrder.map(id =>
      `<option value="${id}">${state.boxes[id].name} (Box ${id})</option>`
    ).join('');
  }
}

// ---- LED array helpers ----

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

function ledRainbow(n) {
  return Array.from({ length: n }, (_, i) => {
    const hue = Math.round((i / n) * 360);
    return `hsl(${hue}, 100%, 50%)`;
  });
}

function ledOff(n) {
  return Array(n).fill('#000000');
}

// ---- LED state derivation ----

const LED_COUNT = 12;

function ledStateForStatus(status) {
  switch (status) {
    case 'active':    return ledSolid(LED_COUNT, '#c9a84c');
    case 'can-react': return ledOff(LED_COUNT);
    case 'reacting':  return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':    return ledSolid(LED_COUNT, '#1a1a3a');
    case 'combat':    return ledSolid(LED_COUNT, '#8a0000');
    case 'upkeep':    return ledThirds(LED_COUNT, '#ff69b4', '#ffff00', '#ffa500');
    default:          return state.gameActive ? ledOff(LED_COUNT) : ledRainbow(LED_COUNT);
  }
}

// ---- LED sync ----

function syncLeds() {
  state.boxOrder.forEach(id => {
    const box = state.boxes[id];
    const leds = ledStateForStatus(box.status);
    box.leds = leds;
    if (!box.isVirtual) {
      sendToBox(id, { type: 'led', leds });
    }
  });
}

// ---- Game logic dispatch ----

function startGame() {
  state.gameActive = true;
  state.gameMode = document.getElementById('game-mode').value;
  state.boxOrder.forEach(id => {
    state.boxes[id].status = 'idle';
  });
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

function handleEndTurn(boxId) {
  if (!state.gameActive) return;
  switch (state.gameMode) {
    case 'clockwise':
    case 'clockwise_pass':
      clockwiseEndTurn(boxId);
      break;
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseEndTurn(boxId);
      break;
  }
}

function handlePass(boxId) {
  if (!state.gameActive) return;
  switch (state.gameMode) {
    case 'clockwise_pass':
      clockwisePass(boxId);
      break;
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipsePass(boxId);
      break;
  }
}

function handleLongPress(boxId) {
  if (!state.gameActive) return;
  switch (state.gameMode) {
    case 'eclipse_simple':
    case 'eclipse_advanced':
      eclipseLongPress(boxId);
      break;
  }
}

// ---- Clockwise mode ----

function clockwiseStart() {
  const firstId = state.boxOrder[0];
  state.activeBoxId = firstId;
  state.boxes[firstId].status = 'active';
  log(`Box ${firstId} goes first`, 'system');
}

function clockwiseNextPlayer() {
  const currentIndex = state.boxOrder.indexOf(state.activeBoxId);
  for (let i = 1; i <= state.boxOrder.length; i++) {
    const nextIndex = (currentIndex + i) % state.boxOrder.length;
    const nextId = state.boxOrder[nextIndex];
    if (state.boxes[nextId].status !== 'passed') {
      if (state.boxes[state.activeBoxId].status !== 'passed') {
        state.boxes[state.activeBoxId].status = 'idle';
      }
      state.activeBoxId = nextId;
      state.boxes[nextId].status = 'active';
      log(`Box ${nextId}'s turn`, 'system');
      return;
    }
  }
  clockwiseEndRound();
}

function clockwiseEndTurn(boxId) {
  if (boxId !== state.activeBoxId) return;
  clockwiseNextPlayer();
}

function clockwisePass(boxId) {
  if (boxId !== state.activeBoxId) return;
  state.boxes[boxId].status = 'passed';
  log(`Box ${boxId} passed`, 'system');

  const allPassed = state.boxOrder.every(
    id => state.boxes[id].status === 'passed'
  );

  if (allPassed) {
    clockwiseEndRound();
  } else {
    clockwiseNextPlayer();
  }
}

function clockwiseEndRound() {
  log('Round over — all players passed', 'system');
  state.boxOrder.forEach(id => {
    state.boxes[id].status = 'idle';
  });
  state.activeBoxId = null;
}

// ---- Eclipse mode ----

function eclipseStart() {
  const firstPlayerId = parseInt(document.getElementById('first-player').value);
  state.eclipse.firstPlayerId = firstPlayerId;
  state.eclipse.passOrder = [];
  state.eclipse.phase = 'action';
  state.eclipse.round = 1;
  eclipseBuildTurnOrder(firstPlayerId);
  eclipseActivateNext();
  log(`Eclipse started — Box ${firstPlayerId} goes first`, 'system');
}

function eclipseBuildTurnOrder(firstPlayerId) {
  if (state.gameMode === 'eclipse_advanced' && state.eclipse.passOrder.length > 0) {
    // Advanced: turn order IS the pass order
    state.eclipse.turnOrder = [...state.eclipse.passOrder];
  } else {
    // Simple (or first round of Advanced): clockwise from first player by seat
    const firstIndex = state.boxOrder.indexOf(firstPlayerId);
    state.eclipse.turnOrder = [
      ...state.boxOrder.slice(firstIndex),
      ...state.boxOrder.slice(0, firstIndex),
    ];
  }
}

function eclipseActivateNext() {
  // Find next active or can-react player in turn order
  const current = state.activeBoxId;
  const order = state.eclipse.turnOrder;
  const currentIndex = current !== null ? order.indexOf(current) : -1;

  for (let i = 1; i <= order.length; i++) {
    const nextIndex = (currentIndex + i) % order.length;
    const nextId = order[nextIndex];
    const status = state.boxes[nextId].status;

    if (status === 'idle') {
      // Normal active turn
      if (current !== null && state.boxes[current].status === 'idle') {
        state.boxes[current].status = 'idle';
      }
      state.activeBoxId = nextId;
      state.boxes[nextId].status = 'active';
      log(`Box ${nextId}'s turn`, 'system');
      return;
    }

    if (status === 'can-react') {
      // Reaction opportunity
      if (current !== null && state.boxes[current].status === 'idle') {
        state.boxes[current].status = 'idle';
      }
      state.activeBoxId = nextId;
      state.boxes[nextId].status = 'reacting';
      log(`Box ${nextId} reaction opportunity`, 'system');
      return;
    }
  }

  // No idle or can-react players found — action phase over
  eclipseEndActionPhase();
}

function eclipseEndTurn(boxId) {
  if (boxId !== state.activeBoxId) return;
  const box = state.boxes[boxId];

  if (box.status === 'reacting') {
    // Done with reaction, return to can-react
    box.status = 'can-react';
    log(`Box ${boxId} reaction done`, 'system');
  } else {
    // Normal end turn
    box.status = 'idle';
  }

  eclipseActivateNext();
}

function eclipsePass(boxId) {
  if (boxId !== state.activeBoxId) return;
  const box = state.boxes[boxId];

  if (box.status === 'reacting') {
    // Player opts out of reactions permanently
    box.status = 'passed';
    log(`Box ${boxId} opts out of reactions`, 'system');
  } else if (box.status === 'active') {
    // Player passes their action turn
    box.status = 'can-react';
    state.eclipse.passOrder.push(boxId);
    log(`Box ${boxId} passes — enters can-react`, 'system');
  }

  // Check if action phase is over
  const actionOver = state.boxOrder.every(
    id => state.boxes[id].status === 'can-react' ||
          state.boxes[id].status === 'passed'
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
    state.boxes[id].status = 'combat';
  });
  // Pulse red — placeholder until LED ring hardware arrives
  // For now just set all to combat status and show in UI
}

function eclipseLongPress(boxId) {
  // Only hub (box 0) long press advances phases
  if (boxId !== 0) return;

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
    state.boxes[id].status = 'upkeep';
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
    state.boxes[id].status = 'idle';
  });

  state.activeBoxId = null;
  state.eclipse.firstPlayerId = nextFirst;
  eclipseBuildTurnOrder(nextFirst);
  state.eclipse.passOrder = [];
  eclipseActivateNext();
  log(`New round — Box ${nextFirst} goes first`, 'system');
}

// ---- Simulator ----

function simulateButton(boxId, type) {
  log(`[SIM] Box ${boxId} pressed ${type}`, 'system');
  handleMessage({ type, box: boxId });
}

function advancePhase() {
  handleLongPress(0);
  render();
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

function renderBoxes() {
  const container = document.getElementById('box-positions');
  container.innerHTML = '';

  const ids = state.boxOrder;
  if (ids.length === 0) return;

  const positions = getBoxPositions(ids.length);

  ids.forEach((id, index) => {
    const box = state.boxes[id];
    const pos = positions[index];

    const card = document.createElement('div');
    card.className = `box-card ${box.status}`;
    card.style.left = `${pos.x}%`;
    card.style.top = `${pos.y}%`;

    card.innerHTML = `
      ${box.isVirtual ? '<div class="box-virtual">SIM</div>' : ''}
      <div class="box-name">${box.name}</div>
      ${renderLedRing(box.leds || ledOff(LED_COUNT))}
      <div class="box-id">Box ${id}</div>
      <div class="box-status">${box.status}</div>
      <div class="box-buttons">
        <button class="box-btn" onclick="simulateButton(${id}, 'endturn')">End</button>
        <button class="box-btn" onclick="simulateButton(${id}, 'pass')">Pass</button>
        <button class="box-btn" onclick="simulateButton(${id}, 'longpress')">Long</button>
      </div>
    `;

    container.appendChild(card);
  });
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
    const glow = isOn
      ? `filter: drop-shadow(0 0 2px ${color});`
      : '';
    return `<circle
      cx="${x.toFixed(2)}"
      cy="${y.toFixed(2)}"
      r="${dotRadius}"
      fill="${color}"
      style="${glow}"
    />`;
  }).join('');

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${radius + dotRadius + 1}"
        fill="none" stroke="#222" stroke-width="1"/>
      ${dots}
    </svg>
  `;
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

// ---- Init ----

render();