import { state } from './state';
import { log } from './logger';
import { send, sendToBox } from './websockets';
import { LED_COUNT, ledSolid, ledOff, ledStateForStatus } from './leds';
import { getDisplayName } from './boxes';
import { isVersionOutOfDate, fetchLatestFirmware } from './firmware';

let _otaInterval: ReturnType<typeof setInterval> | null = null;
let _identifyingHwid: string | null = null;
let _identifyTimer: ReturnType<typeof setTimeout> | null = null;

export function identifyBox(hwid: string): void {
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

export function openOtaDialog(): void {
  (document.getElementById('ota-overlay') as HTMLElement).style.display = 'flex';
  renderOtaDialog();
  _otaInterval = setInterval(renderOtaDialog, 1000);
}

export function closeOtaDialog(): void {
  const anyUpdating = state.boxOrder.some(id => state.boxes[id]?.otaUpdating);
  if (anyUpdating) {
    const el = document.getElementById('ota-close-warning');
    if (el) el.style.display = '';
    return;
  }
  (document.getElementById('ota-overlay') as HTMLElement).style.display = 'none';
  if (_otaInterval) { clearInterval(_otaInterval); _otaInterval = null; }
}

export function forceCloseOtaDialog(): void {
  (document.getElementById('ota-overlay') as HTMLElement).style.display = 'none';
  if (_otaInterval) { clearInterval(_otaInterval); _otaInterval = null; }
}

export function startOtaUpdate(hwid: string): void {
  if (!state.latestFirmware?.binUrl) return;
  const box = state.boxes[hwid];
  if (!box) return;
  box.otaUpdating = true;
  box.otaProgress = 0;
  box.otaError = null;
  send({ type: 'ota_update', hwid, url: state.latestFirmware.binUrl, version: state.latestFirmware.version });
  renderOtaDialog();
}

export function startOtaUpdateAll(): void {
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

export function renderOtaDialog(): void {
  const el = document.getElementById('ota-dialog-content');
  if (!el || (document.getElementById('ota-overlay') as HTMLElement).style.display === 'none') return;

  const fw = state.latestFirmware;
  const anyUpdating = state.boxOrder.some(id => state.boxes[id]?.otaUpdating);
  const allCurrent = state.boxOrder.every(id => !isVersionOutOfDate(state.boxes[id]?.version));

  const headerHtml = `
    <div class="ota-latest${fw ? '' : ' ota-unavailable'}">
      ${fw ? `Latest: <strong>${fw.version}</strong>
      <span class="ota-published">${fw.publishedAt ? new Date(fw.publishedAt).toLocaleDateString() : ''}</span>
      ${fw.releaseNotes ? `<details><summary>Release notes</summary><pre class="ota-notes">${fw.releaseNotes}</pre></details>` : ''}` : 'Unable to check for updates'}
      <button id="ota-refresh-btn" style="margin-left:0.75rem; font-size:0.75rem; padding:0.2rem 0.5rem;">↻ Check</button>
    </div>`;

  const rows = state.boxOrder.map(hwid => {
    const box = state.boxes[hwid];
    if (!box) return '';
    const isHub = hwid === state.hubHwid;
    const v = box.version ?? 'unknown';
    const outOfDate = isVersionOutOfDate(v);
    const vColor = v === 'unknown' ? '#888' : outOfDate ? '#c9a84c' : '#4a7';
    const canUpdate = fw?.binUrl && outOfDate && !box.otaUpdating;
    const canIdentify = box.status !== 'disconnected' && !box.isVirtual;
    const identifying = _identifyingHwid === hwid;
    const progressHtml = box.otaUpdating || box.otaProgress !== null ? `
      <div class="ota-progress-wrap">
        <div class="ota-progress-bar" style="width:${box.otaProgress ?? 0}%"></div>
      </div>` : '';
    const errorHtml = box.otaError ? `<div class="ota-error">${box.otaError}</div>` : '';
    return `<div class="ota-row">
      <span class="ota-name">${getDisplayName(hwid)}${isHub ? ' <span class="ota-hub">(Hub)</span>' : ''}</span>
      <span class="ota-version" style="color:${vColor}">${v}</span>
      <button class="ota-identify-btn${identifying ? ' identifying' : ''}" data-hwid="${hwid}" ${canIdentify ? '' : 'disabled'}>${identifying ? 'Identifying…' : 'Identify'}</button>
      <button class="ota-btn" data-hwid="${hwid}" ${canUpdate ? '' : 'disabled'}>Update</button>
      ${progressHtml}${errorHtml}
    </div>`;
  }).join('');

  el.innerHTML = `
    ${headerHtml}
    <div class="ota-rows">${rows || '<div style="color:#888">No boxes connected</div>'}</div>
    <div class="ota-actions">
      <button id="ota-update-all-btn" ${fw?.binUrl && !anyUpdating && !allCurrent ? '' : 'disabled'}>Update All</button>
    </div>`;

  // Attach event listeners (no inline onclick in TS)
  const refreshBtn = el.querySelector<HTMLButtonElement>('#ota-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↻ Checking…';
    void fetchLatestFirmware().then(() => renderOtaDialog());
  });
  el.querySelectorAll<HTMLButtonElement>('.ota-identify-btn').forEach(btn => {
    btn.addEventListener('click', () => identifyBox(btn.dataset.hwid!));
  });
  el.querySelectorAll<HTMLButtonElement>('.ota-btn').forEach(btn => {
    btn.addEventListener('click', () => startOtaUpdate(btn.dataset.hwid!));
  });
  const updateAllBtn = el.querySelector<HTMLButtonElement>('#ota-update-all-btn');
  if (updateAllBtn) updateAllBtn.addEventListener('click', startOtaUpdateAll);

  if (!fw) {
    log('OTA: no firmware info available', 'system');
  }
}
