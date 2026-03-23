import { state } from './state';
import { render } from './render';
import { resetActiveAnim } from './leds';
import type { ActivePlayerStyle } from './types';

const STORAGE_KEY = 'herald-active-style';

export function loadActiveStyle(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ActivePlayerStyle>;
    Object.assign(state.activePlayerStyle, parsed);
  } catch { /* ignore */ }
}

function saveActiveStyle(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.activePlayerStyle));
}

function applyStyle(): void {
  resetActiveAnim();
  saveActiveStyle();
  render();
}

// ---- Dialog rendering ----

function huePreview(hue: number | null, rainbow: boolean): string {
  if (rainbow) return 'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))';
  if (hue === null) return '#ffffff';
  return `hsl(${hue}, 100%, 50%)`;
}

function syncDialogState(): void {
  const s = state.activePlayerStyle;
  const overlay = document.getElementById('active-style-overlay');
  if (!overlay || overlay.style.display === 'none') return;

  // Mode buttons
  document.querySelectorAll<HTMLButtonElement>('.style-mode-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mode === s.mode);
  });

  // Speed section: only visible for animated modes
  const speedSection = document.getElementById('style-speed-section');
  if (speedSection) speedSection.style.display = s.mode === 'solid' ? 'none' : '';

  // Hue slider
  const hueSlider = document.getElementById('style-hue') as HTMLInputElement | null;
  if (hueSlider) {
    hueSlider.value = String(s.hue ?? 0);
    hueSlider.disabled = s.rainbow;
    hueSlider.style.opacity = s.rainbow ? '0.4' : '1';
  }

  // White button
  const whiteBtn = document.getElementById('style-white-btn');
  if (whiteBtn) whiteBtn.classList.toggle('selected', s.hue === null && !s.rainbow);

  // Rainbow checkbox
  const rainbowCb = document.getElementById('style-rainbow') as HTMLInputElement | null;
  if (rainbowCb) rainbowCb.checked = s.rainbow;

  // Swatch
  const swatch = document.getElementById('style-colour-swatch');
  if (swatch) {
    const preview = huePreview(s.hue, s.rainbow);
    if (preview.startsWith('linear')) {
      swatch.style.background = preview;
    } else {
      swatch.style.background = preview;
    }
  }

  // Speed slider
  const speedSlider = document.getElementById('style-speed') as HTMLInputElement | null;
  if (speedSlider) speedSlider.value = String(Math.round(s.speed * 100));
}

export function openActiveStyleDialog(): void {
  const overlay = document.getElementById('active-style-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  syncDialogState();
}

export function closeActiveStyleDialog(): void {
  const overlay = document.getElementById('active-style-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ---- Wire dialog controls (called from main.ts) ----

export function initActiveStyleDialog(): void {
  // Mode buttons
  document.querySelectorAll<HTMLButtonElement>('.style-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activePlayerStyle.mode = btn.dataset.mode as ActivePlayerStyle['mode'];
      syncDialogState();
      applyStyle();
    });
  });

  // White preset
  const whiteBtn = document.getElementById('style-white-btn');
  if (whiteBtn) {
    whiteBtn.addEventListener('click', () => {
      state.activePlayerStyle.hue = null;
      state.activePlayerStyle.rainbow = false;
      syncDialogState();
      applyStyle();
    });
  }

  // Hue slider
  const hueSlider = document.getElementById('style-hue') as HTMLInputElement | null;
  if (hueSlider) {
    hueSlider.addEventListener('input', () => {
      state.activePlayerStyle.hue = Number(hueSlider.value);
      state.activePlayerStyle.rainbow = false;
      syncDialogState();
      applyStyle();
    });
  }

  // Rainbow checkbox
  const rainbowCb = document.getElementById('style-rainbow') as HTMLInputElement | null;
  if (rainbowCb) {
    rainbowCb.addEventListener('change', () => {
      state.activePlayerStyle.rainbow = rainbowCb.checked;
      if (rainbowCb.checked) state.activePlayerStyle.hue = state.activePlayerStyle.hue ?? 0;
      syncDialogState();
      applyStyle();
    });
  }

  // Speed slider
  const speedSlider = document.getElementById('style-speed') as HTMLInputElement | null;
  if (speedSlider) {
    speedSlider.addEventListener('input', () => {
      state.activePlayerStyle.speed = Number(speedSlider.value) / 100;
      syncDialogState();
      applyStyle();
    });
  }

  // Close
  const closeBtn = document.getElementById('active-style-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeActiveStyleDialog);

  const overlay = document.getElementById('active-style-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeActiveStyleDialog();
    });
  }
}
