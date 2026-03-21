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
  } else if (state.gameMode === 'eclipse') {
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
    eclipse: 'Eclipse',
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

  } else if (state.gameMode === 'eclipse') {
    const phase = state.eclipse.phase || '';
    const phaseLabel = phase.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    statusLines.push(`Round ${state.round}${state.totalRounds ? ' / ' + state.totalRounds : ''}${phaseLabel ? ` · ${phaseLabel}` : ''}`);
    if (state.activeBoxId) statusLines.push(`Active: ${getDisplayName(state.activeBoxId)}`);

    // Next turn order — shown during action phase once someone has passed
    if (phase === 'action' && state.eclipse.passOrder.length > 0) {
      const isAdvanced = state.eclipse.advancedOrder;
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

    actionDefs.push({
      html: `<label class="gc-check-row">
        <input type="checkbox" id="gc-tap-to-pass"${state.eclipse.tapToPass ? ' checked' : ''}>
        Tap to pass
      </label>`,
      id: 'gc-tap-to-pass', event: 'change',
      fn: (e) => {
        state.eclipse.tapToPass = e.target.checked;
        log(`Tap to pass ${e.target.checked ? 'enabled' : 'disabled'}`, 'system');
        if (state.eclipse.phase === 'action') eclipseSyncActionRfid();
        if (state.eclipse.phase === 'upkeep') {
          if (e.target.checked) {
            disableAllRfid();
            state.boxOrder.forEach(id => {
              if (state.boxes[id]?.status === 'upkeep') enableRfid(id);
            });
          } else {
            disableAllRfid();
          }
        }
      },
    });

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
  disableAllRfid();
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
  state.eclipse = { phase: null, passOrder: [], turnOrder: [], firstPlayerId: null, tapToPass: state.eclipse.tapToPass, advancedOrder: state.eclipse.advancedOrder, upkeepReady: [] };
  state.ti = { ...state.ti, phase: null, speakerHwid: null, turnOrder: [], players: {}, secondary: null, agendaCount: 0 };
  endPhase();
  captureGameStats();
  clearPersistedState();
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
  const rfidBtn = getRelevantTagsForBox(hwid).length > 0
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
      card.classList.add('has-faction');
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
