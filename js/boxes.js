// ---- Box names (session-only) ----

function getBoxName(hwid) {
  return state.boxNames[hwid]?.name || null;
}

function setBoxName(hwid, name) {
  if (!state.boxNames[hwid]) state.boxNames[hwid] = {};
  state.boxNames[hwid].name = name;
}

function defaultBoxName(hwid) {
  const index = state.boxOrder.indexOf(hwid);
  return `Player ${index + 1}`;
}

function saveBoxNames() {
  // Session-only — intentional no-op (names reset on page reload)
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

// ---- Box management ----

function addBox(hwid, isVirtual) {
  console.log('addBox called', hwid, 'existing:', !!state.boxes[hwid], 'boxOrder:', state.boxOrder);
  if (state.boxes[hwid]) {
    // Box reconnected — update status and clear any in-progress OTA state
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].otaUpdating = false;
    state.boxes[hwid].otaProgress = null;
    log(`Box ${getDisplayName(hwid)} reconnected`, 'system');
    // Disable RFID on the reconnected box until the game logic re-enables it
    if (!state.boxes[hwid].isVirtual) disableRfid(hwid);
    // Resync its LED if game active
    if (state.gameActive) syncLeds();
    updateSetupUI();
    render();
    return;
  }

  if (!isVirtual && !state.hubHwid) {
    state.hubHwid = hwid;
    log(`Hub identified: ${getDisplayName(hwid)}`, 'system');
    // Hub just connected/registered — disable RFID until needed
    disableAllRfid();
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
  applyPendingPersistedBox(hwid);
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

  // Carry the old display name over to the new box
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

// ---- Setup UI ----

function onGameModeChange() {
  state.gameMode = document.getElementById('game-mode').value;
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
  if (typeof updateResumeBtnState === 'function') updateResumeBtnState();

  // Eclipse rows
  document.getElementById('first-player-row').style.display = isEclipse ? 'flex' : 'none';
  document.getElementById('eclipse-mode-row').style.display = isEclipse ? 'flex' : 'none';

  // TI rows
  document.getElementById('ti-speaker-row').style.display = isTi ? 'flex' : 'none';
  const factionsLoaded = !!state.factions;
  document.getElementById('ti-learn-tags-btn').style.display =
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
