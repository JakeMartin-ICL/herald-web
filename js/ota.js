// ---- OTA update dialog ----

let _otaInterval = null;
let _identifyingHwid = null;
let _identifyTimer = null;

function identifyBox(hwid) {
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

function openOtaDialog() {
  document.getElementById('ota-overlay').style.display = 'flex';
  renderOtaDialog();
  _otaInterval = setInterval(renderOtaDialog, 1000);
}

function closeOtaDialog() {
  const anyUpdating = state.boxOrder.some(id => state.boxes[id]?.otaUpdating);
  if (anyUpdating) {
    const el = document.getElementById('ota-close-warning');
    if (el) el.style.display = '';
    return;
  }
  document.getElementById('ota-overlay').style.display = 'none';
  clearInterval(_otaInterval);
  _otaInterval = null;
}

function forceCloseOtaDialog() {
  document.getElementById('ota-overlay').style.display = 'none';
  clearInterval(_otaInterval);
  _otaInterval = null;
}

function startOtaUpdate(hwid) {
  if (!state.latestFirmware?.binUrl) return;
  const box = state.boxes[hwid];
  if (!box) return;
  box.otaUpdating = true;
  box.otaProgress = 0;
  box.otaError = null;
  send({ type: 'ota_update', hwid, url: state.latestFirmware.binUrl, version: state.latestFirmware.version });
  renderOtaDialog();
}

function startOtaUpdateAll() {
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

function renderOtaDialog() {
  const el = document.getElementById('ota-dialog-content');
  if (!el || document.getElementById('ota-overlay').style.display === 'none') return;

  const fw = state.latestFirmware;
  const anyUpdating = state.boxOrder.some(id => state.boxes[id]?.otaUpdating);
  const allCurrent = state.boxOrder.every(id => !isVersionOutOfDate(state.boxes[id]?.version));

  const headerHtml = fw ? `
    <div class="ota-latest">
      Latest: <strong>${fw.version}</strong>
      <span class="ota-published">${fw.publishedAt ? new Date(fw.publishedAt).toLocaleDateString() : ''}</span>
      ${fw.releaseNotes ? `<details><summary>Release notes</summary><pre class="ota-notes">${fw.releaseNotes}</pre></details>` : ''}
    </div>` : `<div class="ota-latest ota-unavailable">Unable to check for updates</div>`;

  const rows = state.boxOrder.map(hwid => {
    const box = state.boxes[hwid];
    if (!box) return '';
    const isHub = hwid === state.hubHwid;
    const v = box.version || 'unknown';
    const outOfDate = isVersionOutOfDate(v);
    const vColor = v === 'unknown' ? '#888' : outOfDate ? '#c9a84c' : '#4a7';
    const canUpdate = fw?.binUrl && outOfDate && !box.otaUpdating;
    const canIdentify = box.status !== 'disconnected' && !box.isVirtual;
    const identifying = _identifyingHwid === hwid;
    const progressHtml = box.otaUpdating || box.otaProgress != null ? `
      <div class="ota-progress-wrap">
        <div class="ota-progress-bar" style="width:${box.otaProgress ?? 0}%"></div>
      </div>` : '';
    const errorHtml = box.otaError ? `<div class="ota-error">${box.otaError}</div>` : '';
    return `<div class="ota-row">
      <span class="ota-name">${getDisplayName(hwid)}${isHub ? ' <span class="ota-hub">(Hub)</span>' : ''}</span>
      <span class="ota-version" style="color:${vColor}">${v}</span>
      <button class="ota-identify-btn${identifying ? ' identifying' : ''}" onclick="identifyBox('${hwid}')" ${canIdentify ? '' : 'disabled'}>${identifying ? 'Identifying…' : 'Identify'}</button>
      <button class="ota-btn" onclick="startOtaUpdate('${hwid}')" ${canUpdate ? '' : 'disabled'}>Update</button>
      ${progressHtml}${errorHtml}
    </div>`;
  }).join('');

  el.innerHTML = `
    ${headerHtml}
    <div class="ota-rows">${rows || '<div style="color:#888">No boxes connected</div>'}</div>
    <div class="ota-actions">
      <button onclick="startOtaUpdateAll()" ${fw?.binUrl && !anyUpdating && !allCurrent ? '' : 'disabled'}>Update All</button>
    </div>`;
}
