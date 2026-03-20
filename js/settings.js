// ---- Debug logging dialog ----

function openDebugDialog() {
  document.getElementById('debug-log-overlay').style.display = 'flex';
  renderDebugDialog();
}

function closeDebugDialog() {
  document.getElementById('debug-log-overlay').style.display = 'none';
}

function toggleBoxDebug(hwid, enabled) {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].debugEnabled = enabled;
  send({ type: enabled ? 'debug_on' : 'debug_off', hwid });
}

function renderDebugDialog() {
  const el = document.getElementById('debug-log-content');
  if (!el) return;
  const rows = state.boxOrder.map(hwid => {
    const box = state.boxes[hwid];
    if (!box) return '';
    const isHub = hwid === state.hubHwid;
    const checked = box.debugEnabled ? 'checked' : '';
    return `<div class="debug-log-row">
      <span class="debug-log-name">${getDisplayName(hwid)}${isHub ? ' <span class="ota-hub">(Hub)</span>' : ''}</span>
      <label class="debug-toggle">
        <input type="checkbox" ${checked} onchange="toggleBoxDebug('${hwid}', this.checked)">
        <span>Debug</span>
      </label>
    </div>`;
  }).join('');
  el.innerHTML = rows || '<div style="color:#888">No boxes connected</div>';
}

// ---- WiFi credentials dialog ----

let _wifiCredentials = null; // null = not loaded yet
let _wifiCredentialsTimeout = null;
let _wifiDragIndex = null;
let _wifiDragOverIndex = null;

function openWifiDialog() {
  document.getElementById('wifi-overlay').style.display = 'flex';
  _wifiCredentials = null;
  renderWifiDialog();
  _wifiCredentialsTimeout = setTimeout(() => {
    if (_wifiCredentials === null) {
      _wifiCredentials = [];
      renderWifiDialog();
    }
  }, 5000);
  if (state.hubHwid) send({ type: 'wifi_credentials_get', hwid: state.hubHwid });
  document.addEventListener('mousemove', _onWifiDragMove);
  document.addEventListener('mouseup', _onWifiDragEnd);
  document.addEventListener('touchmove', _onWifiDragMove, { passive: false });
  document.addEventListener('touchend', _onWifiDragEnd);
}

function closeWifiDialog() {
  document.getElementById('wifi-overlay').style.display = 'none';
  clearTimeout(_wifiCredentialsTimeout);
  document.removeEventListener('mousemove', _onWifiDragMove);
  document.removeEventListener('mouseup', _onWifiDragEnd);
  document.removeEventListener('touchmove', _onWifiDragMove);
  document.removeEventListener('touchend', _onWifiDragEnd);
  _wifiDragIndex = null;
  _wifiDragOverIndex = null;
}

function renderWifiDialog() {
  const el = document.getElementById('wifi-dialog-content');
  if (!el) return;

  if (_wifiCredentials === null) {
    el.innerHTML = '<div style="color:#888; padding:0.5rem 0;">Loading…</div>';
    return;
  }

  let html = '<div id="wifi-cred-list">';
  _wifiCredentials.forEach((_, i) => {
    html += `<div class="wifi-row" data-index="${i}">
      <span class="wifi-drag-handle">⠿</span>
      <div class="wifi-fields">
        <input class="wifi-ssid" type="text" placeholder="Network name" oninput="updateWifiCred(${i},'ssid',this.value)">
        <input class="wifi-pwd" type="password" placeholder="Password" oninput="updateWifiCred(${i},'password',this.value)">
      </div>
      <button class="wifi-remove-btn" onclick="removeWifiCred(${i})">✕</button>
    </div>`;
  });
  html += '</div>';
  html += '<button class="wifi-add-btn" onclick="addWifiCred()">+ Add Network</button>';
  el.innerHTML = html;

  // Set values via JS to handle special characters safely
  el.querySelectorAll('.wifi-row').forEach((row, i) => {
    row.querySelector('.wifi-ssid').value = _wifiCredentials[i].ssid;
    row.querySelector('.wifi-pwd').value = _wifiCredentials[i].password;
  });

  // Drag handles
  el.querySelectorAll('.wifi-drag-handle').forEach((handle, i) => {
    handle.addEventListener('mousedown', (e) => { _wifiDragIndex = i; e.preventDefault(); });
    handle.addEventListener('touchstart', () => { _wifiDragIndex = i; }, { passive: true });
  });
}

function _onWifiDragMove(e) {
  if (_wifiDragIndex === null) return;
  if (e.cancelable) e.preventDefault();
  const y = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
  const rows = document.querySelectorAll('.wifi-row');
  let newOver = null;
  rows.forEach((row, i) => {
    const rect = row.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) newOver = i;
  });
  if (newOver !== null && newOver !== _wifiDragOverIndex) {
    _wifiDragOverIndex = newOver;
    rows.forEach((row, i) => {
      row.classList.toggle('wifi-drag-over', i === _wifiDragOverIndex && i !== _wifiDragIndex);
      row.classList.toggle('wifi-dragging', i === _wifiDragIndex);
    });
  }
}

function _onWifiDragEnd() {
  if (_wifiDragIndex === null) return;
  if (_wifiDragOverIndex !== null && _wifiDragOverIndex !== _wifiDragIndex) {
    const [item] = _wifiCredentials.splice(_wifiDragIndex, 1);
    _wifiCredentials.splice(_wifiDragOverIndex, 0, item);
    renderWifiDialog();
  } else {
    document.querySelectorAll('.wifi-row').forEach(r => r.classList.remove('wifi-dragging', 'wifi-drag-over'));
  }
  _wifiDragIndex = null;
  _wifiDragOverIndex = null;
}

function addWifiCred() {
  if (!_wifiCredentials) _wifiCredentials = [];
  _wifiCredentials.push({ ssid: '', password: '' });
  renderWifiDialog();
}

function removeWifiCred(index) {
  _wifiCredentials.splice(index, 1);
  renderWifiDialog();
}

function updateWifiCred(index, field, value) {
  if (_wifiCredentials && _wifiCredentials[index]) {
    _wifiCredentials[index][field] = value;
  }
}

function saveWifiCredentials() {
  if (!state.hubHwid || !_wifiCredentials) return;
  const filtered = _wifiCredentials.filter(c => c.ssid.trim() !== '');
  send({ type: 'wifi_credentials_set', hwid: state.hubHwid, credentials: filtered });
  const statusEl = document.getElementById('wifi-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';
}
