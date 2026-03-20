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
  boxNames: {},

  // Faction data loaded from factions.json
  factions: null,

  // Whether faction scan mode is active
  factionScanActive: false,

  // Latest firmware info from GitHub releases
  latestFirmware: null, // { version, binUrl, releaseNotes, publishedAt }

  // Current round (all game modes); totalRounds set for games with a fixed length (e.g. Eclipse = 8)
  round: 0,
  totalRounds: null,

  // Game timer
  gameStartTime: null,

  // Phase timing log — [{ phase: string, duration: ms, round: N }]
  phaseLog: [],
  currentPhaseStart: null, // { name: string, startTime: number }

  // Eclipse state
  eclipse: {
    phase: null,
    passOrder: [],
    turnOrder: [],
    firstPlayerId: null,
  },

  ti: {
  phase: null,        // 'strategy', 'action', 'status', 'agenda', 'status2'
  speakerHwid: null,
  turnOrder: [],      // sorted by initiative during action phase
  secondaryMode: 'standard', // 'fastest', 'fast', 'standard'
  mecatolControlled: false,

  // Per-player TI state, keyed by hwid
  players: {},
  // {
  //   hwid,
  //   strategyCards: [],  // [{ id, name, color, initiative, used }]
  //   passed: false,
  //   confirmedSecondary: false,
  // }

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

// ---- Firmware version helpers ----

function versionLessThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

function isVersionOutOfDate(boxVersion) {
  if (!state.latestFirmware) return false;
  if (boxVersion === 'unknown' || !boxVersion) return true;
  return versionLessThan(boxVersion, state.latestFirmware.version);
}

async function fetchLatestFirmware() {
  try {
    const resp = await fetch('https://api.github.com/repos/jakemartin-icl/herald-firmware/releases/latest');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const binAsset = data.assets?.find(a => a.name.endsWith('.bin'));
    state.latestFirmware = {
      version: (data.tag_name || data.name || '').replace(/^v/, ''),
      binUrl: binAsset?.browser_download_url || null,
      releaseNotes: data.body || '',
      publishedAt: data.published_at || '',
    };
    render();
  } catch (e) {
    console.warn('Failed to fetch latest firmware:', e);
    state.latestFirmware = null;
  }
}

fetchLatestFirmware();

// ---- Box names (session-only) ----

function getBoxName(hwid) {
  return state.boxNames[hwid]?.name || null;
}

function setBoxName(hwid, name) {
  if (!state.boxNames[hwid]) state.boxNames[hwid] = {};
  state.boxNames[hwid].name = name;
}

function defaultBoxName(hwid) {
  // Generate default name based on seat position
  const index = state.boxOrder.indexOf(hwid);
  return `Player ${index + 1}`;
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
      if (state.gameActive) syncLeds();
      break;
    case 'connected':
      addBox(msg.hwid, false);
      if (state.boxes[msg.hwid]) state.boxes[msg.hwid].version = msg.version || 'unknown';
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
    case 'rfid_write_result':
      handleRfidWriteResult(msg);
      break;
    case 'ota_progress':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].otaProgress = msg.percent;
        state.boxes[msg.hwid].otaUpdating = true;
      }
      renderOtaDialog();
      break;
    case 'ota_complete':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].version = msg.version;
        state.boxes[msg.hwid].otaProgress = 100;
        state.boxes[msg.hwid].otaUpdating = false;
        state.boxes[msg.hwid].otaError = null;
      }
      log(`${getDisplayName(msg.hwid)} firmware updated to ${msg.version}`, 'system');
      renderOtaDialog();
      break;
    case 'ota_error':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].otaError = msg.message;
        state.boxes[msg.hwid].otaUpdating = false;
        state.boxes[msg.hwid].otaProgress = null;
      }
      log(`${getDisplayName(msg.hwid)} OTA failed: ${msg.message}`, 'error');
      renderOtaDialog();
      break;
    case 'debug':
      log(`[${getDisplayName(msg.hwid)}] ${msg.msg}`, 'debug');
      return; // skip render — no game state changed
    case 'wifi_credentials':
      _wifiCredentials = (msg.credentials || []).map(c => ({ ssid: c.ssid || '', password: c.password || '' }));
      clearTimeout(_wifiCredentialsTimeout);
      renderWifiDialog();
      return;
    case 'wifi_credentials_ack': {
      const statusEl = document.getElementById('wifi-save-status');
      if (statusEl) {
        statusEl.textContent = 'Saved!';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
      return;
    }
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
    // Box reconnected — update status and clear any in-progress OTA state
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].otaUpdating = false;
    state.boxes[hwid].otaProgress = null;
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
    factionId: null,
  };

  if (state.gameActive) {
    log(`${isVirtual ? 'Virtual box' : 'Box'} ${getDisplayName(hwid)} connected mid-game`, 'system');
    offerSubstitution(hwid);
    return;
  }

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

// ---- Box substitution ----

let _pendingSubHwid = null;

function offerSubstitution(newHwid) {
  _pendingSubHwid = newHwid;
  const select = document.getElementById('sub-select');
  select.innerHTML = state.boxOrder.map(hwid => {
    const disconnected = state.boxes[hwid]?.status === 'disconnected';
    return `<option value="${hwid}"${disconnected ? ' selected' : ''}>${getDisplayName(hwid)}${disconnected ? ' (disconnected)' : ''}</option>`;
  }).join('');
  // Pre-select first disconnected box if any, otherwise leave default
  const firstDisconnected = state.boxOrder.find(h => state.boxes[h]?.status === 'disconnected');
  if (firstDisconnected) select.value = firstDisconnected;
  document.getElementById('sub-overlay').style.display = 'flex';
  render();
}

function confirmSubstitution() {
  const oldHwid = document.getElementById('sub-select').value;
  if (!oldHwid || !_pendingSubHwid || !state.boxes[oldHwid] || !state.boxes[_pendingSubHwid]) {
    cancelSubstitution();
    return;
  }
  substituteBox(oldHwid, _pendingSubHwid);
  _pendingSubHwid = null;
  document.getElementById('sub-overlay').style.display = 'none';
}

function cancelSubstitution() {
  if (_pendingSubHwid && state.boxes[_pendingSubHwid]) {
    state.boxOrder.push(_pendingSubHwid);
    log(`${getDisplayName(_pendingSubHwid)} added to game (no substitution)`, 'system');
  }
  _pendingSubHwid = null;
  document.getElementById('sub-overlay').style.display = 'none';
  updateSetupUI();
  render();
}

function substituteBox(oldHwid, newHwid) {
  const oldBox = state.boxes[oldHwid];
  const newBox = state.boxes[newHwid];
  if (!oldBox || !newBox) return;

  const oldName = getDisplayName(oldHwid);

  // Transfer game-relevant properties to new box
  ['status', 'badges', 'factionId', 'leds', 'ledOverrideUntil',
   'turnStartTime', 'totalTurnTime', 'turnHistory',
   'strategyColor', 'choosingLeds'].forEach(prop => {
    if (oldBox[prop] !== undefined) newBox[prop] = oldBox[prop];
  });

  // Carry the old display name over to the new box (works for any combination of virtual/physical)
  if (newBox.isVirtual) {
    virtualBoxNames[newHwid] = oldName;
  } else {
    setBoxName(newHwid, oldName);
  }

  // Replace in seat order (preserve position)
  const idx = state.boxOrder.indexOf(oldHwid);
  if (idx !== -1) state.boxOrder[idx] = newHwid;

  // Update every place oldHwid is referenced
  const rep = id => (id === oldHwid ? newHwid : id);
  const repArr = arr => arr.map(rep);
  const repKey = (obj, key) => { if (obj && obj[key] === oldHwid) obj[key] = newHwid; };

  repKey(state, 'activeBoxId');
  state.eclipse.passOrder   = repArr(state.eclipse.passOrder);
  state.eclipse.turnOrder   = repArr(state.eclipse.turnOrder);
  repKey(state.eclipse, 'firstPlayerId');
  state.ti.turnOrder = repArr(state.ti.turnOrder);
  repKey(state.ti, 'speakerHwid');
  if (state.ti.players?.[oldHwid]) {
    state.ti.players[newHwid] = state.ti.players[oldHwid];
    delete state.ti.players[oldHwid];
  }
  if (state.ti.secondary) {
    repKey(state.ti.secondary, 'activeHwid');
    state.ti.secondary.pendingHwids = repArr(state.ti.secondary.pendingHwids || []);
  }
  if (_timerTrackedActiveId === oldHwid) _timerTrackedActiveId = newHwid;

  const wasHub = (oldHwid === state.hubHwid);
  if (wasHub) {
    state.hubHwid = newHwid;
    log(`⚠️ Hub box substituted. If the hub hardware is being replaced, reconnect to the new hub address and power-cycle the other boxes.`, 'error');
  }

  delete state.boxes[oldHwid];
  if (oldBox.isVirtual) delete virtualBoxNames[oldHwid];
  log(`${oldName} substituted — now on ${getDisplayName(newHwid)}`, 'system');
  syncLeds();
  updateSetupUI();
  render();
}

const virtualBoxNames = {}; // session-only, never persisted

function getDisplayName(hwid) {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
    if (virtualBoxNames[hwid]) return virtualBoxNames[hwid];
    const n = parseInt(hwid.slice(VIRTUAL_BOX_ID_OFFSET.length), 10);
    return `Sim ${n + 1}`;
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
  document.getElementById('prev-stats-btn').style.display = prevGameStats ? 'block' : 'none';

  // Eclipse rows
  document.getElementById('first-player-row').style.display = isEclipse ? 'flex' : 'none';
  document.getElementById('eclipse-mode-row').style.display = isEclipse ? 'flex' : 'none';

  // TI rows
  document.getElementById('ti-speaker-row').style.display = isTi ? 'flex' : 'none';
  document.getElementById('ti-learn-tags-btn').style.display = isTi ? 'block' : 'none';

  // Faction buttons — only shown when factions.json is loaded
  const factionsLoaded = !!state.factions;
  document.getElementById('ti-learn-faction-tags-btn').style.display =
    (isTi && factionsLoaded) ? 'block' : 'none';
  document.getElementById('eclipse-learn-faction-tags-btn').style.display =
    (isEclipse && factionsLoaded) ? 'block' : 'none';
  document.getElementById('set-factions-btn').style.display =
    ((isTi || isEclipse) && factionsLoaded) ? 'block' : 'none';

  if (isEclipse) {
    const select = document.getElementById('first-player');
    select.innerHTML = state.boxOrder.map(hwid => {
      const faction = state.factions ? getFactionForBox(hwid) : null;
      const label = faction ? `${getDisplayName(hwid)} — ${faction.name}` : getDisplayName(hwid);
      return `<option value="${hwid}">${label}</option>`;
    }).join('');
  }

  if (isTi) {
    const select = document.getElementById('ti-speaker');
    select.innerHTML = state.boxOrder.map(hwid => {
      const faction = state.factions ? getFactionForBox(hwid) : null;
      const label = faction ? `${getDisplayName(hwid)} — ${faction.name}` : getDisplayName(hwid);
      return `<option value="${hwid}">${label}</option>`;
    }).join('');
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

function ledEveryFourth(n, color) {
  return Array.from({ length: n }, (_, i) => i % 4 === 0 ? color : '#000000');
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

function ledStateForStatus(status, box = null, hwid = null) {
  switch (status) {
    case 'active':       return ledSolid(LED_COUNT, '#c9a84c');
    case 'can-react':
      if (hwid && state.gameMode.startsWith('eclipse') && hwid === state.eclipse.passOrder[0]) {
        return ledEveryFourth(LED_COUNT, '#d4a017'); // gold — first to pass, gains 2 money
      }
      return ledOff(LED_COUNT);
    case 'reacting':     return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':       return ledSolid(LED_COUNT, '#1a1a3a');
    case 'combat':       return ledSolid(LED_COUNT, '#8a0000');
    case 'upkeep':       return ledThirds(LED_COUNT, '#d4a017', '#e64da0', '#cc7700');
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
  if (state.factionScanActive) return; // faction scan manages its own LEDs
  const now = Date.now();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
    if (box.status === 'upkeep') return; // upkeep animation manages its own LEDs
    const leds = ledStateForStatus(box.status, box, hwid);
    box.leds = leds;
    if (!box.isVirtual) {
      sendToBox(hwid, { type: 'led', leds });
    }
  });
}

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

// ---- Turn time graphs ----

const SORT_MODES  = ['table', 'name', 'faction', 'highest'];
const SORT_LABELS = { table: 'Table order', name: 'Name', faction: 'Faction', highest: 'Highest' };

let graphType     = 'total';
let graphSort     = 'table';
let graphSource   = 'live'; // 'live' | 'prev'
let prevGameStats = null;
let _graphInterval = null;

function snapshotPlayer(id) {
  const box = state.boxes[id];
  const faction = getFactionForBox(id);
  const inProgress = box.turnStartTime ? Date.now() - box.turnStartTime : 0;
  return {
    name: getDisplayName(id),
    color: faction?.color || '#c9a84c',
    factionName: faction?.name || '',
    totalTurnTime: (box.totalTurnTime || 0) + inProgress,
    // turnHistory entries are { duration, round }; append in-progress as current round
    turnHistory: [
      ...(box.turnHistory || []),
      ...(inProgress > 0 ? [{ duration: inProgress, round: getCurrentRound() }] : []),
    ],
  };
}

function captureGameStats() {
  const modeNames = {
    clockwise: 'Clockwise', clockwise_pass: 'Clockwise with Passing',
    eclipse_simple: 'Eclipse — Simple', eclipse_advanced: 'Eclipse — Advanced',
    ti: 'Twilight Imperium',
  };
  // Snapshot current phase into log before capturing (don't mutate state)
  const phaseLog = [...state.phaseLog];
  if (state.currentPhaseStart) {
    phaseLog.push({ phase: state.currentPhaseStart.name, duration: Date.now() - state.currentPhaseStart.startTime, round: state.round });
  }
  prevGameStats = {
    gameMode: modeNames[state.gameMode] || state.gameMode,
    players: state.boxOrder.filter(id => state.boxes[id]).map(snapshotPlayer),
    totalGameTime: state.gameStartTime ? Date.now() - state.gameStartTime : null,
    phaseLog,
    playerCount: state.boxOrder.filter(id => state.boxes[id]).length,
  };
}

function getGraphPlayers() {
  if (graphSource === 'prev' && prevGameStats) return prevGameStats.players;
  return state.boxOrder.filter(id => state.boxes[id]).map(snapshotPlayer);
}

function graphValueForPlayer(player) {
  const hist = player.turnHistory;
  switch (graphType) {
    case 'total':   return player.totalTurnTime;
    case 'longest': return hist.length > 0 ? Math.max(...hist.map(t => t.duration)) : 0;
    case 'average': return hist.length > 0 ? Math.round(player.totalTurnTime / hist.length) : 0;
    case 'turns':   return hist.length;
    default:        return 0;
  }
}

function getSortedPlayers() {
  const players = getGraphPlayers();
  if (graphSort === 'name')    return players.sort((a, b) => a.name.localeCompare(b.name));
  if (graphSort === 'faction') return players.sort((a, b) => a.factionName.localeCompare(b.factionName));
  if (graphSort === 'highest') return players.sort((a, b) => graphValueForPlayer(b) - graphValueForPlayer(a));
  return players;
}

function getPhaseLog() {
  if (graphSource === 'prev' && prevGameStats) return prevGameStats.phaseLog;
  const log = [...state.phaseLog];
  if (state.currentPhaseStart) {
    log.push({ phase: state.currentPhaseStart.name, duration: Date.now() - state.currentPhaseStart.startTime, round: state.round });
  }
  return log;
}

function getDistinctPhases() {
  const seen = new Set();
  return getPhaseLog().filter(e => !seen.has(e.phase) && seen.add(e.phase)).map(e => e.phase);
}

function getPhaseRoundItems(phaseName) {
  return getPhaseLog()
    .filter(e => e.phase === phaseName)
    .sort((a, b) => (a.round || 0) - (b.round || 0))
    .map(e => ({ name: `Round ${e.round ?? '?'}`, color: '#c9a84c', value: e.duration }));
}

function getRoundItems() {
  const roundMap = {};
  getGraphPlayers().forEach(player => {
    player.turnHistory.forEach(({ duration, round }) => {
      if (round == null) return;
      if (!roundMap[round]) roundMap[round] = { total: 0, count: 0 };
      roundMap[round].total += duration;
      roundMap[round].count++;
    });
  });
  return Object.entries(roundMap)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([round, { total, count }]) => ({
      name: `Round ${round}`,
      color: '#c9a84c',
      value: count > 0 ? Math.round(total / count) : 0,
    }));
}

function getGraphItems() {
  if (graphType === 'by_round') return getRoundItems();
  if (graphType.startsWith('phase:')) return getPhaseRoundItems(graphType.slice(6));
  return getSortedPlayers().map(p => ({ name: p.name, color: p.color, value: graphValueForPlayer(p) }));
}

function formatGraphValue(value) {
  if (graphType === 'turns') return value > 0 ? String(value) : '0';
  return value > 0 ? formatDuration(value) : '—';
}

function renderGraph() {
  const el = document.getElementById('graph-content');
  if (!el) return;
  if (graphType === 'stats') { renderStats(); return; }
  const items  = getGraphItems();
  const maxVal = Math.max(...items.map(i => i.value), 1);
  el.innerHTML = items.map(item => {
    const pct = (item.value / maxVal * 100).toFixed(1);
    return `<div class="graph-row">
      <div class="graph-name" style="color:${item.color}">${item.name}</div>
      <div class="graph-bar-wrap">
        <div class="graph-bar" style="width:${pct}%;background:${item.color}66;border-right:2px solid ${item.color}"></div>
      </div>
      <div class="graph-val">${formatGraphValue(item.value)}</div>
    </div>`;
  }).join('');
}

function renderStats() {
  const el = document.getElementById('graph-content');
  if (!el) return;

  const isPrev = graphSource === 'prev' && prevGameStats;
  const gameTime = isPrev
    ? prevGameStats.totalGameTime
    : (state.gameStartTime ? Date.now() - state.gameStartTime : null);
  const playerCount = isPrev
    ? prevGameStats.playerCount
    : state.boxOrder.filter(id => state.boxes[id]).length;

  const phaseLog = getPhaseLog();

  const players = getGraphPlayers();
  const allTurns = players.flatMap(p => p.turnHistory.map(t => t.duration));
  const overallAvg = allTurns.length > 0
    ? Math.round(allTurns.reduce((s, d) => s + d, 0) / allTurns.length) : null;

  const rows = [];

  if (gameTime != null) {
    rows.push({ label: 'Total game time', value: formatDuration(gameTime) });
    if (playerCount > 0) {
      rows.push({ label: 'Game time per player', value: formatDuration(Math.round(gameTime / playerCount)) });
    }
  }

  rows.push({ label: 'Overall avg turn time', value: overallAvg != null ? formatDuration(overallAvg) : '—' });

  // Phase totals — one row per distinct phase name, in order of first appearance
  if (phaseLog.length > 0) {
    const phaseTotals = {};
    const phaseOrder = [];
    phaseLog.forEach(({ phase, duration }) => {
      if (!phaseTotals[phase]) { phaseTotals[phase] = 0; phaseOrder.push(phase); }
      phaseTotals[phase] += duration;
    });
    phaseOrder.forEach(phase => {
      const label = phase.charAt(0).toUpperCase() + phase.slice(1);
      rows.push({ label: `Total ${label} time`, value: formatDuration(phaseTotals[phase]) });
    });
  }

  el.innerHTML = `<div class="stats-list">${rows.map(r =>
    `<div class="stats-row"><span class="stats-label">${r.label}</span><span class="stats-val">${r.value}</span></div>`
  ).join('')}</div>`;
}

function renderGraphOverlay() {
  const title = graphSource === 'prev' && prevGameStats
    ? `Previous game — ${prevGameStats.gameMode}`
    : 'Current game';
  document.getElementById('graph-dialog-title').textContent = title;

  // Rebuild phase-by-round options dynamically
  const select = document.getElementById('graph-type-select');
  Array.from(select.options).filter(o => o.value.startsWith('phase:')).forEach(o => o.remove());
  const statsOpt = Array.from(select.options).find(o => o.value === 'stats');
  getDistinctPhases().forEach(phase => {
    const opt = document.createElement('option');
    opt.value = `phase:${phase}`;
    opt.textContent = `${phase.charAt(0).toUpperCase() + phase.slice(1)} time by round`;
    select.insertBefore(opt, statsOpt);
  });
  if (!Array.from(select.options).some(o => o.value === graphType)) graphType = 'total';
  select.value = graphType;

  const sortBtn = document.getElementById('graph-sort-btn');
  sortBtn.textContent = `Sort: ${SORT_LABELS[graphSort]}`;
  const hideSort = graphType === 'by_round' || graphType === 'stats' || graphType.startsWith('phase:');
  sortBtn.style.display = hideSort ? 'none' : '';
  renderGraph();
}

function openGraphOverlay(source = 'live') {
  graphSource = source;
  document.getElementById('graph-overlay').style.display = 'flex';
  renderGraphOverlay();
  if (source === 'live') _graphInterval = setInterval(renderGraph, 1000);
}

function closeGraphOverlay() {
  document.getElementById('graph-overlay').style.display = 'none';
  if (_graphInterval) { clearInterval(_graphInterval); _graphInterval = null; }
}

function cycleGraphSort() {
  const idx = SORT_MODES.indexOf(graphSort);
  graphSort = SORT_MODES[(idx + 1) % SORT_MODES.length];
  renderGraphOverlay();
}

function onGraphTypeChange(val) {
  graphType = val;
  renderGraphOverlay(); // also updates sort button visibility
}

function renderTimerInfo(hwid, box) {
  if (!timerSettings.showCurrent && !timerSettings.showTotal) return '';
  const parts = [];
  if (timerSettings.showCurrent && box.turnStartTime) {
    parts.push(formatDuration(Date.now() - box.turnStartTime));
  }
  if (timerSettings.showTotal) {
    const total = (box.totalTurnTime || 0) + (box.turnStartTime ? Date.now() - box.turnStartTime : 0);
    if (total > 0) parts.push(`Σ ${formatDuration(total)}`);
  }
  if (parts.length === 0) return '';
  return `<div class="box-timer">${parts.join(' · ')}</div>`;
}

// ---- Game logic dispatch ----

function startGame() {
  state.gameActive = true;
  document.getElementById('setup-panel').style.display = 'none';
  state.gameMode = document.getElementById('game-mode').value;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].badges = [];
    state.boxes[hwid].factionId = null;
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
  state.round++;
  const firstId = state.boxOrder[0];
  state.activeBoxId = firstId;
  state.boxes[firstId].status = 'active';
  log(`Round ${state.round} — ${getDisplayName(firstId)} goes first`, 'system');
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
      // In non-passing clockwise, wrapping to the first player starts a new round
      if (state.gameMode === 'clockwise' && nextIndex === 0) {
        state.round++;
        log(`Round ${state.round} — ${getDisplayName(nextId)}'s turn`, 'system');
      } else {
        log(`${getDisplayName(nextId)}'s turn`, 'system');
      }
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
  startPhase('combat');
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

// ---- Simulator ----

function simulateButton(hwid, type) {
  log(`[SIM] ${getDisplayName(hwid)} pressed ${type}`, 'system');
  handleMessage({ type, hwid });
}

function getSimRfidOptions() {
  if (state.factionScanActive) {
    // During faction scan, return factions for current game mode
    if (!state.factions) return [];
    const gameKey = state.gameMode === 'ti' ? 'twilight_imperium' : 'eclipse';
    const factions = state.factions[gameKey] || [];
    return factions.map(f => ({
      id: `sim:${state.gameMode === 'ti' ? 'ti' : 'eclipse'}:faction:${f.id}`,
      label: f.name,
    }));
  }

  // Build options from the write queues for the current game mode
  const queue = state.gameMode === 'ti'
    ? [...buildTiTagQueue(), ...buildTiFactionTagQueue()]
    : buildEclipseFactionTagQueue();
  return queue.map(item => ({ id: item.internalId, label: item.prompt }));
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
  if (!tagWritingActive) return;
  const item = tagWritingQueue[tagWritingIndex];
  if (!item) return;
  document.getElementById('tag-writing-status').textContent = 'Written (simulated)';
  tagWritingIndex++;
  setTimeout(showNextTagPrompt, 800);
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
  updateTurnTimers();
  syncLeds();
  renderBoxes();
  renderTableLabel();
  renderGameControls();
}

function renderTableLabel() {
  const el = document.getElementById('table-label');
  if (!state.gameActive) {
    el.innerHTML = 'No game in progress';
    return;
  }
  const parts = [];
  if (timerSettings.showGameTimer && state.gameStartTime) {
    parts.push(`<div class="game-timer-display">${formatDuration(Date.now() - state.gameStartTime)}</div>`);
  }
  if (state.round) {
    const roundStr = `Round ${state.round}${state.totalRounds ? ' / ' + state.totalRounds : ''}`;
    parts.push(`<div class="round-counter">${roundStr}</div>`);
  }
  if (state.gameMode === 'ti') {
    const phase = state.ti.phase || '';
    parts.push(`<div class="game-mode-label">TI${phase ? ` — ${phase.replace(/_/g,' ').toUpperCase()}` : ''}</div>`);
  } else if (state.gameMode.startsWith('eclipse')) {
    parts.push(`<div class="game-mode-label">${state.eclipse.phase ? state.eclipse.phase.toUpperCase() : 'ECLIPSE'}</div>`);
  } else {
    parts.push(`<div class="game-mode-label">ROUND IN PROGRESS</div>`);
  }
  el.innerHTML = parts.join('');
}

function renderGameControls() {
  const panel = document.getElementById('game-controls');
  if (!state.gameActive) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const modeNames = {
    clockwise: 'Clockwise',
    clockwise_pass: 'Clockwise with Passing',
    eclipse_simple: 'Eclipse — Simple',
    eclipse_advanced: 'Eclipse — Advanced',
    ti: 'Twilight Imperium',
  };
  document.getElementById('gc-mode-name').textContent = modeNames[state.gameMode] || state.gameMode;

  const statusEl = document.getElementById('gc-status');
  const actionsEl = document.getElementById('gc-actions');
  const statusLines = [];
  const actionDefs = []; // { html, id, event, fn }

  if (state.gameMode === 'ti') {
    const phase = state.ti.phase || '';
    const phaseNames = {
      strategy: 'Strategy Phase',
      action: 'Action Phase',
      status: 'Status Phase',
      status2: 'Status Phase II',
      agenda_reveal: 'Agenda Phase — Reveal',
      when_agenda_revealed: 'Agenda Phase — When',
      after_agenda_revealed: 'Agenda Phase — After',
      agenda_vote: 'Agenda Phase — Vote',
    };
    statusLines.push(`Round ${state.round} · ${phaseNames[phase] || phase || '—'}`);
    if (state.ti.speakerHwid) statusLines.push(`Speaker: ${getDisplayName(state.ti.speakerHwid)}`);
    if (state.activeBoxId) statusLines.push(`Active: ${getDisplayName(state.activeBoxId)}`);
    if (['agenda_reveal','when_agenda_revealed','after_agenda_revealed','agenda_vote'].includes(phase)) {
      statusLines.push(`Agenda ${(state.ti.agendaCount || 0) + 1} of 2`);
    }

    const tiAdvancePhases = ['status','status2','agenda_reveal','when_agenda_revealed','after_agenda_revealed','agenda_vote'];
    if (tiAdvancePhases.includes(phase)) {
      actionDefs.push({ html: '<button id="gc-advance">Advance Phase</button>', id: 'gc-advance', fn: advancePhase });
    }
    if (phase === 'strategy') {
      actionDefs.push({ html: '<button id="gc-undo">Undo Strategy Pick</button>', id: 'gc-undo', fn: () => { tiUndoStrategyPick(); render(); } });
    }
    actionDefs.push({
      html: `<div class="gc-secondary-row">
        <span>Secondary:</span>
        <select id="gc-secondary">
          <option value="fastest"${state.ti.secondaryMode === 'fastest' ? ' selected' : ''}>Fastest</option>
          <option value="fast"${state.ti.secondaryMode === 'fast' ? ' selected' : ''}>Fast</option>
          <option value="standard"${state.ti.secondaryMode === 'standard' ? ' selected' : ''}>Standard</option>
        </select>
      </div>`,
      id: 'gc-secondary', event: 'change',
      fn: (e) => { state.ti.secondaryMode = e.target.value; log(`Secondary mode: ${e.target.value}`, 'system'); },
    });
    actionDefs.push({
      html: `<label class="gc-check-row">
        <input type="checkbox" id="gc-mecatol"${state.ti.mecatolControlled ? ' checked' : ''}>
        Mecatol Rex controlled
      </label>`,
      id: 'gc-mecatol', event: 'change',
      fn: (e) => { state.ti.mecatolControlled = e.target.checked; log(`Mecatol ${e.target.checked ? 'controlled' : 'not controlled'}`, 'system'); },
    });
    if (state.factions) {
      actionDefs.push({ html: '<button id="gc-factions">Set Factions</button>', id: 'gc-factions', fn: startFactionScan });
    }

  } else if (state.gameMode.startsWith('eclipse')) {
    const phase = state.eclipse.phase || '';
    const phaseLabel = phase.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    statusLines.push(`Round ${state.round}${state.totalRounds ? ' / ' + state.totalRounds : ''}${phaseLabel ? ` · ${phaseLabel}` : ''}`);
    if (state.activeBoxId) statusLines.push(`Active: ${getDisplayName(state.activeBoxId)}`);

    // Next turn order — shown during action phase once someone has passed
    if (phase === 'action' && state.eclipse.passOrder.length > 0) {
      const isAdvanced = state.gameMode === 'eclipse_advanced';
      let nextOrder;
      if (isAdvanced) {
        // Confirmed positions from passOrder; remaining active players are TBD
        nextOrder = state.eclipse.passOrder.map(id => getDisplayName(id));
        const remaining = state.boxOrder.filter(id =>
          !state.eclipse.passOrder.includes(id) &&
          state.boxes[id].status !== 'disconnected' &&
          state.boxes[id].status !== 'passed'
        );
        if (remaining.length > 0) nextOrder.push('…');
      } else {
        // Simple: full clockwise order starting from first passer
        const firstNext = state.eclipse.passOrder[0];
        const firstIdx = state.boxOrder.indexOf(firstNext);
        nextOrder = [
          ...state.boxOrder.slice(firstIdx),
          ...state.boxOrder.slice(0, firstIdx),
        ].filter(id => state.boxes[id].status !== 'disconnected')
         .map(id => getDisplayName(id));
      }
      statusLines.push(`Next order: ${nextOrder.join(' → ')}`);
    }

    if (['combat', 'upkeep'].includes(phase)) {
      actionDefs.push({ html: '<button id="gc-advance">Advance Phase</button>', id: 'gc-advance', fn: advancePhase });
    }
    if (phase === 'upkeep') {
      actionDefs.push({
        html: `<div class="gc-swatch-row">
          <span class="gc-swatch" style="background:${UPKEEP_GOLD}"></span>Money
          <span class="gc-swatch" style="background:${UPKEEP_PINK}"></span>Science
          <span class="gc-swatch" style="background:${UPKEEP_BROWN}"></span>Materials
        </div>`,
      });
    }

  } else {
    // Clockwise modes
    statusLines.push(`Round ${state.round}`);
    if (!state.activeBoxId) {
      statusLines.push('Round over — all passed');
      actionDefs.push({ html: '<button id="gc-new-round">New Round</button>', id: 'gc-new-round', fn: () => { clockwiseStart(); render(); } });
    } else {
      statusLines.push(`Active: ${getDisplayName(state.activeBoxId)}`);
    }
  }

  actionDefs.push({ html: '<button id="gc-graphs">Graphs</button>', id: 'gc-graphs', fn: () => openGraphOverlay('live') });
  actionDefs.push({
    html: `<label class="gc-check-row">
      <input type="checkbox" id="gc-timer-game"${timerSettings.showGameTimer ? ' checked' : ''}>
      Show game timer
    </label>`,
    id: 'gc-timer-game', event: 'change',
    fn: (e) => {
      timerSettings.showGameTimer = e.target.checked;
      stopCurrentTimerInterval();
      if (needsTimerInterval()) startCurrentTimerInterval();
      renderTableLabel();
    },
  });
  actionDefs.push({
    html: `<label class="gc-check-row">
      <input type="checkbox" id="gc-timer-current"${timerSettings.showCurrent ? ' checked' : ''}>
      Show turn time
    </label>`,
    id: 'gc-timer-current', event: 'change',
    fn: (e) => {
      timerSettings.showCurrent = e.target.checked;
      stopCurrentTimerInterval();
      if (needsTimerInterval()) startCurrentTimerInterval();
      renderBoxes();
    },
  });
  actionDefs.push({
    html: `<label class="gc-check-row">
      <input type="checkbox" id="gc-timer-total"${timerSettings.showTotal ? ' checked' : ''}>
      Show total time
    </label>`,
    id: 'gc-timer-total', event: 'change',
    fn: (e) => { timerSettings.showTotal = e.target.checked; renderBoxes(); },
  });
  if (silentAudioContext) {
    const running = silentAudioContext.state === 'running';
    statusLines.push(running
      ? '<span style="color:#4a7">🔇 Background keepalive active</span>'
      : '<span style="color:#c94">⚠️ Background keepalive inactive</span>'
    );
  }

  actionDefs.push({ html: '<button class="end-game-btn" id="gc-end-game">End Game</button>', id: 'gc-end-game', fn: confirmEndGame });

  statusEl.innerHTML = statusLines.map(l => `<div>${l}</div>`).join('');
  actionsEl.innerHTML = actionDefs.map(a => a.html).join('');
  actionDefs.forEach(({ id, event, fn }) => {
    if (!id || !fn) return;
    const el = actionsEl.querySelector(`#${id}`);
    if (el) el.addEventListener(event || 'click', fn);
  });
}

function confirmEndGame() {
  document.getElementById('end-game-overlay').style.display = 'flex';
}

function cancelEndGame() {
  document.getElementById('end-game-overlay').style.display = 'none';
}

function endGame() {
  cancelEndGame();
  state.gameActive = false;
  state.activeBoxId = null;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].badges = [];
    state.boxes[hwid].factionId = null;
    state.boxes[hwid].leds = null;
  });
  state.round = 0;
  state.totalRounds = null;
  state.eclipse = { phase: null, passOrder: [], turnOrder: [], firstPlayerId: null };
  state.ti = { ...state.ti, phase: null, speakerHwid: null, turnOrder: [], players: {}, secondary: null, agendaCount: 0 };
  endPhase();
  captureGameStats();
  state.gameStartTime = null;
  state.phaseLog = [];
  state.currentPhaseStart = null;
  resetTurnTimers();
  stopCurrentTimerInterval();
  state.factionScanActive = false;
  document.getElementById('faction-scan-banner').style.display = 'none';
  releaseWakeLock();
  if (silentAudioContext) silentAudioContext.suspend();
  document.getElementById('setup-panel').style.display = '';
  log('Game ended', 'system');
  render();
  updateSetupUI();
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
  const badges = [...(box.badges || [])];

  if (state.latestFirmware && isVersionOutOfDate(box.version)) {
    badges.push({
      type: 'icon', value: '⚠️',
      label: `Firmware out of date (${box.version || 'unknown'} → ${state.latestFirmware.version})`,
    });
  }

  if (badges.length === 0) return '';

  const items = badges.map(badge => {
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

// ---- Drag-to-reorder state ----

let dragSourceHwid = null;
let dragOverHwid = null;

function swapBoxOrder(a, b) {
  const ia = state.boxOrder.indexOf(a);
  const ib = state.boxOrder.indexOf(b);
  if (ia === -1 || ib === -1 || ia === ib) return;
  [state.boxOrder[ia], state.boxOrder[ib]] = [state.boxOrder[ib], state.boxOrder[ia]];
}

function renderBoxes() {
  const container = document.getElementById('box-positions');
  container.innerHTML = '';

  const ids = state.boxOrder;
  if (ids.length === 0) return;

  const positions = getBoxPositions(ids.length);
  const canDrag = !state.gameActive;

  ids.forEach((hwid, index) => {
    const box = state.boxes[hwid];
    const pos = positions[index];
    const leds = box.leds || ledStateForStatus(box.status, box, hwid);

    const card = document.createElement('div');
    card.className = `box-card ${box.status}`;
    card.style.left = `${pos.x}%`;
    card.style.top = `${pos.y}%`;
    card.dataset.hwid = hwid;
    const faction = getFactionForBox(hwid);
    if (faction) {
      card.style.setProperty('--faction-color', faction.color);
    }

    const escapedHwid = CSS.escape(hwid);
    const factionSubtitle = (faction && isManuallyRenamed(hwid))
      ? `<div class="box-faction-subtitle" style="color:${faction.color}">${faction.name}</div>`
      : '';
    const nameHtml = editingNameHwid === hwid
      ? `<input id="name-input-${escapedHwid}" class="box-name-input"
           value="${getDisplayName(hwid).replace(/"/g, '&quot;')}"
           onblur="saveEditingName('${hwid}')"
           onkeydown="if(event.key==='Enter'){this.blur();}if(event.key==='Escape'){cancelEditingName();}"
           onclick="event.stopPropagation()" />`
      : `<div class="box-name" onclick="startEditingName('${hwid}', event)">${getDisplayName(hwid)}</div>${factionSubtitle}`;

    const dragHandle = canDrag ? `<div class="drag-handle">⠿</div>` : '';

    card.innerHTML = `
      ${dragHandle}
      ${nameHtml}
      ${renderLedRing(leds)}
      <div class="box-status">${box.status}</div>
      ${renderBadges(box)}
      ${renderTimerInfo(hwid, box)}
      ${renderSimControls(hwid)}
    `;

    card.onclick = (e) => {
      if (e.target === card || e.target.classList.contains('box-status')) {
        toggleSim(hwid);
      }
    };

    if (canDrag) {
      card.draggable = true;

      card.addEventListener('dragstart', (e) => {
        dragSourceHwid = hwid;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      card.addEventListener('dragend', () => {
        dragSourceHwid = null;
        document.querySelectorAll('.box-card.dragging, .box-card.drag-over')
          .forEach(el => el.classList.remove('dragging', 'drag-over'));
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragOverHwid !== hwid) {
          document.querySelectorAll('.box-card.drag-over')
            .forEach(el => el.classList.remove('drag-over'));
          dragOverHwid = hwid;
          card.classList.add('drag-over');
        }
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over');
        if (dragOverHwid === hwid) dragOverHwid = null;
      });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragSourceHwid && dragSourceHwid !== hwid) {
          swapBoxOrder(dragSourceHwid, hwid);
          dragSourceHwid = null;
          dragOverHwid = null;
          updateSetupUI();
          render();
        }
      });

      // Touch support
      card.addEventListener('touchstart', (e) => {
        dragSourceHwid = hwid;
        card.classList.add('dragging');
      }, { passive: true });

      card.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetCard = el && el.closest('.box-card');
        const targetHwid = targetCard && targetCard.dataset.hwid;
        if (targetHwid && targetHwid !== dragOverHwid) {
          document.querySelectorAll('.box-card.drag-over')
            .forEach(c => c.classList.remove('drag-over'));
          dragOverHwid = targetHwid;
          if (targetHwid !== dragSourceHwid) targetCard.classList.add('drag-over');
        }
      }, { passive: true });

      card.addEventListener('touchend', () => {
        document.querySelectorAll('.box-card.dragging, .box-card.drag-over')
          .forEach(el => el.classList.remove('dragging', 'drag-over'));
        if (dragSourceHwid && dragOverHwid && dragSourceHwid !== dragOverHwid) {
          swapBoxOrder(dragSourceHwid, dragOverHwid);
          updateSetupUI();
          render();
        }
        dragSourceHwid = null;
        dragOverHwid = null;
      });
    }

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

// ---- Name editing ----

let editingNameHwid = null;

function startEditingName(hwid, event) {
  event.stopPropagation();
  editingNameHwid = hwid;
  render();
  const input = document.getElementById(`name-input-${CSS.escape(hwid)}`);
  if (input) { input.focus(); input.select(); }
}

function saveEditingName(hwid) {
  if (editingNameHwid !== hwid) return; // already cancelled
  const input = document.getElementById(`name-input-${CSS.escape(hwid)}`);
  const newName = input ? input.value.trim() : '';
  if (newName) {
    if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
      virtualBoxNames[hwid] = newName;
      manuallyRenamedBoxes.add(hwid);
    } else {
      setBoxName(hwid, newName);
      state.boxNames[hwid].manual = true;
      saveBoxNames();
    }
  }
  editingNameHwid = null;
  updateSetupUI();
  render();
}

function cancelEditingName() {
  editingNameHwid = null;
  render();
}

// ---- Sim toggle ----

const manuallyRenamedBoxes = new Set();

function isManuallyRenamed(hwid) {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) return manuallyRenamedBoxes.has(hwid);
  return !!state.boxNames[hwid]?.manual;
}

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
      eclipseAdvancePhase();
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

// ---- Tag Writing ----

let tagWritingQueue = [];
let tagWritingIndex = 0;
let tagWritingActive = false;
let tagWritingPending = false;

function buildTiTagQueue() {
  return [
    { prompt: 'Tap the Speaker Token on the hub box', internalId: 'ti:token:speaker', simId: 'sim:ti:token:speaker' },
    { prompt: 'Tap the Leadership card on the hub box', internalId: 'ti:strategy:leadership', simId: 'sim:ti:strategy:leadership' },
    { prompt: 'Tap the Diplomacy card on the hub box', internalId: 'ti:strategy:diplomacy', simId: 'sim:ti:strategy:diplomacy' },
    { prompt: 'Tap the Politics card on the hub box', internalId: 'ti:strategy:politics', simId: 'sim:ti:strategy:politics' },
    { prompt: 'Tap the Construction card on the hub box', internalId: 'ti:strategy:construction', simId: 'sim:ti:strategy:construction' },
    { prompt: 'Tap the Trade card on the hub box', internalId: 'ti:strategy:trade', simId: 'sim:ti:strategy:trade' },
    { prompt: 'Tap the Warfare card on the hub box', internalId: 'ti:strategy:warfare', simId: 'sim:ti:strategy:warfare' },
    { prompt: 'Tap the Technology card on the hub box', internalId: 'ti:strategy:technology', simId: 'sim:ti:strategy:technology' },
    { prompt: 'Tap the Imperial card on the hub box', internalId: 'ti:strategy:imperial', simId: 'sim:ti:strategy:imperial' },
  ];
}

function buildTiFactionTagQueue() {
  if (!state.factions) return [];
  return state.factions.twilight_imperium.map(f => ({
    prompt: `Tap ${f.name}'s home system tile on the hub box`,
    internalId: `ti:faction:${f.id}`,
    simId: `sim:ti:faction:${f.id}`,
  }));
}

function buildEclipseFactionTagQueue() {
  if (!state.factions) return [];
  return state.factions.eclipse.map(f => ({
    prompt: `Tap ${f.name}'s faction box on the hub box`,
    internalId: `eclipse:faction:${f.id}`,
    simId: `sim:eclipse:faction:${f.id}`,
  }));
}

function startTagWriting(queue, title) {
  tagWritingQueue = queue;
  tagWritingIndex = 0;
  tagWritingActive = true;
  document.getElementById('tag-writing-title').textContent = title || 'Write Tags';
  document.getElementById('tag-writing-overlay').style.display = 'flex';
  showNextTagPrompt();
}

function showNextTagPrompt() {
  if (tagWritingIndex >= tagWritingQueue.length) {
    finishTagWriting();
    return;
  }
  const item = tagWritingQueue[tagWritingIndex];
  document.getElementById('tag-writing-prompt').textContent = item.prompt;
  document.getElementById('tag-writing-status').textContent =
    `${tagWritingIndex} of ${tagWritingQueue.length} written`;
}

function handleTagWriting(internalId) {
  if (!tagWritingActive || tagWritingPending) return;
  tagWritingPending = true;
  document.getElementById('tag-writing-status').textContent = 'Writing…';
  sendRfidWrite(tagWritingQueue[tagWritingIndex].internalId);
}

function handleRfidWriteResult(msg) {
  tagWritingPending = false;
  if (msg.success) {
    document.getElementById('tag-writing-status').textContent = '✓ Written';
    tagWritingIndex++;
    setTimeout(showNextTagPrompt, 800);
  } else {
    document.getElementById('tag-writing-status').textContent = `✗ Failed: ${msg.error || 'Unknown error'}`;
  }
}

function sendRfidWrite(internalId) {
  if (!state.hubHwid) return;
  sendToBox(state.hubHwid, { type: 'rfid_write', hwid: state.hubHwid, internalId });
}

function finishTagWriting() {
  tagWritingActive = false;
  document.getElementById('tag-writing-overlay').style.display = 'none';
  log('Tag writing complete', 'system');
  updateSetupUI();
}

function cancelTagWriting() {
  tagWritingActive = false;
  tagWritingPending = false;
  tagWritingIndex = 0;
  tagWritingQueue = [];
  document.getElementById('tag-writing-overlay').style.display = 'none';
}

function handleRfid(hwid, internalId) {
  if (tagWritingActive) {
    if (hwid === state.hubHwid) handleTagWriting(internalId);
    return;
  }

  if (state.factionScanActive) {
    handleFactionScan(hwid, internalId);
    return;
  }

  if (!state.gameActive) return;

  const parts = internalId.split(':');
  if (parts.length < 2) {
    log(`Unknown tag: ${internalId}`, 'error');
    return;
  }
  const game = parts[0];
  const category = parts[1];
  const id = parts.slice(2).join(':');

  if (state.gameMode === 'ti') {
    handleTiTag(hwid, game, category, id);
  } else if (state.gameMode.startsWith('eclipse')) {
    handleEclipseTag(hwid, game, category, id);
  }
}

function handleTiTag(hwid, game, category, id) {
  if (game !== 'ti') { log(`Tag game mismatch: expected ti, got ${game}`, 'error'); return; }

  if (category === 'token' && id === 'speaker') {
    if (hwid === state.activeBoxId) {
      state.ti.speakerHwid = hwid;
      log(`${getDisplayName(hwid)} takes the speaker token`, 'system');
      updateTiBadges();
    }
    return;
  }

  if (category === 'strategy') {
    // Look up label/color/initiative from factions data or fallback constants
    const label = TI_STRATEGY_LABELS[id] || id;
    const color = TI_STRATEGY_COLORS[id] || '#ffffff';
    const initiative = TI_STRATEGY_INITIATIVES[id] || 99;

    if (state.ti.phase === 'strategy') {
      if (hwid !== state.activeBoxId) return;
      const player = state.ti.players[hwid];
      const alreadyTaken = state.boxOrder.some(pid =>
        state.ti.players[pid].strategyCards.some(c => c.id === id)
      );
      if (alreadyTaken) { log(`${label} already taken`, 'error'); return; }
      player.strategyCards.push({ id, label, color, initiative, used: false });
      log(`${getDisplayName(hwid)} takes ${label}`, 'system');
      updateTiBadges();
      const pulseLeds = ledSolid(LED_COUNT, color);
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
      if (hwid !== state.activeBoxId) return;
      const player = state.ti.players[hwid];
      const card = player.strategyCards.find(c => c.id === id);
      if (!card) { log(`${getDisplayName(hwid)} doesn't have ${label}`, 'error'); return; }
      tiUseStrategyCard(hwid, card);
    }
    return;
  }

  if (category === 'faction') {
    // no-op during gameplay
  }
}

function handleEclipseTag(hwid, game, category, id) {
  if (game !== 'eclipse') { log(`Tag game mismatch: expected eclipse, got ${game}`, 'error'); return; }
  // faction: no-op during gameplay
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

// ---- OTA update dialog ----

let _otaInterval = null;
let _identifyingHwid = null;
let _identifyTimer = null;

function identifyBox(hwid) {
  if (_identifyTimer) clearTimeout(_identifyTimer);
  _identifyingHwid = hwid;

  state.boxOrder.forEach(id => {
    const box = state.boxes[id];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    if (id === hwid) {
      sendToBox(id, { type: 'led', pattern: 'on', leds: ledSolid(LED_COUNT, '#ffffff') });
    } else {
      sendToBox(id, { type: 'led', pattern: 'off', leds: ledOff(LED_COUNT) });
    }
  });

  _identifyTimer = setTimeout(() => {
    _identifyTimer = null;
    _identifyingHwid = null;
    state.boxOrder.forEach(id => {
      const box = state.boxes[id];
      if (!box || box.isVirtual || box.status === 'disconnected') return;
      const leds = ledStateForStatus(box.status, box, id);
      box.leds = leds;
      sendToBox(id, { type: 'led', pattern: 'off', leds });
    });
    renderOtaDialog();
  }, 3000);

  renderOtaDialog();
}

function openOtaDialog() {
  document.getElementById('ota-overlay').style.display = 'flex';
  renderOtaDialog();
  _otaInterval = setInterval(renderOtaDialog, 1000);
}

function closeOtaDialog() {
  const anyUpdating = state.boxOrder.some(id => state.boxes[id]?.otaUpdating);
  if (anyUpdating) {
    const el = document.getElementById('ota-close-warning');
    if (el) el.style.display = '';
    return;
  }
  document.getElementById('ota-overlay').style.display = 'none';
  clearInterval(_otaInterval);
  _otaInterval = null;
}

function forceCloseOtaDialog() {
  document.getElementById('ota-overlay').style.display = 'none';
  clearInterval(_otaInterval);
  _otaInterval = null;
}

function startOtaUpdate(hwid) {
  if (!state.latestFirmware?.binUrl) return;
  const box = state.boxes[hwid];
  if (!box) return;
  box.otaUpdating = true;
  box.otaProgress = 0;
  box.otaError = null;
  send({ type: 'ota_update', hwid, url: state.latestFirmware.binUrl, version: state.latestFirmware.version });
  renderOtaDialog();
}

function startOtaUpdateAll() {
  if (!state.latestFirmware?.binUrl) return;
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (box && isVersionOutOfDate(box.version) && !box.otaUpdating) {
      box.otaUpdating = true;
      box.otaProgress = 0;
      box.otaError = null;
    }
  });
  send({ type: 'ota_update', hwid: 'all', url: state.latestFirmware.binUrl, version: state.latestFirmware.version });
  renderOtaDialog();
}

function renderOtaDialog() {
  const el = document.getElementById('ota-dialog-content');
  if (!el || document.getElementById('ota-overlay').style.display === 'none') return;

  const fw = state.latestFirmware;
  const anyUpdating = state.boxOrder.some(id => state.boxes[id]?.otaUpdating);
  const allCurrent = state.boxOrder.every(id => !isVersionOutOfDate(state.boxes[id]?.version));

  const headerHtml = fw ? `
    <div class="ota-latest">
      Latest: <strong>${fw.version}</strong>
      <span class="ota-published">${fw.publishedAt ? new Date(fw.publishedAt).toLocaleDateString() : ''}</span>
      ${fw.releaseNotes ? `<details><summary>Release notes</summary><pre class="ota-notes">${fw.releaseNotes}</pre></details>` : ''}
    </div>` : `<div class="ota-latest ota-unavailable">Unable to check for updates</div>`;

  const rows = state.boxOrder.map(hwid => {
    const box = state.boxes[hwid];
    if (!box) return '';
    const isHub = hwid === state.hubHwid;
    const v = box.version || 'unknown';
    const outOfDate = isVersionOutOfDate(v);
    const vColor = v === 'unknown' ? '#888' : outOfDate ? '#c9a84c' : '#4a7';
    const canUpdate = fw?.binUrl && outOfDate && !box.otaUpdating;
    const canIdentify = box.status !== 'disconnected' && !box.isVirtual;
    const identifying = _identifyingHwid === hwid;
    const progressHtml = box.otaUpdating || box.otaProgress != null ? `
      <div class="ota-progress-wrap">
        <div class="ota-progress-bar" style="width:${box.otaProgress ?? 0}%"></div>
      </div>` : '';
    const errorHtml = box.otaError ? `<div class="ota-error">${box.otaError}</div>` : '';
    return `<div class="ota-row">
      <span class="ota-name">${getDisplayName(hwid)}${isHub ? ' <span class="ota-hub">(Hub)</span>' : ''}</span>
      <span class="ota-version" style="color:${vColor}">${v}</span>
      <button class="ota-identify-btn${identifying ? ' identifying' : ''}" onclick="identifyBox('${hwid}')" ${canIdentify ? '' : 'disabled'}>${identifying ? 'Identifying…' : 'Identify'}</button>
      <button class="ota-btn" onclick="startOtaUpdate('${hwid}')" ${canUpdate ? '' : 'disabled'}>Update</button>
      ${progressHtml}${errorHtml}
    </div>`;
  }).join('');

  el.innerHTML = `
    ${headerHtml}
    <div class="ota-rows">${rows || '<div style="color:#888">No boxes connected</div>'}</div>
    <div class="ota-actions">
      <button onclick="startOtaUpdateAll()" ${fw?.binUrl && !anyUpdating && !allCurrent ? '' : 'disabled'}>Update All</button>
    </div>`;
}

// ---- Debug logging dialog ----

function openDebugDialog() {
  document.getElementById('debug-log-overlay').style.display = 'flex';
  renderDebugDialog();
}

function closeDebugDialog() {
  document.getElementById('debug-log-overlay').style.display = 'none';
}

function toggleBoxDebug(hwid, enabled) {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].debugEnabled = enabled;
  send({ type: enabled ? 'debug_on' : 'debug_off', hwid });
}

function renderDebugDialog() {
  const el = document.getElementById('debug-log-content');
  if (!el) return;
  const rows = state.boxOrder.map(hwid => {
    const box = state.boxes[hwid];
    if (!box) return '';
    const isHub = hwid === state.hubHwid;
    const checked = box.debugEnabled ? 'checked' : '';
    return `<div class="debug-log-row">
      <span class="debug-log-name">${getDisplayName(hwid)}${isHub ? ' <span class="ota-hub">(Hub)</span>' : ''}</span>
      <label class="debug-toggle">
        <input type="checkbox" ${checked} onchange="toggleBoxDebug('${hwid}', this.checked)">
        <span>Debug</span>
      </label>
    </div>`;
  }).join('');
  el.innerHTML = rows || '<div style="color:#888">No boxes connected</div>';
}

// ---- WiFi credentials dialog ----

let _wifiCredentials = null; // null = not loaded yet
let _wifiCredentialsTimeout = null;
let _wifiDragIndex = null;
let _wifiDragOverIndex = null;

function openWifiDialog() {
  document.getElementById('wifi-overlay').style.display = 'flex';
  _wifiCredentials = null;
  renderWifiDialog();
  _wifiCredentialsTimeout = setTimeout(() => {
    if (_wifiCredentials === null) {
      _wifiCredentials = [];
      renderWifiDialog();
    }
  }, 5000);
  if (state.hubHwid) send({ type: 'wifi_credentials_get', hwid: state.hubHwid });
  document.addEventListener('mousemove', _onWifiDragMove);
  document.addEventListener('mouseup', _onWifiDragEnd);
  document.addEventListener('touchmove', _onWifiDragMove, { passive: false });
  document.addEventListener('touchend', _onWifiDragEnd);
}

function closeWifiDialog() {
  document.getElementById('wifi-overlay').style.display = 'none';
  clearTimeout(_wifiCredentialsTimeout);
  document.removeEventListener('mousemove', _onWifiDragMove);
  document.removeEventListener('mouseup', _onWifiDragEnd);
  document.removeEventListener('touchmove', _onWifiDragMove);
  document.removeEventListener('touchend', _onWifiDragEnd);
  _wifiDragIndex = null;
  _wifiDragOverIndex = null;
}

function renderWifiDialog() {
  const el = document.getElementById('wifi-dialog-content');
  if (!el) return;

  if (_wifiCredentials === null) {
    el.innerHTML = '<div style="color:#888; padding:0.5rem 0;">Loading…</div>';
    return;
  }

  let html = '<div id="wifi-cred-list">';
  _wifiCredentials.forEach((_, i) => {
    html += `<div class="wifi-row" data-index="${i}">
      <span class="wifi-drag-handle">⠿</span>
      <div class="wifi-fields">
        <input class="wifi-ssid" type="text" placeholder="Network name" oninput="updateWifiCred(${i},'ssid',this.value)">
        <input class="wifi-pwd" type="password" placeholder="Password" oninput="updateWifiCred(${i},'password',this.value)">
      </div>
      <button class="wifi-remove-btn" onclick="removeWifiCred(${i})">✕</button>
    </div>`;
  });
  html += '</div>';
  html += '<button class="wifi-add-btn" onclick="addWifiCred()">+ Add Network</button>';
  el.innerHTML = html;

  // Set values via JS to handle special characters safely
  el.querySelectorAll('.wifi-row').forEach((row, i) => {
    row.querySelector('.wifi-ssid').value = _wifiCredentials[i].ssid;
    row.querySelector('.wifi-pwd').value = _wifiCredentials[i].password;
  });

  // Drag handles
  el.querySelectorAll('.wifi-drag-handle').forEach((handle, i) => {
    handle.addEventListener('mousedown', (e) => { _wifiDragIndex = i; e.preventDefault(); });
    handle.addEventListener('touchstart', () => { _wifiDragIndex = i; }, { passive: true });
  });
}

function _onWifiDragMove(e) {
  if (_wifiDragIndex === null) return;
  if (e.cancelable) e.preventDefault();
  const y = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
  const rows = document.querySelectorAll('.wifi-row');
  let newOver = null;
  rows.forEach((row, i) => {
    const rect = row.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) newOver = i;
  });
  if (newOver !== null && newOver !== _wifiDragOverIndex) {
    _wifiDragOverIndex = newOver;
    rows.forEach((row, i) => {
      row.classList.toggle('wifi-drag-over', i === _wifiDragOverIndex && i !== _wifiDragIndex);
      row.classList.toggle('wifi-dragging', i === _wifiDragIndex);
    });
  }
}

function _onWifiDragEnd() {
  if (_wifiDragIndex === null) return;
  if (_wifiDragOverIndex !== null && _wifiDragOverIndex !== _wifiDragIndex) {
    const [item] = _wifiCredentials.splice(_wifiDragIndex, 1);
    _wifiCredentials.splice(_wifiDragOverIndex, 0, item);
    renderWifiDialog();
  } else {
    document.querySelectorAll('.wifi-row').forEach(r => r.classList.remove('wifi-dragging', 'wifi-drag-over'));
  }
  _wifiDragIndex = null;
  _wifiDragOverIndex = null;
}

function addWifiCred() {
  if (!_wifiCredentials) _wifiCredentials = [];
  _wifiCredentials.push({ ssid: '', password: '' });
  renderWifiDialog();
}

function removeWifiCred(index) {
  _wifiCredentials.splice(index, 1);
  renderWifiDialog();
}

function updateWifiCred(index, field, value) {
  if (_wifiCredentials && _wifiCredentials[index]) {
    _wifiCredentials[index][field] = value;
  }
}

function saveWifiCredentials() {
  if (!state.hubHwid || !_wifiCredentials) return;
  const filtered = _wifiCredentials.filter(c => c.ssid.trim() !== '');
  send({ type: 'wifi_credentials_set', hwid: state.hubHwid, credentials: filtered });
  const statusEl = document.getElementById('wifi-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';
}

// ---- Battery tip banner ----

function showBatteryTipIfNeeded() {
  if (localStorage.getItem('herald-battery-tip-dismissed')) return;
  document.getElementById('battery-tip-banner').style.display = 'flex';
}

function dismissBatteryTip() {
  localStorage.setItem('herald-battery-tip-dismissed', '1');
  document.getElementById('battery-tip-banner').style.display = 'none';
}

// ---- Silent audio keepalive ----

let silentAudioContext = null;

function initSilentAudio() {
  if (silentAudioContext) {
    if (silentAudioContext.state === 'suspended') silentAudioContext.resume();
    return;
  }
  try {
    silentAudioContext = new AudioContext();
    const gainNode = silentAudioContext.createGain();
    gainNode.gain.value = 0;
    const oscillator = silentAudioContext.createOscillator();
    oscillator.frequency.value = 0;
    oscillator.connect(gainNode);
    gainNode.connect(silentAudioContext.destination);
    oscillator.start();
    silentAudioContext.onstatechange = () => {
      if (state.gameActive && silentAudioContext.state === 'suspended') {
        silentAudioContext.resume();
      }
      renderGameControls();
    };
  } catch (err) {
    log(`Silent audio init failed: ${err.message}`, 'error');
  }
}

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

const TI_STRATEGY_INITIATIVES = {
  leadership: 1, diplomacy: 2, politics: 3, construction: 4,
  trade: 5, warfare: 6, technology: 7, imperial: 8,
};

const TI_STRATEGY_LABELS = {
  leadership: 'Leadership', diplomacy: 'Diplomacy', politics: 'Politics',
  construction: 'Construction', trade: 'Trade', warfare: 'Warfare',
  technology: 'Technology', imperial: 'Imperial',
};

function tiStart() {
  const speakerHwid = document.getElementById('ti-speaker').value;
  state.ti.speakerHwid = speakerHwid;
  state.round = 1;
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
  startPhase('status');
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
  startPhase('strategy');
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
  startPhase('action');

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
  startPhase('agenda');
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
  log(`Round ${state.round} complete`, 'system');
  state.round++;

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

// ---- Faction Scan ----

function startFactionScan() {
  state.factionScanActive = true;
  // Blank all LEDs to signal scan mode
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    const leds = ledOff(LED_COUNT);
    box.leds = leds;
    if (!box.isVirtual) sendToBox(hwid, { type: 'led', leds });
  });
  document.getElementById('faction-scan-banner').style.display = 'flex';
  render();
}

function stopFactionScan() {
  state.factionScanActive = false;
  // Clear stored LEDs so syncLeds recalculates from status
  state.boxOrder.forEach(hwid => {
    if (state.boxes[hwid]) state.boxes[hwid].leds = null;
  });
  document.getElementById('faction-scan-banner').style.display = 'none';
  render();
}

function handleFactionScan(hwid, internalId) {
  const parts = internalId.split(':');
  const game = parts[0];
  const category = parts[1];
  const factionId = parts.slice(2).join(':');

  if (category !== 'faction') return;

  const gameKey = game === 'ti' ? 'twilight_imperium' : 'eclipse';
  if (!state.factions || !state.factions[gameKey]) return;

  const faction = state.factions[gameKey].find(f => f.id === factionId);
  if (!faction) return;

  state.boxes[hwid].factionId = factionId;

  // Auto-rename to faction name unless the box has been manually renamed
  if (!isManuallyRenamed(hwid)) {
    if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
      virtualBoxNames[hwid] = faction.nickname || faction.name;
    } else {
      setBoxName(hwid, faction.nickname || faction.name);
      // Don't set manual flag — this is an auto-rename, user can still override
    }
  }

  // Light box in faction colour during scan
  const leds = ledSolid(LED_COUNT, faction.color);
  state.boxes[hwid].leds = leds;
  if (!state.boxes[hwid].isVirtual) sendToBox(hwid, { type: 'led', leds });
  log(`${getDisplayName(hwid)} identified as ${faction.name}`, 'system');
  updateTiBadges();
  updateSetupUI();
  render();
}

// ---- Faction display helpers ----

function getFaction(gameKey, factionId) {
  if (!state.factions || !factionId) return null;
  return state.factions[gameKey]?.find(f => f.id === factionId) || null;
}

function getFactionForBox(hwid) {
  const box = state.boxes[hwid];
  if (!box || !box.factionId) return null;
  const gameKey = state.gameMode === 'ti' ? 'twilight_imperium' : 'eclipse';
  return getFaction(gameKey, box.factionId);
}

// ---- TI Badges ----

function updateTiBadges() {
  if (state.gameMode !== 'ti') return;
  state.boxOrder.forEach(hwid => {
    const player = state.ti.players[hwid];
    if (!player) return;
    const badges = [];
    if (hwid === state.ti.speakerHwid) {
      badges.push({ type: 'icon', value: '👑', label: 'Speaker' });
    }
    const faction = getFactionForBox(hwid);
    if (faction) {
      badges.push({ type: 'text', value: faction.name, color: faction.color });
    }
    player.strategyCards.forEach(card => {
      badges.push({ type: 'pill', value: card.label.substring(0, 4), color: card.color, faded: card.used });
    });
    setBoxBadges(hwid, badges);
  });
}

function updateEclipseBadges() {
  if (!state.gameMode.startsWith('eclipse')) return;
  state.boxOrder.forEach(hwid => {
    const faction = getFactionForBox(hwid);
    if (faction) {
      setBoxBadges(hwid, [{ type: 'text', value: faction.name, color: faction.color }]);
    } else {
      clearBoxBadges(hwid);
    }
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

function updateCardScale() {
  const scale = Math.min(2, Math.max(1, (window.innerWidth - 600) / 600 + 1));
  document.documentElement.style.setProperty('--card-scale', scale);
}

window.addEventListener('resize', updateCardScale);

async function init() {
  updateCardScale();
  localStorage.removeItem('herald-box-names');
  await loadFactions();
  render();
  updateSetupUI();
}

async function loadFactions() {
  try {
    const res = await fetch('./factions.json');
    state.factions = await res.json();
    log('Factions loaded', 'system');
  } catch (e) {
    log('Warning: could not load factions.json — faction features disabled', 'error');
  }
}

init();