import { state, VIRTUAL_BOX_ID_OFFSET } from './state';
import { log } from './logger';
import { disableRfid, disableAllRfid } from './websockets';
import { syncLeds, syncLedsForBox } from './leds';
import { render, scheduleRender } from './render';
import { substituteTimerTracking } from './timers';
import { applyPendingPersistedBox, updateResumeBtnState } from './persist';
import { prevGameStats } from './graphs';
import { renderExpansionUI } from './expansions';
import { currentGame, setupGame } from './currentGame';
import type { Badge, Faction, SetupField, SetupSelectOption } from './types';

// ---- Box names ----

const virtualBoxNames: Record<string, string> = {};

function getBoxName(hwid: string): string | null {
  return state.boxNames[hwid]?.name ?? null;
}

export function setBoxName(hwid: string, name: string): void {
  if (!state.boxNames[hwid]) state.boxNames[hwid] = { name: '' };
  state.boxNames[hwid].name = name;
}

export function setAutoName(hwid: string, name: string): void {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
    virtualBoxNames[hwid] = name;
    setBoxName(hwid, name); // also persist so name survives resume
  } else {
    setBoxName(hwid, name);
  }
}

function defaultBoxName(hwid: string): string {
  const index = state.boxOrder.indexOf(hwid);
  return `Player ${index + 1}`;
}

export function getDisplayName(hwid: string): string {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
    if (virtualBoxNames[hwid]) return virtualBoxNames[hwid];
    const persisted = state.boxNames[hwid]?.name;
    if (persisted) { virtualBoxNames[hwid] = persisted; return persisted; }
    const n = parseInt(hwid.slice(VIRTUAL_BOX_ID_OFFSET.length), 10);
    return `Sim ${n + 1}`;
  }
  return getBoxName(hwid) ?? defaultBoxName(hwid);
}

// ---- Faction lookup ----

export function getFactionForBox(hwid: string): Faction | null {
  const box = state.boxes[hwid];
  const factions = state.factions;
  if (!box?.factionId || !factions) return null;
  for (const list of Object.values(factions)) {
    const found = list.find((f: Faction) => f.id === box.factionId);
    if (found) return found;
  }
  return null;
}

export function buildPlayerSelectOptions(includeFactionNames = false): SetupSelectOption[] {
  return state.boxOrder.map(hwid => {
    const faction = includeFactionNames ? getFactionForBox(hwid) : null;
    const label = faction ? `${getDisplayName(hwid)} — ${faction.name}` : getDisplayName(hwid);
    return { value: hwid, label };
  });
}

// ---- Box management ----

export function addBox(hwid: string, isVirtual: boolean): void {
  if (state.boxes[hwid]) {
    state.boxes[hwid].status = 'idle';
    state.boxes[hwid].otaUpdating = false;
    state.boxes[hwid].otaProgress = null;
    log(`Box ${getDisplayName(hwid)} reconnected`, 'system');
    if (!state.boxes[hwid].isVirtual) disableRfid(hwid);
    if (state.gameActive) syncLedsForBox(hwid);
    updateSetupUI();
    scheduleRender();
    return;
  }

  if (!isVirtual && !state.hubHwid) {
    state.hubHwid = hwid;
    log(`Hub identified: ${getDisplayName(hwid)}`, 'system');
    disableAllRfid();
  }

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
  scheduleRender();
}

export function handleBoxDisconnect(hwid: string): void {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].status = 'disconnected';
  log(`Box ${getDisplayName(hwid)} disconnected`, 'system');
  updateSetupUI();
}

export function removeBox(hwid: string): void {
  if (!state.boxes[hwid]) return;
  delete state.boxes[hwid];
  state.boxOrder = state.boxOrder.filter(b => b !== hwid);
  if (state.activeBoxId === hwid) state.activeBoxId = null;
  updateSetupUI();
}

export function addVirtualBox(): void {
  const hwid = `${VIRTUAL_BOX_ID_OFFSET}${state.nextVirtualIndex++}`;
  addBox(hwid, true);
}

// ---- Box substitution ----

let _pendingSubHwid: string | null = null;

function offerSubstitution(newHwid: string): void {
  _pendingSubHwid = newHwid;
  const select = document.getElementById('sub-select') as HTMLSelectElement;
  select.innerHTML = state.boxOrder.map(hwid => {
    const disconnected = state.boxes[hwid]?.status === 'disconnected';
    return `<option value="${hwid}"${disconnected ? ' selected' : ''}>${getDisplayName(hwid)}${disconnected ? ' (disconnected)' : ''}</option>`;
  }).join('');
  const firstDisconnected = state.boxOrder.find(h => state.boxes[h]?.status === 'disconnected');
  if (firstDisconnected) select.value = firstDisconnected;
  const disableNewPlayerMidGame = currentGame?.disableNewPlayerMidGame?.() ?? false;
  const allowAddWithoutSubstitution = !disableNewPlayerMidGame;
  const cancelBtn = document.getElementById('cancel-sub-btn') as HTMLButtonElement;
  cancelBtn.disabled = !allowAddWithoutSubstitution;
  cancelBtn.style.display = allowAddWithoutSubstitution ? '' : 'none';
  (document.getElementById('sub-overlay') as HTMLElement).style.display = 'flex';
  render();
}

export function confirmSubstitution(): void {
  const oldHwid = (document.getElementById('sub-select') as HTMLSelectElement).value;
  if (!oldHwid || !_pendingSubHwid || !state.boxes[oldHwid] || !state.boxes[_pendingSubHwid]) {
    cancelSubstitution();
    return;
  }
  substituteBox(oldHwid, _pendingSubHwid);
  _pendingSubHwid = null;
  (document.getElementById('sub-overlay') as HTMLElement).style.display = 'none';
}

export function cancelSubstitution(): void {
  if (_pendingSubHwid && (currentGame?.disableNewPlayerMidGame?.() ?? false)) return;
  if (_pendingSubHwid && state.boxes[_pendingSubHwid]) {
    state.boxOrder.push(_pendingSubHwid);
    log(`${getDisplayName(_pendingSubHwid)} added to game (no substitution)`, 'system');
  }
  _pendingSubHwid = null;
  (document.getElementById('sub-overlay') as HTMLElement).style.display = 'none';
  updateSetupUI();
  render();
}

function substituteBox(oldHwid: string, newHwid: string): void {
  const replacedBox = state.boxes[oldHwid];
  const replacementBox = state.boxes[newHwid];
  if (!replacedBox || !replacementBox) return;

  const replacedBoxName = getDisplayName(oldHwid);

  // Carry over the gameplay-facing state from the missing box to the newly
  // connected one. Transport-specific fields like firmware/update state stay
  // with the physical replacement box.
  const boxFieldsToTransfer = [
    'status', 'badges', 'factionId', 'leds', 'ledOverrideUntil',
    'turnStartTime', 'totalTurnTime', 'turnHistory',
    'strategyColor', 'choosingLeds',
  ] as const;
  boxFieldsToTransfer.forEach(fieldName => {
    if (replacedBox[fieldName] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (replacementBox as any)[fieldName] = (replacedBox as any)[fieldName];
    }
  });

  if (replacementBox.isVirtual) {
    virtualBoxNames[newHwid] = replacedBoxName;
  } else {
    setBoxName(newHwid, replacedBoxName);
  }

  const replacedSeatIndex = state.boxOrder.indexOf(oldHwid);
  if (replacedSeatIndex !== -1) state.boxOrder[replacedSeatIndex] = newHwid;

  if (state.activeBoxId === oldHwid) state.activeBoxId = newHwid;
  // Generic state lives here; each mode is responsible for rewriting any IDs it
  // keeps in its own state shape.
  currentGame?.onBoxSubstituted?.(oldHwid, newHwid);
  substituteTimerTracking(oldHwid, newHwid);

  const replacedHubBox = oldHwid === state.hubHwid;
  if (replacedHubBox) {
    state.hubHwid = newHwid;
    log('⚠️ Hub box substituted. If the hub hardware is being replaced, reconnect to the new hub address and power-cycle the other boxes.', 'error');
  }

  delete state.boxes[oldHwid];
  if (replacedBox.isVirtual) delete virtualBoxNames[oldHwid];
  log(`${replacedBoxName} substituted — now on ${getDisplayName(newHwid)}`, 'system');
  syncLeds();
  updateSetupUI();
  render();
}

// ---- Setup UI ----

export function onGameModeChange(): void {
  state.gameMode = (document.getElementById('game-mode') as HTMLSelectElement).value;
  updateSetupUI();
}

export function updateSetupUI(): void {
  const count = Object.keys(state.boxes).length;
  const mode = (document.getElementById('game-mode') as HTMLSelectElement).value;
  const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
  const startValidation = setupGame?.getStartValidation?.() ?? { valid: true };

  (document.getElementById('player-count') as HTMLElement).textContent =
    `${count} box${count !== 1 ? 'es' : ''} connected`;
  startBtn.disabled = count < 2 || state.gameActive || !startValidation.valid;
  startBtn.title = startValidation.valid ? '' : (startValidation.reason ?? '');
  (document.getElementById('prev-stats-btn') as HTMLElement).style.display =
    prevGameStats ? 'block' : 'none';
  updateResumeBtnState();
  renderModeSetupFields(setupGame?.getSetupFields?.() ?? []);

  const hasTags = (state.allTags?.[mode]?.length ?? 0) > 0;
  (document.getElementById('write-tags-btn') as HTMLElement).style.display = hasTags ? 'block' : 'none';
  const hasFactionTags = (state.allTags?.[mode] ?? []).some(t => t.id.includes(':faction:'));
  const showFactions = (hasFactionTags && !!state.factions) ? 'block' : 'none';
  (document.getElementById('set-factions-btn') as HTMLElement).style.display = showFactions;
  (document.getElementById('set-factions-debug-btn') as HTMLElement).style.display = showFactions;

  renderExpansionUI(setupGame);
}

function renderModeSetupFields(fields: SetupField[]): void {
  const container = document.getElementById('mode-setup-fields') as HTMLElement | null;
  if (!container) return;

  const previousValues = new Map<string, string | boolean>();
  container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id], select[id]').forEach(el => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      previousValues.set(el.id, el.checked);
    } else {
      previousValues.set(el.id, el.value);
    }
  });

  container.innerHTML = fields.map(field => {
    if (field.type === 'select') {
      const optionsHtml = field.options.map(option =>
        `<option value="${option.value}">${option.label}</option>`
      ).join('');
      const hintHtml = field.hint ? `<span class="hint">${field.hint}</span>` : '';
      return `<div class="setup-row">
        <label>${field.label}</label>
        <select id="${field.id}">${optionsHtml}</select>
        ${hintHtml}
      </div>`;
    }

    const hintHtml = field.hint ? `<span class="hint">${field.hint}</span>` : '';
    return `<div class="setup-row">
      <label>${field.label}</label>
      <label class="toggle-wrap">
        <input type="checkbox" id="${field.id}">
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
      ${hintHtml}
    </div>`;
  }).join('');

  fields.forEach(field => {
    const el = container.querySelector(`#${field.id}`);
    if (!el) return;

    if (field.type === 'select') {
      const select = el as HTMLSelectElement;
      const selectedValue = previousValues.get(field.id);
      const fallbackValue = field.value ?? field.options[0]?.value ?? '';
      const nextValue = typeof selectedValue === 'string' ? selectedValue : fallbackValue;
      if (field.options.some(option => option.value === nextValue)) {
        select.value = nextValue;
      }
      return;
    }

    const input = el as HTMLInputElement;
    const checkedValue = previousValues.get(field.id);
    input.checked = typeof checkedValue === 'boolean' ? checkedValue : (field.checked ?? false);
  });
}

export function setBoxBadges(hwid: string, badges: Badge[]): void {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].badges = badges;
}
