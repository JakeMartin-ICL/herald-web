import { state, VIRTUAL_BOX_ID_OFFSET } from './state';
import { ledStateForStatus, syncLeds } from './leds';
import {
  updateTurnTimers, timerSettings, formatDuration,
  stopCurrentTimerInterval, needsTimerInterval, startCurrentTimerInterval,
  endPhase, resetTurnTimers,
} from './timers';
import { log } from './logger';
import { getDisplayName, updateSetupUI, setBoxName, setAutoName } from './boxes';
import { getRelevantTagsForBox } from './tags';
import { renderTimerInfo, openGraphOverlay, captureGameStats } from './graphs';
import { currentGame } from './currentGame';
import { getFactionForBox } from './modes/eclipse';
import { disableAllRfid } from './websockets';
import { clearPersistedState } from './persist';
import { isVersionOutOfDate } from './firmware';
import type { ActionDef } from './types';

// ---- Render ----

export function render(): void {
  updateTurnTimers();
  syncLeds();
  renderBoxes();
  renderTableLabel();
  renderGameControls();
}

// ---- Table label ----

export function renderTableLabel(): void {
  const el = document.getElementById('table-label') as HTMLElement;
  if (!state.gameActive) {
    el.innerHTML = 'No game in progress';
    return;
  }
  const parts: string[] = [];
  if (timerSettings.showGameTimer && state.gameStartTime) {
    parts.push(`<div class="game-timer-display">${formatDuration(Date.now() - state.gameStartTime)}</div>`);
  }
  if (state.round) {
    const roundStr = `Round ${state.round}${state.totalRounds ? ' / ' + state.totalRounds : ''}`;
    parts.push(`<div class="round-counter">${roundStr}</div>`);
  }
  if (state.gameMode === 'ti') {
    const phase = state.ti.phase ?? '';
    parts.push(`<div class="game-mode-label">TI${phase ? ` — ${phase.replace(/_/g, ' ').toUpperCase()}` : ''}</div>`);
  } else if (state.gameMode === 'eclipse') {
    parts.push(`<div class="game-mode-label">${state.eclipse.phase ? state.eclipse.phase.toUpperCase() : 'ECLIPSE'}</div>`);
  } else {
    parts.push(`<div class="game-mode-label">ROUND IN PROGRESS</div>`);
  }
  el.innerHTML = parts.join('');
}

// ---- Game Controls ----

export function renderGameControls(): void {
  const panel = document.getElementById('game-controls') as HTMLElement;
  if (!state.gameActive) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const modeNames: Record<string, string> = {
    clockwise: 'Clockwise',
    clockwise_pass: 'Clockwise with Passing',
    eclipse: 'Eclipse',
    ti: 'Twilight Imperium',
  };
  (document.getElementById('gc-mode-name') as HTMLElement).textContent =
    modeNames[state.gameMode] || state.gameMode;

  const statusEl = document.getElementById('gc-status') as HTMLElement;
  const actionsEl = document.getElementById('gc-actions') as HTMLElement;
  const statusLines: string[] = [];
  const actionDefs: ActionDef[] = [];

  // Mode-specific controls
  currentGame?.renderControls(statusLines, actionDefs);

  // Common controls
  actionDefs.push({
    html: '<button id="gc-graphs">Graphs</button>',
    id: 'gc-graphs',
    fn: () => openGraphOverlay('live'),
  });
  actionDefs.push({
    html: `<label class="gc-check-row">
      <input type="checkbox" id="gc-timer-game"${timerSettings.showGameTimer ? ' checked' : ''}>
      Show game timer
    </label>`,
    id: 'gc-timer-game', event: 'change',
    fn: (e: Event) => {
      timerSettings.showGameTimer = (e.target as HTMLInputElement).checked;
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
    fn: (e: Event) => {
      timerSettings.showCurrent = (e.target as HTMLInputElement).checked;
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
    fn: (e: Event) => { timerSettings.showTotal = (e.target as HTMLInputElement).checked; renderBoxes(); },
  });

  if (_silentAudioContext) {
    const running = _silentAudioContext.state === 'running';
    statusLines.push(running
      ? '<span style="color:#4a7">🔇 Background keepalive active</span>'
      : '<span style="color:#c94">⚠️ Background keepalive inactive</span>'
    );
  }

  actionDefs.push({
    html: '<button class="end-game-btn" id="gc-end-game">End Game</button>',
    id: 'gc-end-game',
    fn: confirmEndGame,
  });

  statusEl.innerHTML = statusLines.map(l => `<div>${l}</div>`).join('');
  actionsEl.innerHTML = actionDefs.map(a => a.html).join('');
  actionDefs.forEach(({ id, event, fn }) => {
    if (!id || !fn) return;
    const el = actionsEl.querySelector(`#${id}`);
    if (el) el.addEventListener(event ?? 'click', fn as EventListenerOrEventListenerObject);
  });
}

// ---- End Game ----

function confirmEndGame(): void {
  (document.getElementById('end-game-overlay') as HTMLElement).style.display = 'flex';
}

export function cancelEndGame(): void {
  (document.getElementById('end-game-overlay') as HTMLElement).style.display = 'none';
}

export function endGame(): void {
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
  state.eclipse = {
    phase: null, passOrder: [], turnOrder: [], firstPlayerId: null,
    tapToPass: state.eclipse.tapToPass, advancedOrder: state.eclipse.advancedOrder, upkeepReady: [],
  };
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
  (document.getElementById('faction-scan-banner') as HTMLElement).style.display = 'none';
  _releaseWakeLock?.();
  if (_silentAudioContext) void _silentAudioContext.suspend();
  (document.getElementById('setup-panel') as HTMLElement).style.display = '';
  log('Game ended', 'system');
  render();
  updateSetupUI();
}

// ---- LED Ring rendering ----

function renderLedRing(leds: string[]): string {
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

// ---- Badges ----

function renderBadges(box: typeof state.boxes[string]): string {
  const badges = [...(box.badges ?? [])];

  if (state.latestFirmware && isVersionOutOfDate(box.version)) {
    badges.push({
      type: 'icon', value: '⚠️',
      label: `Firmware out of date (${box.version ?? 'unknown'} → ${state.latestFirmware.version})`,
    });
  }

  if (badges.length === 0) return '';

  const items = badges.map(badge => {
    switch (badge.type) {
      case 'icon':
        return `<span class="badge-icon" title="${badge.label ?? ''}">${badge.value}</span>`;
      case 'pill':
        return `<span class="badge-pill ${badge.faded ? 'faded' : ''}"
          style="background:${badge.color ?? '#555'}">${badge.value}</span>`;
      case 'text':
        return `<span class="badge-text"
          style="color:${badge.color ?? '#aaa'}">${badge.value}</span>`;
      default:
        return '';
    }
  }).join('');

  return `<div class="box-badges">${items}</div>`;
}

// ---- Sim controls ----

function renderSimControls(hwid: string): string {
  const isOpen = simOpenCards.has(hwid);
  const rfidBtn = getRelevantTagsForBox(hwid).length > 0
    ? `<button class="box-btn rfid-sim-btn" data-hwid="${hwid}">RFID</button>`
    : '';

  return `<div class="box-sim ${isOpen ? 'sim-open' : ''}">
    <div class="box-sim-row">
      <button class="box-btn sim-btn" data-hwid="${hwid}" data-type="endturn">End</button>
      <button class="box-btn sim-btn" data-hwid="${hwid}" data-type="pass">Pass</button>
      <button class="box-btn sim-btn" data-hwid="${hwid}" data-type="longpress">Long</button>
      ${rfidBtn}
    </div>
  </div>`;
}

// ---- Box positions ----

function getBoxPositions(count: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    const x = 50 + 42 * Math.cos(angle);
    const y = 50 + 38 * Math.sin(angle);
    positions.push({ x, y });
  }
  return positions;
}

// ---- Drag-to-reorder state ----

let dragSourceHwid: string | null = null;
let dragOverHwid: string | null = null;

function swapBoxOrder(a: string, b: string): void {
  const ia = state.boxOrder.indexOf(a);
  const ib = state.boxOrder.indexOf(b);
  if (ia === -1 || ib === -1 || ia === ib) return;
  [state.boxOrder[ia], state.boxOrder[ib]] = [state.boxOrder[ib], state.boxOrder[ia]];
}

// ---- Name editing ----

let editingNameHwid: string | null = null;

const manuallyRenamedBoxes = new Set<string>();

export function isManuallyRenamed(hwid: string): boolean {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) return manuallyRenamedBoxes.has(hwid);
  return !!state.boxNames[hwid]?.manual;
}

// ---- Sim toggle ----

const simOpenCards = new Set<string>();

function toggleSim(hwid: string): void {
  if (simOpenCards.has(hwid)) {
    simOpenCards.delete(hwid);
  } else {
    simOpenCards.add(hwid);
  }
  render();
}

// ---- Render boxes ----

export function renderBoxes(): void {
  const container = document.getElementById('box-positions') as HTMLElement;
  container.innerHTML = '';

  const ids = state.boxOrder;
  if (ids.length === 0) return;

  const positions = getBoxPositions(ids.length);
  const canDrag = !state.gameActive;

  ids.forEach((hwid, index) => {
    const box = state.boxes[hwid];
    const pos = positions[index];
    const leds = box.leds ?? ledStateForStatus(box.status, box, hwid);

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
           />`
      : `<div class="box-name edit-name-btn" data-hwid="${hwid}">${getDisplayName(hwid)}</div>${factionSubtitle}`;

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

    // Name editing
    const nameInput = card.querySelector<HTMLInputElement>('.box-name-input');
    if (nameInput) {
      nameInput.addEventListener('blur', () => saveEditingName(hwid, nameInput));
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameInput.blur();
        if (e.key === 'Escape') cancelEditingName();
      });
      nameInput.addEventListener('click', e => e.stopPropagation());
    }
    const editBtn = card.querySelector<HTMLElement>('.edit-name-btn');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editingNameHwid = hwid;
        render();
        const input = document.getElementById(`name-input-${escapedHwid}`) as HTMLInputElement | null;
        if (input) { input.focus(); input.select(); }
      });
    }

    // Sim button events (lazy import to avoid circular)
    card.querySelectorAll<HTMLButtonElement>('.sim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        void import('./rfid').then(({ simulateButton }) => simulateButton(btn.dataset.hwid!, btn.dataset.type!));
      });
    });
    card.querySelectorAll<HTMLButtonElement>('.rfid-sim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        void import('./rfid').then(({ openRfidDialog }) => openRfidDialog(btn.dataset.hwid!));
      });
    });

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement) === card ||
          (e.target as HTMLElement).classList.contains('box-status')) {
        toggleSim(hwid);
      }
    });

    if (canDrag) {
      card.draggable = true;

      card.addEventListener('dragstart', (e) => {
        dragSourceHwid = hwid;
        card.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
      });

      card.addEventListener('dragend', () => {
        dragSourceHwid = null;
        document.querySelectorAll('.box-card.dragging, .box-card.drag-over')
          .forEach(el => el.classList.remove('dragging', 'drag-over'));
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
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

      card.addEventListener('touchstart', () => {
        dragSourceHwid = hwid;
        card.classList.add('dragging');
      }, { passive: true });

      card.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetCard = el && (el as HTMLElement).closest('.box-card') as HTMLElement | null;
        const targetHwid = targetCard?.dataset.hwid;
        if (targetHwid && targetHwid !== dragOverHwid) {
          document.querySelectorAll('.box-card.drag-over')
            .forEach(c => c.classList.remove('drag-over'));
          dragOverHwid = targetHwid;
          if (targetHwid !== dragSourceHwid) targetCard!.classList.add('drag-over');
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

function saveEditingName(hwid: string, input: HTMLInputElement): void {
  if (editingNameHwid !== hwid) return;
  const newName = input.value.trim();
  if (newName) {
    if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
      setAutoName(hwid, newName);
      manuallyRenamedBoxes.add(hwid);
    } else {
      setBoxName(hwid, newName);
      state.boxNames[hwid].manual = true;
    }
  }
  editingNameHwid = null;
  updateSetupUI();
  render();
}

function cancelEditingName(): void {
  editingNameHwid = null;
  render();
}

// ---- Wake lock / audio context (injected by init.ts) ----

let _releaseWakeLock: (() => void) | null = null;
let _silentAudioContext: AudioContext | null = null;

export function setWakeLockHandlers(release: (() => void) | null, audioCtx: AudioContext | null): void {
  _releaseWakeLock = release;
  _silentAudioContext = audioCtx;
}

export function updateSilentAudioContext(ctx: AudioContext | null): void {
  _silentAudioContext = ctx;
  if (state.gameActive) renderGameControls();
}
