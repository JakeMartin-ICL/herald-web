import { state } from './state';
import { sendToBox, enableRfid, disableRfid } from './websockets';
import { getDisplayName } from './boxes';
import type { LedCommand } from './types';

interface BoxTestState {
  endTurn: boolean;
  pass: boolean;
  rfid: boolean;
}

const activeTests = new Map<string, BoxTestState>();

// ---- Public: message interception ----

/** Returns true if the event was consumed by an active hardware test. */
export function handleHwTestEvent(hwid: string, event: 'endturn' | 'pass'): boolean {
  const test = activeTests.get(hwid);
  if (!test) return false;
  if (event === 'endturn') test.endTurn = true;
  if (event === 'pass') test.pass = true;
  onTestProgress(hwid, test);
  return true;
}

/** Returns true if the RFID event was consumed by an active hardware test. */
export function handleHwTestRfid(hwid: string, internalId: string): boolean {
  const test = activeTests.get(hwid);
  if (!test) return false;
  if (!test.rfid && isKnownTag(internalId)) {
    test.rfid = true;
    onTestProgress(hwid, test);
  }
  return true; // always consume — don't let test RFID scans affect game state
}

// ---- Dialog ----

export function openHwTestDialog(): void {
  (document.getElementById('hwtest-overlay') as HTMLElement).style.display = 'flex';
  renderHwTestDialog();
}

export function closeHwTestDialog(): void {
  (document.getElementById('hwtest-overlay') as HTMLElement).style.display = 'none';
  for (const hwid of activeTests.keys()) exitBoxTest(hwid);
  activeTests.clear();
}

export function renderHwTestDialog(): void {
  const el = document.getElementById('hwtest-dialog-content');
  if (!el) return;

  const realBoxes = state.boxOrder.filter(hwid => {
    const box = state.boxes[hwid];
    return box && !box.isVirtual && box.status !== 'disconnected';
  });

  if (realBoxes.length === 0) {
    el.innerHTML = '<div style="color:#888">No boxes connected</div>';
    return;
  }

  el.innerHTML = realBoxes.map(hwid => {
    const test = activeTests.get(hwid);
    const running = !!test;

    const chips = running ? `
      <span class="hwtest-chip${test.endTurn ? ' done' : ''}">End Turn</span>
      <span class="hwtest-chip${test.pass ? ' done' : ''}">Pass</span>
      <span class="hwtest-chip${test.rfid ? ' done' : ''}">RFID</span>
    ` : '';

    const btn = running
      ? `<button class="hwtest-stop-btn" data-hwid="${hwid}">Stop</button>`
      : `<button class="hwtest-run-btn" data-hwid="${hwid}">Run</button>`;

    return `<div class="hwtest-row">
      <span class="hwtest-name">${getDisplayName(hwid)}</span>
      <div class="hwtest-chips">${chips}</div>
      ${btn}
    </div>`;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('.hwtest-run-btn').forEach(btn => {
    btn.addEventListener('click', () => startBoxTest(btn.dataset.hwid!));
  });
  el.querySelectorAll<HTMLButtonElement>('.hwtest-stop-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const hwid = btn.dataset.hwid!;
      exitBoxTest(hwid);
      activeTests.delete(hwid);
      renderHwTestDialog();
    });
  });
}

// ---- Internal ----

function startBoxTest(hwid: string): void {
  if (activeTests.has(hwid)) return;
  activeTests.set(hwid, { endTurn: false, pass: false, rfid: false });
  enableRfid(hwid);
  const box = state.boxes[hwid];
  if (box) box.leds = { type: 'led_off' };
  sendToBox(hwid, { type: 'led_off' });
  renderHwTestDialog();
}

function exitBoxTest(hwid: string): void {
  disableRfid(hwid);
  const box = state.boxes[hwid];
  if (box) box.leds = null;
  sendToBox(hwid, { type: 'led_off' });
}

function onTestProgress(hwid: string, test: BoxTestState): void {
  const count = [test.endTurn, test.pass, test.rfid].filter(Boolean).length;
  updateTestLeds(hwid, count);
  renderHwTestDialog();

  if (count === 3) {
    setTimeout(() => {
      exitBoxTest(hwid);
      activeTests.delete(hwid);
      renderHwTestDialog();
    }, 2000);
  }
}

function updateTestLeds(hwid: string, count: number): void {
  const box = state.boxes[hwid];
  if (!box) return;
  const green = '#00aa00';
  const off = '#000000';
  let cmd: LedCommand;
  if (count === 1) cmd = { type: 'led_thirds', c1: green, c2: off, c3: off };
  else if (count === 2) cmd = { type: 'led_thirds', c1: green, c2: green, c3: off };
  else cmd = { type: 'led_thirds', c1: green, c2: green, c3: green };
  box.leds = cmd;
  sendToBox(hwid, cmd);
}

function isKnownTag(internalId: string): boolean {
  if (!state.allTags) return internalId.includes(':');
  for (const tags of Object.values(state.allTags)) {
    if (tags.some(t => t.id === internalId)) return true;
  }
  return false;
}
