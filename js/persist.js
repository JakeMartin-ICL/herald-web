// ---- State extraction ----

function extractPersistableState() {
  const boxes = {};
  for (const hwid of state.boxOrder) {
    const box = state.boxes[hwid];
    if (!box) continue;
    boxes[hwid] = {
      hwid:         box.hwid,
      isVirtual:    box.isVirtual,
      status:       box.status,
      factionId:    box.factionId || null,
      badges:       box.badges || [],
      version:      box.version || null,
      totalTurnTime: box.totalTurnTime || 0,
      turnHistory:  box.turnHistory || [],
    };
  }

  // Deep-copy ti, stripping per-turn confirmedSecondary flags
  const ti = JSON.parse(JSON.stringify(state.ti));
  if (ti.players) {
    for (const hwid of Object.keys(ti.players)) {
      if (ti.players[hwid]) delete ti.players[hwid].confirmedSecondary;
    }
  }

  return {
    gameActive:         state.gameActive,
    gameMode:           state.gameMode,
    boxes,
    boxOrder:           [...state.boxOrder],
    activeBoxId:        state.activeBoxId,
    hubHwid:            state.hubHwid,
    round:              state.round,
    totalRounds:        state.totalRounds,
    gameStartTime:      state.gameStartTime,
    phaseLog:           [...state.phaseLog],
    currentPhaseStart:  state.currentPhaseStart || null,
    eclipse: {
      phase:         state.eclipse.phase,
      firstPlayerId: state.eclipse.firstPlayerId,
      passOrder:     [...state.eclipse.passOrder],
      turnOrder:     [...state.eclipse.turnOrder],
    },
    ti,
    factions:  state.factions,
    boxNames:  JSON.parse(JSON.stringify(state.boxNames)),
  };
}

// ---- Compression helpers ----

async function compressState(jsonString) {
  if (typeof CompressionStream === 'undefined') return null;
  const input = new TextEncoder().encode(jsonString);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function decompressState(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- Persist ----

function persistStateLocally() {
  if (!state.gameActive) return;
  try {
    localStorage.setItem('herald-game-state', JSON.stringify(extractPersistableState()));
  } catch (e) {
    log(`State backup (local) failed: ${e.message}`, 'error');
  }
}

async function persistStateToHub() {
  if (!state.gameActive) return;
  const json = JSON.stringify(extractPersistableState());
  let payload, compressed;
  const bytes = await compressState(json);
  if (bytes) {
    payload = uint8ArrayToBase64(bytes);
    compressed = true;
  } else {
    log('State backup: CompressionStream unavailable, sending uncompressed', 'system');
    payload = btoa(unescape(encodeURIComponent(json)));
    compressed = false;
  }
  sendSilent({ type: 'state_backup', payload, compressed });
}

function persistState() {
  persistStateLocally();
  persistStateToHub(); // fire-and-forget
}

function clearPersistedState() {
  localStorage.removeItem('herald-game-state');
  sendSilent({ type: 'state_backup_clear' });
}

// ---- Box assignment (persisted HWIDs → current HWIDs) ----

function buildBoxAssignment(persisted) {
  const persistedOrder = persisted.boxOrder;
  const currentBoxes = [...state.boxOrder];

  const assignment = {}; // persistedHwid → currentHwid
  const matchedCurrent = new Set();
  const matchedPersisted = new Set();

  // First: match boxes that share the same HWID
  for (const ph of persistedOrder) {
    if (currentBoxes.includes(ph) && !matchedCurrent.has(ph)) {
      assignment[ph] = ph;
      matchedCurrent.add(ph);
      matchedPersisted.add(ph);
    }
  }

  // Second: assign remaining persisted slots to remaining connected boxes sequentially
  const remainingCurrent = currentBoxes.filter(h => !matchedCurrent.has(h));
  const remainingPersisted = persistedOrder.filter(h => !matchedPersisted.has(h));
  for (let i = 0; i < remainingPersisted.length && i < remainingCurrent.length; i++) {
    assignment[remainingPersisted[i]] = remainingCurrent[i];
  }

  return assignment;
}

// ---- Restore ----

let _pendingPersistedBoxes = {}; // currentHwid → persisted box data

function mergePersistedBox(hwid, persBox) {
  const box = state.boxes[hwid];
  if (!box) return;
  box.status       = persBox.status || 'idle';
  box.factionId    = persBox.factionId || null;
  box.badges       = persBox.badges || [];
  box.totalTurnTime = persBox.totalTurnTime || 0;
  box.turnHistory  = persBox.turnHistory || [];
}

function applyPendingPersistedBox(hwid) {
  if (!_pendingPersistedBoxes[hwid]) return;
  mergePersistedBox(hwid, _pendingPersistedBoxes[hwid]);
  delete _pendingPersistedBoxes[hwid];
}

function restoreState(persisted) {
  const assignment = buildBoxAssignment(persisted);
  const remap = ph => assignment[ph] || ph;

  // Top-level fields
  state.gameActive        = persisted.gameActive;
  state.gameMode          = persisted.gameMode;
  state.activeBoxId       = persisted.activeBoxId ? remap(persisted.activeBoxId) : null;
  state.boxOrder          = persisted.boxOrder.map(remap);
  state.hubHwid           = persisted.hubHwid ? remap(persisted.hubHwid) : state.hubHwid;
  state.round             = persisted.round || 0;
  state.totalRounds       = persisted.totalRounds || null;
  state.gameStartTime     = persisted.gameStartTime || null;
  state.phaseLog          = persisted.phaseLog || [];
  state.currentPhaseStart = persisted.currentPhaseStart || null;

  if (persisted.factions) state.factions = persisted.factions;

  // Box names — remap keys to current HWIDs
  for (const [ph, nameObj] of Object.entries(persisted.boxNames || {})) {
    const ch = remap(ph);
    if (ch) state.boxNames[ch] = nameObj;
  }

  // Eclipse state — remap all HWID references
  if (persisted.eclipse) {
    state.eclipse = {
      phase:         persisted.eclipse.phase,
      firstPlayerId: persisted.eclipse.firstPlayerId ? remap(persisted.eclipse.firstPlayerId) : null,
      passOrder:     (persisted.eclipse.passOrder || []).map(remap),
      turnOrder:     (persisted.eclipse.turnOrder || []).map(remap),
    };
  }

  // TI state — remap all HWID references
  if (persisted.ti) {
    const ti = { ...persisted.ti };
    ti.speakerHwid = ti.speakerHwid ? remap(ti.speakerHwid) : null;
    ti.turnOrder   = (ti.turnOrder || []).map(remap);
    if (ti.players) {
      const remapped = {};
      for (const [ph, data] of Object.entries(ti.players)) remapped[remap(ph)] = data;
      ti.players = remapped;
    }
    if (ti.secondary) {
      ti.secondary = { ...ti.secondary };
      if (ti.secondary.activeHwid) ti.secondary.activeHwid = remap(ti.secondary.activeHwid);
      ti.secondary.pendingHwids = (ti.secondary.pendingHwids || []).map(remap);
    }
    state.ti = ti;
  }

  // Box state — merge onto connected boxes; create disconnected placeholders for the rest
  _pendingPersistedBoxes = {};
  for (const [ph, persBox] of Object.entries(persisted.boxes || {})) {
    const ch = assignment[ph];
    if (!ch) continue;
    if (state.boxes[ch]) {
      mergePersistedBox(ch, persBox);
    } else {
      state.boxes[ch] = {
        hwid:         ch,
        isVirtual:    persBox.isVirtual || false,
        status:       'disconnected',
        factionId:    persBox.factionId || null,
        badges:       persBox.badges || [],
        totalTurnTime: persBox.totalTurnTime || 0,
        turnHistory:  persBox.turnHistory || [],
      };
      _pendingPersistedBoxes[ch] = persBox;
    }
  }

  // Restore UI — mirror what startGame() does for panel visibility
  document.getElementById('game-mode').value = state.gameMode;
  document.getElementById('setup-panel').style.display = 'none';

  syncLeds();
  updateSetupUI();
  render();

  log(`Game resumed: ${state.gameMode}, round ${state.round}`, 'system');
}

// ---- Resume UI ----

let _pendingResumeState = null;

const _resumeModeNames = {
  clockwise: 'Clockwise',
  clockwise_pass: 'Clockwise with Passing',
  eclipse_simple: 'Eclipse — Simple',
  eclipse_advanced: 'Eclipse — Advanced',
  ti: 'Twilight Imperium',
};

function offerResume(persistedState) {
  if (!persistedState?.gameActive) return;
  // Hub backup always takes priority over localStorage (called later, after connect)
  _pendingResumeState = persistedState;

  const modeName = _resumeModeNames[persistedState.gameMode] || persistedState.gameMode;
  const playerCount = persistedState.boxOrder.length;
  document.getElementById('resume-mode-label').textContent =
    `Game in progress: ${modeName} · ${playerCount} players`;

  let detail = '';
  if (persistedState.round) detail += `Round ${persistedState.round}`;
  const phase = persistedState.eclipse?.phase || persistedState.ti?.phase
    || persistedState.currentPhaseStart?.name;
  if (phase) detail += `${detail ? ' · ' : ''}${phase.charAt(0).toUpperCase() + phase.slice(1)} Phase`;
  document.getElementById('resume-detail-label').textContent = detail;

  document.getElementById('resume-banner').style.display = 'block';
  updateResumeBtnState();
}

function updateResumeBtnState() {
  if (!_pendingResumeState) return;
  const needed = _pendingResumeState.boxOrder.length;
  const have = state.boxOrder.length;
  const ready = have >= needed;
  document.getElementById('resume-btn').disabled = !ready;
  document.getElementById('resume-waiting').style.display = ready ? 'none' : 'block';
  document.getElementById('resume-waiting').textContent =
    `Waiting for players to connect (${have} / ${needed})…`;
}

function confirmResume() {
  if (!_pendingResumeState) return;
  const toRestore = _pendingResumeState;
  _pendingResumeState = null;
  document.getElementById('resume-banner').style.display = 'none';
  restoreState(toRestore);
  requestWakeLock();
  initSilentAudio();
}

function discardResume() {
  _pendingResumeState = null;
  document.getElementById('resume-banner').style.display = 'none';
  clearPersistedState();
}

// ---- Decode incoming hub backup ----

async function applyHubBackup(payload, compressed) {
  try {
    let json;
    if (compressed && typeof DecompressionStream !== 'undefined') {
      json = await decompressState(base64ToUint8Array(payload));
    } else {
      json = decodeURIComponent(escape(atob(payload)));
    }
    const parsed = JSON.parse(json);
    if (parsed.gameActive) offerResume(parsed);
  } catch (e) {
    log(`State backup decode failed: ${e.message}`, 'error');
  }
}
