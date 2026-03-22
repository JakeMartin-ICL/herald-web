import { state } from './state';
import { send } from './websockets';
import { getDisplayName } from './boxes';

// ---- Debug logging dialog ----

export function openDebugDialog(): void {
  (document.getElementById('debug-log-overlay') as HTMLElement).style.display = 'flex';
  renderDebugDialog();
}

export function closeDebugDialog(): void {
  (document.getElementById('debug-log-overlay') as HTMLElement).style.display = 'none';
}

function toggleBoxDebug(hwid: string, enabled: boolean): void {
  if (!state.boxes[hwid]) return;
  state.boxes[hwid].debugEnabled = enabled;
  send({ type: enabled ? 'debug_on' : 'debug_off', hwid });
}

function renderDebugDialog(): void {
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
        <input type="checkbox" ${checked} data-hwid="${hwid}" class="debug-toggle-cb">
        <span>Debug</span>
      </label>
    </div>`;
  }).join('');
  el.innerHTML = rows || '<div style="color:#888">No boxes connected</div>';

  el.querySelectorAll<HTMLInputElement>('.debug-toggle-cb').forEach(cb => {
    cb.addEventListener('change', () => toggleBoxDebug(cb.dataset.hwid!, cb.checked));
  });
}

// ---- WiFi credentials dialog ----

let _wifiCredentials: { ssid: string; password: string }[] | null = null;
let _wifiCredentialsTimeout: ReturnType<typeof setTimeout> | null = null;
let _wifiDragIndex: number | null = null;
let _wifiDragOverIndex: number | null = null;

export function openWifiDialog(): void {
  (document.getElementById('wifi-overlay') as HTMLElement).style.display = 'flex';
  _wifiCredentials = null;
  renderWifiDialog();
  _wifiCredentialsTimeout = setTimeout(() => {
    if (_wifiCredentials === null) {
      _wifiCredentials = [];
      renderWifiDialog();
    }
  }, 5000);
  if (state.hubHwid) send({ type: 'wifi_credentials_get', hwid: state.hubHwid });
  document.addEventListener('mousemove', onWifiDragMove);
  document.addEventListener('mouseup', onWifiDragEnd);
  document.addEventListener('touchmove', onWifiDragMove, { passive: false });
  document.addEventListener('touchend', onWifiDragEnd);
}

export function closeWifiDialog(): void {
  (document.getElementById('wifi-overlay') as HTMLElement).style.display = 'none';
  if (_wifiCredentialsTimeout) clearTimeout(_wifiCredentialsTimeout);
  document.removeEventListener('mousemove', onWifiDragMove);
  document.removeEventListener('mouseup', onWifiDragEnd);
  document.removeEventListener('touchmove', onWifiDragMove);
  document.removeEventListener('touchend', onWifiDragEnd);
  _wifiDragIndex = null;
  _wifiDragOverIndex = null;
}

export function renderWifiDialog(): void {
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
        <input class="wifi-ssid" type="text" placeholder="Network name" data-index="${i}">
        <input class="wifi-pwd" type="password" placeholder="Password" data-index="${i}">
      </div>
      <button class="wifi-remove-btn" data-index="${i}">✕</button>
    </div>`;
  });
  html += '</div>';
  html += '<button class="wifi-add-btn" id="wifi-add-btn">+ Add Network</button>';
  el.innerHTML = html;

  el.querySelectorAll<HTMLElement>('.wifi-row').forEach((row, i) => {
    const ssidInput = row.querySelector<HTMLInputElement>('.wifi-ssid')!;
    const pwdInput = row.querySelector<HTMLInputElement>('.wifi-pwd')!;
    ssidInput.value = _wifiCredentials![i].ssid;
    pwdInput.value = _wifiCredentials![i].password;
    ssidInput.addEventListener('input', () => { if (_wifiCredentials?.[i]) _wifiCredentials[i].ssid = ssidInput.value; });
    pwdInput.addEventListener('input', () => { if (_wifiCredentials?.[i]) _wifiCredentials[i].password = pwdInput.value; });

    const removeBtn = row.querySelector<HTMLButtonElement>('.wifi-remove-btn')!;
    removeBtn.addEventListener('click', () => {
      _wifiCredentials!.splice(i, 1);
      renderWifiDialog();
    });

    const handle = row.querySelector<HTMLElement>('.wifi-drag-handle')!;
    handle.addEventListener('mousedown', (e) => { _wifiDragIndex = i; e.preventDefault(); });
    handle.addEventListener('touchstart', () => { _wifiDragIndex = i; }, { passive: true });
  });

  const addBtn = el.querySelector<HTMLButtonElement>('#wifi-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      _wifiCredentials ??= [];
      _wifiCredentials.push({ ssid: '', password: '' });
      renderWifiDialog();
    });
  }
}

function onWifiDragMove(e: MouseEvent | TouchEvent): void {
  if (_wifiDragIndex === null) return;
  if (e.cancelable) e.preventDefault();
  const y = e instanceof TouchEvent ? e.touches[0].clientY : e.clientY;
  const rows = document.querySelectorAll('.wifi-row');
  let newOver: number | null = null;
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

function onWifiDragEnd(): void {
  if (_wifiDragIndex === null) return;
  if (_wifiDragOverIndex !== null && _wifiDragOverIndex !== _wifiDragIndex) {
    const [item] = _wifiCredentials!.splice(_wifiDragIndex, 1);
    _wifiCredentials!.splice(_wifiDragOverIndex, 0, item);
    renderWifiDialog();
  } else {
    document.querySelectorAll('.wifi-row').forEach(r => r.classList.remove('wifi-dragging', 'wifi-drag-over'));
  }
  _wifiDragIndex = null;
  _wifiDragOverIndex = null;
}

export function saveWifiCredentials(): void {
  if (!state.hubHwid || !_wifiCredentials) return;
  const filtered = _wifiCredentials.filter(c => c.ssid.trim() !== '');
  send({ type: 'wifi_credentials_set', hwid: state.hubHwid, credentials: filtered });
  const statusEl = document.getElementById('wifi-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';
}

export function receiveWifiCredentials(credentials: { ssid: string; password: string }[]): void {
  if (_wifiCredentialsTimeout) { clearTimeout(_wifiCredentialsTimeout); _wifiCredentialsTimeout = null; }
  _wifiCredentials = credentials;
}
