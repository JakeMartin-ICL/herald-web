// ---- Log ----

function log(message, type = 'system') {
  const logEl = document.getElementById('log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}

// ---- Status ----

function setStatus(status) {
  state.connected = status === 'connected';
  const el = document.getElementById('connection-status');
  el.className = `status ${status}`;
  el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

// ---- Wake Lock ----

let wakeLock = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      log('Screen wake lock active', 'system');
      wakeLock.addEventListener('release', () => {
        log('Screen wake lock released', 'system');
      });
    } catch (err) {
      log(`Wake lock failed: ${err.message}`, 'error');
    }
  } else {
    log('Wake lock not supported on this device', 'error');
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// ---- Battery tip banner ----

function showBatteryTipIfNeeded() {
  if (localStorage.getItem('herald-battery-tip-dismissed')) return;
  document.getElementById('battery-tip-banner').style.display = 'flex';
}

function dismissBatteryTip() {
  localStorage.setItem('herald-battery-tip-dismissed', '1');
  document.getElementById('battery-tip-banner').style.display = 'none';
}

// ---- Silent audio keepalive ----

let silentAudioContext = null;

function initSilentAudio() {
  if (silentAudioContext) {
    if (silentAudioContext.state === 'suspended') silentAudioContext.resume();
    return;
  }
  try {
    silentAudioContext = new AudioContext();
    const gainNode = silentAudioContext.createGain();
    gainNode.gain.value = 0;
    const oscillator = silentAudioContext.createOscillator();
    oscillator.frequency.value = 0;
    oscillator.connect(gainNode);
    gainNode.connect(silentAudioContext.destination);
    oscillator.start();
    silentAudioContext.onstatechange = () => {
      if (state.gameActive && silentAudioContext.state === 'suspended') {
        silentAudioContext.resume();
      }
      renderGameControls();
    };
  } catch (err) {
    log(`Silent audio init failed: ${err.message}`, 'error');
  }
}

// ---- Init ----

function updateCardScale() {
  const scale = Math.min(2, Math.max(1, (window.innerWidth - 600) / 600 + 1));
  document.documentElement.style.setProperty('--card-scale', scale);
}

window.addEventListener('resize', updateCardScale);

async function init() {
  updateCardScale();
  localStorage.removeItem('herald-box-names');
  await loadFactions();
  fetchLatestFirmware();
  render();
  updateSetupUI();
  disableAllRfid();
}

async function loadFactions() {
  try {
    const res = await fetch('./factions.json');
    state.factions = await res.json();
    log('Factions loaded', 'system');
  } catch (e) {
    log('Warning: could not load factions.json — faction features disabled', 'error');
  }
}
