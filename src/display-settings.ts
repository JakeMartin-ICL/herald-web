import { state } from './state';
import { getDisplayName } from './boxes';
import { syncDisplay } from './display';
import { sendRfidPrompt } from './websockets';
import { setBrightness } from './leds';
import { renderBoxes } from './render';
import type { DisplayBoxSettings } from './types';

function getSettings(hwid: string): DisplayBoxSettings {
  return state.displaySettings[hwid] ?? { showRound: false, showTimer: false, message: '' };
}

function setSettings(hwid: string, patch: Partial<DisplayBoxSettings>): void {
  state.displaySettings[hwid] = { ...getSettings(hwid), ...patch };
}

function getBrightness(hwid: string): number {
  return state.boxBrightness[hwid] ?? 255;
}

function brightnessLabel(v: number): string {
  return `${Math.max(1, Math.round(v / 255 * 100))}%`;
}

let highlightHwid: string | null = null;

export function openDisplaySettingsDialog(): void {
  highlightHwid = null;
  (document.getElementById('display-settings-overlay') as HTMLElement).style.display = 'flex';
  renderDisplaySettingsDialog();
}

export function openDisplaySettingsDialogForBox(hwid: string): void {
  highlightHwid = hwid;
  (document.getElementById('display-settings-overlay') as HTMLElement).style.display = 'flex';
  renderDisplaySettingsDialog();
}

export function closeDisplaySettingsDialog(): void {
  highlightHwid = null;
  (document.getElementById('display-settings-overlay') as HTMLElement).style.display = 'none';
}

export function renderDisplaySettingsDialog(): void {
  const overlay = document.getElementById('display-settings-overlay') as HTMLElement;
  const el = document.getElementById('display-settings-content');
  if (!el || overlay.style.display === 'none') return;

  const boxes = state.boxOrder.filter(hwid => {
    const box = state.boxes[hwid];
    return box && !box.isVirtual && box.status !== 'disconnected';
  });

  if (boxes.length === 0) {
    el.innerHTML = '<div style="color:#888; padding:0.5rem 0">No boxes connected</div>';
    return;
  }

  const allRoundOn = boxes.every(hwid => getSettings(hwid).showRound);
  const allTimerOn = boxes.every(hwid => getSettings(hwid).showTimer);
  const allRfidOn  = boxes.every(hwid => !!state.boxes[hwid]?.rfidPromptOn);
  const firstBright = getBrightness(boxes[0]);

  const brightnessSlider = (hwid: string | null, extraClass = '') => {
    const val = hwid ? getBrightness(hwid) : firstBright;
    const dataAttr = hwid ? `data-hwid="${hwid}"` : 'data-all-bright="true"';
    return `<div class="ds-bright-row${extraClass}">
      <input type="range" class="ds-bright-slider" min="1" max="255" value="${val}" ${dataAttr}>
      <span class="ds-bright-label">${brightnessLabel(val)}</span>
    </div>`;
  };

  el.innerHTML = `
    <div class="ds-grid">
      <span class="ds-col-header"></span>
      <span class="ds-col-header">Round</span>
      <span class="ds-col-header">Timer</span>
      <span class="ds-col-header">RFID guide</span>
      <span class="ds-col-header">Message</span>
      <span class="ds-col-header">Brightness</span>

      <span class="ds-row-label" style="color:#888">All boxes</span>
      <button class="ds-all-btn${allRoundOn ? ' ds-on' : ''}" data-field="showRound">${allRoundOn ? 'On' : 'Off'}</button>
      <button class="ds-all-btn${allTimerOn ? ' ds-on' : ''}" data-field="showTimer">${allTimerOn ? 'On' : 'Off'}</button>
      <button class="ds-all-rfid-btn ds-all-btn${allRfidOn ? ' ds-on' : ''}">${allRfidOn ? 'On' : 'Off'}</button>
      <input class="ds-all-message-input ds-message-input" type="text" maxlength="21" placeholder="Set all…">
      ${brightnessSlider(null)}

      ${boxes.map(hwid => {
        const s = getSettings(hwid);
        const box = state.boxes[hwid];
        const rfidOn = !!box?.rfidPromptOn;
        const hl = hwid === highlightHwid ? ' ds-row-highlighted' : '';
        return `
          <span class="ds-row-label${hl}" id="ds-row-${hwid}">${getDisplayName(hwid)}</span>
          <button class="ds-toggle${s.showRound ? ' ds-on' : ''}${hl}" data-hwid="${hwid}" data-field="showRound">${s.showRound ? 'On' : 'Off'}</button>
          <button class="ds-toggle${s.showTimer ? ' ds-on' : ''}${hl}" data-hwid="${hwid}" data-field="showTimer">${s.showTimer ? 'On' : 'Off'}</button>
          <button class="ds-toggle ds-rfid-guide-btn${rfidOn ? ' ds-on' : ''}${hl}" data-hwid="${hwid}">${rfidOn ? 'On' : 'Off'}</button>
          <input class="ds-message-input${hl}" type="text" maxlength="21" placeholder="—" data-hwid="${hwid}" value="${(s.message ?? '').replace(/"/g, '&quot;')}">
          ${brightnessSlider(hwid, hl)}`;
      }).join('')}
    </div>`;

  el.querySelectorAll<HTMLButtonElement>('.ds-toggle[data-field]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hwid = btn.dataset.hwid!;
      const field = btn.dataset.field as keyof DisplayBoxSettings;
      setSettings(hwid, { [field]: !getSettings(hwid)[field] });
      syncDisplay();
      renderDisplaySettingsDialog();
    });
  });

  el.querySelectorAll<HTMLButtonElement>('.ds-all-btn[data-field]').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field as keyof DisplayBoxSettings;
      const turnOn = !boxes.every(hwid => getSettings(hwid)[field]);
      boxes.forEach(hwid => setSettings(hwid, { [field]: turnOn }));
      syncDisplay();
      renderDisplaySettingsDialog();
    });
  });

  el.querySelector<HTMLButtonElement>('.ds-all-rfid-btn')?.addEventListener('click', () => {
    const turnOn = !boxes.every(hwid => !!state.boxes[hwid]?.rfidPromptOn);
    boxes.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box) return;
      box.rfidPromptOn = turnOn;
      sendRfidPrompt(hwid, turnOn);
    });
    renderBoxes();
    renderDisplaySettingsDialog();
  });

  el.querySelectorAll<HTMLButtonElement>('.ds-rfid-guide-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const hwid = btn.dataset.hwid!;
      const box = state.boxes[hwid];
      if (!box) return;
      box.rfidPromptOn = !box.rfidPromptOn;
      sendRfidPrompt(hwid, box.rfidPromptOn);
      renderBoxes();
      renderDisplaySettingsDialog();
    });
  });

  // Per-box brightness sliders: update label live, send only on release
  el.querySelectorAll<HTMLInputElement>('.ds-bright-slider[data-hwid]').forEach(slider => {
    const label = slider.nextElementSibling as HTMLElement;
    slider.addEventListener('input', () => {
      label.textContent = brightnessLabel(Number(slider.value));
    });
    slider.addEventListener('change', () => {
      setBrightness(slider.dataset.hwid!, Number(slider.value));
      renderBoxes();
    });
  });

  // All-boxes brightness slider
  el.querySelectorAll<HTMLInputElement>('.ds-bright-slider[data-all-bright]').forEach(slider => {
    const label = slider.nextElementSibling as HTMLElement;
    slider.addEventListener('input', () => {
      label.textContent = brightnessLabel(Number(slider.value));
    });
    slider.addEventListener('change', () => {
      const brightness = Number(slider.value);
      boxes.forEach(hwid => setBrightness(hwid, brightness));
      renderBoxes();
      renderDisplaySettingsDialog();
    });
  });

  // Per-box message inputs
  el.querySelectorAll<HTMLInputElement>('.ds-message-input[data-hwid]').forEach(input => {
    input.addEventListener('change', () => {
      const hwid = input.dataset.hwid!;
      setSettings(hwid, { message: input.value });
      syncDisplay();
    });
  });

  // All-boxes message input
  el.querySelector<HTMLInputElement>('.ds-all-message-input')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLInputElement).value;
    boxes.forEach(hwid => setSettings(hwid, { message: val }));
    syncDisplay();
    renderDisplaySettingsDialog();
  });

  // Scroll highlighted row into view
  if (highlightHwid) {
    const rowEl = el.querySelector(`#ds-row-${highlightHwid}`) as HTMLElement | null;
    rowEl?.scrollIntoView({ block: 'nearest' });
  }
}
