import { state } from './state';
import { sendToBox } from './websockets';
import { activePlayerColor } from './leds';
import { getDisplayName } from './boxes';
import { log } from './logger';
import { render } from './render';

export function sendCountdown(hwid: string, durationMs: number): void {
  const box = state.boxes[hwid];
  if (!box || box.isVirtual) return;
  const color = activePlayerColor();
  const rainbow = state.activePlayerStyle.rainbow;
  const endMs = Date.now() + durationMs;
  box.countdownActive = true;
  box.countdownEndMs = endMs;
  sendToBox(hwid, { type: 'countdown', durationMs, color, rainbow });
  log(`Countdown ${Math.round(durationMs / 1000)}s started for ${getDisplayName(hwid)}`, 'system');
  render();
  // Clear countdown state once it expires so syncLeds resumes normal control
  setTimeout(() => {
    if (state.boxes[hwid]?.countdownActive && state.boxes[hwid].countdownEndMs === endMs) {
      state.boxes[hwid].countdownActive = false;
      state.boxes[hwid].countdownEndMs = undefined;
      render();
    }
  }, durationMs + 500);
}

export function cancelCountdown(hwid: string): void {
  const box = state.boxes[hwid];
  if (!box) return;
  box.countdownActive = false;
  box.countdownEndMs = undefined;
  if (!box.isVirtual) sendToBox(hwid, { type: 'countdown', durationMs: 0, color: '#000000' });
  log(`Countdown cancelled for ${getDisplayName(hwid)}`, 'system');
  render();
}

// ---- Countdown popup ----

let countdownPopupHwid: string | null = null;

export function openCountdownPopup(hwid: string): void {
  countdownPopupHwid = hwid;
  const box = state.boxes[hwid];
  const cancelBtn = document.getElementById('countdown-cancel-btn') as HTMLElement | null;
  if (cancelBtn) cancelBtn.style.display = box?.countdownActive ? '' : 'none';
  (document.getElementById('countdown-overlay') as HTMLElement).style.display = 'flex';
}

export function closeCountdownPopup(): void {
  (document.getElementById('countdown-overlay') as HTMLElement).style.display = 'none';
  countdownPopupHwid = null;
}

export function countdownChoiceClick(durationMs: number): void {
  if (!countdownPopupHwid) return;
  const hwid = countdownPopupHwid;
  closeCountdownPopup();
  sendCountdown(hwid, durationMs);
}

export function countdownCustomClick(): void {
  const input = document.getElementById('countdown-custom-input') as HTMLInputElement;
  const secs = parseInt(input.value, 10);
  if (!secs || secs <= 0 || !countdownPopupHwid) return;
  const hwid = countdownPopupHwid;
  closeCountdownPopup();
  sendCountdown(hwid, secs * 1000);
}

export function countdownCancelClick(): void {
  if (!countdownPopupHwid) return;
  cancelCountdown(countdownPopupHwid);
  closeCountdownPopup();
}
