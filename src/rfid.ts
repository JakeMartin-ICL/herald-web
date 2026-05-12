import { state } from './state';
import { log } from './logger';
import { enableRfid, disableRfid, disableAllRfid, sendToBox, sendRfidPrompt, handleMessage } from './websockets';
import { getDisplayName, updateSetupUI, setAutoName } from './boxes';
import { render, renderBoxes } from './render';
import { isManuallyRenamed } from './render';
import { filterTags, getRelevantTagsForBox } from './tags';
import { currentGame } from './currentGame';
import { persistState } from './persist';
import { snapshotForUndo } from './undo';

// ---- RFID dialog ----

let rfidDialogHwid: string | null = null;

export function openRfidDialog(hwid: string): void {
  rfidDialogHwid = hwid;
  const tags = getRelevantTagsForBox(hwid);
  const list = document.getElementById('rfid-dialog-list') as HTMLElement;
  list.innerHTML = '';
  tags.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'rfid-option';
    btn.textContent = t.display;
    btn.addEventListener('click', () => selectRfidOption(t.id));
    list.appendChild(btn);
  });
  (document.getElementById('rfid-dialog-overlay') as HTMLElement).style.display = 'flex';
}

function selectRfidOption(tagId: string): void {
  if (!rfidDialogHwid) return;
  const hwid = rfidDialogHwid;
  closeRfidDialog();
  log(`[SIM] ${getDisplayName(hwid)} tapped ${tagId}`, 'system');
  handleMessage({ type: 'rfid', hwid, tagId });
}

export function closeRfidDialog(): void {
  (document.getElementById('rfid-dialog-overlay') as HTMLElement).style.display = 'none';
  rfidDialogHwid = null;
}

// ---- Tag Writing ----

interface TagQueueItem {
  label: string;
  prompt: string;
  internalId: string;
}

let tagWritingQueue: TagQueueItem[] = [];
let tagWritingIndex = 0;
let tagWritingActive = false;
let tagWritingPending = false;
let tagWritingArmed = false;
let tagWritingTestMode = false;
let tagWritingCompleted = new Set<number>();
let tagWritingDelayTimer: ReturnType<typeof setTimeout> | null = null;
const TAG_WRITE_DELAY_MS = 3000;

export function buildTagQueue(game: string): TagQueueItem[] {
  return filterTags(game, () => true).map(t => ({
    label: t.display,
    prompt: `Tap ${t.display} on the hub box`,
    internalId: t.id,
  }));
}

export function startTagWriting(queue: TagQueueItem[], title?: string): void {
  clearTagWritingDelay();
  tagWritingQueue = queue;
  tagWritingIndex = 0;
  tagWritingActive = true;
  tagWritingPending = false;
  tagWritingArmed = true;
  tagWritingTestMode = false;
  tagWritingCompleted = new Set<number>();
  (document.getElementById('tag-writing-title') as HTMLElement).textContent = title ?? 'Write Tags';
  (document.getElementById('tag-writing-overlay') as HTMLElement).style.display = 'flex';
  showNextTagPrompt();
  if (state.hubHwid) enableRfid(state.hubHwid);
}

function showNextTagPrompt(): void {
  clearTagWritingDelay();
  if (tagWritingIndex >= tagWritingQueue.length) {
    finishTagWriting();
    return;
  }
  tagWritingArmed = true;
  const item = tagWritingQueue[tagWritingIndex];
  (document.getElementById('tag-writing-prompt') as HTMLElement).textContent = item.prompt;
  (document.getElementById('tag-writing-status') as HTMLElement).textContent =
    `${tagWritingIndex + 1} of ${tagWritingQueue.length}`;
  const readResult = document.getElementById('tag-writing-read-result') as HTMLElement | null;
  if (readResult && !tagWritingTestMode) readResult.textContent = '';
  renderTagWritingControls();
  renderTagWritingList();
  if (state.hubHwid) enableRfid(state.hubHwid);
}

function handleTagWriting(_internalId: string): void {
  if (!tagWritingActive || tagWritingPending || tagWritingTestMode || !tagWritingArmed) return;
  tagWritingPending = true;
  tagWritingArmed = false;
  (document.getElementById('tag-writing-status') as HTMLElement).textContent = 'Writing...';
  renderTagWritingControls();
  sendRfidWrite(tagWritingQueue[tagWritingIndex].internalId);
}

export function handleRfidWriteResult(msg: { success: boolean; error?: string }): void {
  tagWritingPending = false;
  if (msg.success) {
    (document.getElementById('tag-writing-status') as HTMLElement).textContent = 'Written. Remove tag...';
    tagWritingCompleted.add(tagWritingIndex);
    tagWritingIndex++;
    tagWritingDelayTimer = setTimeout(showNextTagPrompt, TAG_WRITE_DELAY_MS);
    renderTagWritingControls();
    renderTagWritingList();
    if (state.hubHwid) disableRfid(state.hubHwid);
  } else {
    tagWritingArmed = true;
    (document.getElementById('tag-writing-status') as HTMLElement).textContent =
      `Failed: ${msg.error ?? 'Unknown error'}`;
    renderTagWritingControls();
  }
}

function sendRfidWrite(internalId: string): void {
  if (!state.hubHwid) return;
  sendToBox(state.hubHwid, { type: 'rfid_write', hwid: state.hubHwid, internalId });
}

function finishTagWriting(): void {
  clearTagWritingDelay();
  if (state.hubHwid) disableRfid(state.hubHwid);
  tagWritingActive = false;
  tagWritingPending = false;
  tagWritingArmed = false;
  tagWritingTestMode = false;
  (document.getElementById('tag-writing-overlay') as HTMLElement).style.display = 'none';
  log('Tag writing complete', 'system');
  updateSetupUI();
}

export function cancelTagWriting(): void {
  clearTagWritingDelay();
  if (state.hubHwid) disableRfid(state.hubHwid);
  tagWritingActive = false;
  tagWritingPending = false;
  tagWritingArmed = false;
  tagWritingTestMode = false;
  tagWritingCompleted = new Set<number>();
  tagWritingIndex = 0;
  tagWritingQueue = [];
  (document.getElementById('tag-writing-overlay') as HTMLElement).style.display = 'none';
}

export function previousTagWritingItem(): void {
  jumpToTagWritingIndex(tagWritingIndex - 1);
}

export function nextTagWritingItem(): void {
  jumpToTagWritingIndex(tagWritingIndex + 1);
}

export function toggleTagWritingTestMode(): void {
  if (!tagWritingActive || tagWritingPending) return;
  clearTagWritingDelay();
  tagWritingTestMode = !tagWritingTestMode;
  tagWritingArmed = !tagWritingTestMode;
  const readResult = document.getElementById('tag-writing-read-result') as HTMLElement | null;
  if (readResult) readResult.textContent = tagWritingTestMode ? 'Tap any tag to read its ID.' : '';
  if (tagWritingTestMode) {
    if (state.hubHwid) enableRfid(state.hubHwid);
  } else {
    showNextTagPrompt();
  }
  renderTagWritingControls();
}

function jumpToTagWritingIndex(index: number): void {
  if (!tagWritingActive || tagWritingPending) return;
  if (index < 0 || index >= tagWritingQueue.length) return;
  tagWritingIndex = index;
  tagWritingTestMode = false;
  showNextTagPrompt();
}

function clearTagWritingDelay(): void {
  if (!tagWritingDelayTimer) return;
  clearTimeout(tagWritingDelayTimer);
  tagWritingDelayTimer = null;
}

function renderTagWritingControls(): void {
  const backBtn = document.getElementById('tag-writing-back-btn') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('tag-writing-next-btn') as HTMLButtonElement | null;
  const testBtn = document.getElementById('tag-writing-test-btn') as HTMLButtonElement | null;
  const simulateBtn = document.getElementById('simulate-tag-tap-btn') as HTMLButtonElement | null;

  if (backBtn) backBtn.disabled = tagWritingPending || tagWritingIndex <= 0;
  if (nextBtn) nextBtn.disabled = tagWritingPending || tagWritingIndex >= tagWritingQueue.length - 1;
  if (testBtn) {
    testBtn.disabled = tagWritingPending;
    testBtn.textContent = tagWritingTestMode ? 'Resume Writing' : 'Test Read';
    testBtn.classList.toggle('active', tagWritingTestMode);
  }
  if (simulateBtn) simulateBtn.disabled = tagWritingPending || (!tagWritingTestMode && !tagWritingArmed);
}

function renderTagWritingList(): void {
  const list = document.getElementById('tag-writing-list') as HTMLElement | null;
  if (!list) return;

  list.innerHTML = '';
  tagWritingQueue.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.className = 'tag-writing-item';
    if (tagWritingCompleted.has(index)) btn.classList.add('done');
    if (index === tagWritingIndex) btn.classList.add('current');
    btn.disabled = tagWritingPending;
    btn.dataset.index = String(index);
    const indexEl = document.createElement('span');
    indexEl.className = 'tag-writing-item-index';
    indexEl.textContent = String(index + 1);
    const labelEl = document.createElement('span');
    labelEl.className = 'tag-writing-item-label';
    labelEl.textContent = item.label;
    btn.append(indexEl, labelEl);
    btn.addEventListener('click', () => jumpToTagWritingIndex(index));
    list.appendChild(btn);
  });
}

// ---- RFID dispatch ----

export function handleRfid(hwid: string, internalId: string): void {
  if (tagWritingActive) {
    if (hwid === state.hubHwid) {
      if (tagWritingTestMode) {
        const readResult = document.getElementById('tag-writing-read-result') as HTMLElement | null;
        if (readResult) readResult.textContent = `Read: ${internalId}`;
      } else {
        handleTagWriting(internalId);
      }
    }
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

  snapshotForUndo();
  currentGame?.onRfid?.(hwid, game, category, id);
  render();
  persistState();
}

// ---- Faction Scan ----

export function toggleRfidPrompt(hwid: string): void {
  const box = state.boxes[hwid];
  if (!box || box.isVirtual) return;
  box.rfidPromptOn = !box.rfidPromptOn;
  sendRfidPrompt(hwid, box.rfidPromptOn);
  renderBoxes();
}

export function startFactionScan(): void {
  if (!state.gameActive) {
    state.gameMode = (document.getElementById('game-mode') as HTMLSelectElement).value;
  }
  state.factionScanActive = true;
  disableAllRfid();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    enableRfid(hwid);
    box.rfidPromptOn = true;
    sendRfidPrompt(hwid, true);
  });
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    box.leds = { type: 'led_off' };
    if (!box.isVirtual) sendToBox(hwid, { type: 'led_off' });
  });
  (document.getElementById('faction-scan-banner') as HTMLElement).style.display = 'flex';
  render();
}

export function stopFactionScan(): void {
  disableAllRfid();
  state.factionScanActive = false;
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box) return;
    box.leds = null;
    if (!box.isVirtual && box.rfidPromptOn) {
      box.rfidPromptOn = false;
      sendRfidPrompt(hwid, false);
    }
  });
  (document.getElementById('faction-scan-banner') as HTMLElement).style.display = 'none';
  render();
}

function handleFactionScan(hwid: string, internalId: string): void {
  const parts = internalId.split(':');
  const category = parts[1];
  const factionId = parts.slice(2).join(':');

  if (category !== 'faction') return;

  const faction = Object.values(state.factions ?? {}).flat().find(f => f.id === factionId);
  if (!faction) return;

  state.boxes[hwid].factionId = factionId;

  if (!isManuallyRenamed(hwid)) {
    setAutoName(hwid, faction.nickname ?? faction.name);
  }

  state.boxes[hwid].leds = { type: 'led_solid', color: faction.color };
  if (!state.boxes[hwid].isVirtual) sendToBox(hwid, { type: 'led_solid', color: faction.color });
  log(`${getDisplayName(hwid)} identified as ${faction.name}`, 'system');
  currentGame?.onFactionChanged?.();
  updateSetupUI();
  render();
}

// ---- Simulator ----

export function simulateButton(hwid: string, type: string): void {
  log(`[SIM] ${getDisplayName(hwid)} pressed ${type}`, 'system');
  handleMessage({ type, hwid });
}

export function simulateTagTap(): void {
  if (!tagWritingActive) return;
  const item = tagWritingQueue[tagWritingIndex];
  if (!item) return;
  if (tagWritingTestMode) {
    const readResult = document.getElementById('tag-writing-read-result') as HTMLElement | null;
    if (readResult) readResult.textContent = `Read: ${item.internalId}`;
    return;
  }
  if (tagWritingPending || !tagWritingArmed) return;
  (document.getElementById('tag-writing-status') as HTMLElement).textContent = 'Written (simulated)';
  tagWritingCompleted.add(tagWritingIndex);
  tagWritingIndex++;
  tagWritingArmed = false;
  tagWritingDelayTimer = setTimeout(showNextTagPrompt, TAG_WRITE_DELAY_MS);
  renderTagWritingControls();
  renderTagWritingList();
}
