import { state } from './state';
import { log } from './logger';
import { disableAllRfid } from './websockets';
import { render } from './render';
import { updateSetupUI } from './boxes';
import { loadTags } from './tags';
import { loadExpansions } from './expansions';
import { fetchLatestFirmware } from './firmware';
import { offerResume } from './persist';
import { setWakeLockHandlers, updateSilentAudioContext } from './render';

// ---- Wake Lock ----

let wakeLock: WakeLockSentinel | null = null;

export async function requestWakeLock(): Promise<void> {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await (navigator as Navigator & { wakeLock: { request(type: string): Promise<WakeLockSentinel> } }).wakeLock.request('screen');
      log('Screen wake lock active', 'system');
      wakeLock.addEventListener('release', () => {
        log('Screen wake lock released', 'system');
      });
    } catch (err) {
      log(`Wake lock failed: ${(err as Error).message}`, 'error');
    }
  } else {
    log('Wake lock not supported on this device', 'error');
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    void requestWakeLock();
  }
});

// ---- Battery tip banner ----

export function showBatteryTipIfNeeded(): void {
  if (localStorage.getItem('herald-battery-tip-dismissed')) return;
  (document.getElementById('battery-tip-banner') as HTMLElement).style.display = 'flex';
}

export function dismissBatteryTip(): void {
  localStorage.setItem('herald-battery-tip-dismissed', '1');
  (document.getElementById('battery-tip-banner') as HTMLElement).style.display = 'none';
}

// ---- Silent audio keepalive ----

let silentAudioContext: AudioContext | null = null;

export function initSilentAudio(): void {
  if (silentAudioContext) {
    if (silentAudioContext.state === 'suspended') void silentAudioContext.resume();
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
      if (state.gameActive && silentAudioContext!.state === 'suspended') {
        void silentAudioContext!.resume();
      }
      updateSilentAudioContext(silentAudioContext);
    };
    updateSilentAudioContext(silentAudioContext);
  } catch (err) {
    log(`Silent audio init failed: ${(err as Error).message}`, 'error');
  }
}

// ---- Card scale ----

function updateCardScale(): void {
  const scale = Math.min(2, Math.max(1, (window.innerWidth - 600) / 600 + 1));
  document.documentElement.style.setProperty('--card-scale', String(scale));
}

window.addEventListener('resize', updateCardScale);

// ---- Init ----

async function loadFactions(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}factions.json`);
    state.factions = await res.json() as typeof state.factions;
    log('Factions loaded', 'system');
  } catch {
    log('Warning: could not load factions.json — faction features disabled', 'error');
  }
}

function checkLocalBackup(): void {
  try {
    const raw = localStorage.getItem('herald-game-state');
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if ((parsed as { gameActive?: boolean })?.gameActive) offerResume(parsed);
  } catch {
    localStorage.removeItem('herald-game-state');
  }
}

export async function init(): Promise<void> {
  updateCardScale();
  localStorage.removeItem('herald-box-names');
  setWakeLockHandlers(() => { void releaseWakeLock(); }, null);
  await loadFactions();
  void loadTags();
  void loadExpansions().then(() => updateSetupUI());
  void fetchLatestFirmware();
  render();
  updateSetupUI();
  disableAllRfid();
  checkLocalBackup();
}
