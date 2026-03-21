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
  if (state.hubHwid) enableRfid(state.hubHwid);
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
  if (state.hubHwid) disableRfid(state.hubHwid);
  tagWritingActive = false;
  document.getElementById('tag-writing-overlay').style.display = 'none';
  log('Tag writing complete', 'system');
  updateSetupUI();
}

function cancelTagWriting() {
  if (state.hubHwid) disableRfid(state.hubHwid);
  tagWritingActive = false;
  tagWritingPending = false;
  tagWritingIndex = 0;
  tagWritingQueue = [];
  document.getElementById('tag-writing-overlay').style.display = 'none';
}

// ---- RFID dispatch ----

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

// ---- Faction Scan ----

function startFactionScan() {
  state.factionScanActive = true;
  // Disable all RFID first, then enable each connected non-virtual box
  disableAllRfid();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    enableRfid(hwid);
  });
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
  disableAllRfid();
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
  // Stop this box from scanning further — it has been identified
  if (!state.boxes[hwid].isVirtual) disableRfid(hwid);

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
      id: `${state.gameMode === 'ti' ? 'ti' : 'eclipse'}:faction:${f.id}`,
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
