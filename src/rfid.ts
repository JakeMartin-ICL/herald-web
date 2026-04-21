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
  prompt: string;
  internalId: string;
}

let tagWritingQueue: TagQueueItem[] = [];
let tagWritingIndex = 0;
let tagWritingActive = false;
let tagWritingPending = false;

export function buildTagQueue(game: string): TagQueueItem[] {
  return filterTags(game, () => true).map(t => ({
    prompt: `Tap ${t.display} on the hub box`,
    internalId: t.id,
  }));
}

export function startTagWriting(queue: TagQueueItem[], title?: string): void {
  tagWritingQueue = queue;
  tagWritingIndex = 0;
  tagWritingActive = true;
  (document.getElementById('tag-writing-title') as HTMLElement).textContent = title ?? 'Write Tags';
  (document.getElementById('tag-writing-overlay') as HTMLElement).style.display = 'flex';
  showNextTagPrompt();
  if (state.hubHwid) enableRfid(state.hubHwid);
}

function showNextTagPrompt(): void {
  if (tagWritingIndex >= tagWritingQueue.length) {
    finishTagWriting();
    return;
  }
  const item = tagWritingQueue[tagWritingIndex];
  (document.getElementById('tag-writing-prompt') as HTMLElement).textContent = item.prompt;
  (document.getElementById('tag-writing-status') as HTMLElement).textContent =
    `${tagWritingIndex} of ${tagWritingQueue.length} written`;
}

function handleTagWriting(_internalId: string): void {
  if (!tagWritingActive || tagWritingPending) return;
  tagWritingPending = true;
  (document.getElementById('tag-writing-status') as HTMLElement).textContent = 'Writing…';
  sendRfidWrite(tagWritingQueue[tagWritingIndex].internalId);
}

export function handleRfidWriteResult(msg: { success: boolean; error?: string }): void {
  tagWritingPending = false;
  if (msg.success) {
    (document.getElementById('tag-writing-status') as HTMLElement).textContent = '✓ Written';
    tagWritingIndex++;
    setTimeout(showNextTagPrompt, 800);
  } else {
    (document.getElementById('tag-writing-status') as HTMLElement).textContent =
      `✗ Failed: ${msg.error ?? 'Unknown error'}`;
  }
}

function sendRfidWrite(internalId: string): void {
  if (!state.hubHwid) return;
  sendToBox(state.hubHwid, { type: 'rfid_write', hwid: state.hubHwid, internalId });
}

function finishTagWriting(): void {
  if (state.hubHwid) disableRfid(state.hubHwid);
  tagWritingActive = false;
  (document.getElementById('tag-writing-overlay') as HTMLElement).style.display = 'none';
  log('Tag writing complete', 'system');
  updateSetupUI();
}

export function cancelTagWriting(): void {
  if (state.hubHwid) disableRfid(state.hubHwid);
  tagWritingActive = false;
  tagWritingPending = false;
  tagWritingIndex = 0;
  tagWritingQueue = [];
  (document.getElementById('tag-writing-overlay') as HTMLElement).style.display = 'none';
}

// ---- RFID dispatch ----

export function handleRfid(hwid: string, internalId: string): void {
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
  (document.getElementById('tag-writing-status') as HTMLElement).textContent = 'Written (simulated)';
  tagWritingIndex++;
  setTimeout(showNextTagPrompt, 800);
}
