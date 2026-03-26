import { state } from './state';
import { getDisplayName } from './boxes';
import { syncDisplay } from './display';
import { sendRfidPrompt } from './websockets';
import { renderBoxes } from './render';
import type { DisplayBoxSettings } from './types';

function getSettings(hwid: string): DisplayBoxSettings {
  return state.displaySettings[hwid] ?? { showRound: false, showTimer: false };
}

function setSettings(hwid: string, patch: Partial<DisplayBoxSettings>): void {
  state.displaySettings[hwid] = { ...getSettings(hwid), ...patch };
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

  el.innerHTML = `
    <div class="ds-grid">
      <span class="ds-col-header"></span>
      <span class="ds-col-header">Round</span>
      <span class="ds-col-header">Timer</span>
      <span class="ds-col-header">RFID guide</span>

      <span class="ds-row-label" style="color:#888">All boxes</span>
      <button class="ds-all-btn${allRoundOn ? ' ds-on' : ''}" data-field="showRound">${allRoundOn ? 'On' : 'Off'}</button>
      <button class="ds-all-btn${allTimerOn ? ' ds-on' : ''}" data-field="showTimer">${allTimerOn ? 'On' : 'Off'}</button>
      <span></span>

      ${boxes.map(hwid => {
        const s = getSettings(hwid);
        const box = state.boxes[hwid];
        const rfidOn = !!box?.rfidPromptOn;
        const isHighlighted = hwid === highlightHwid;
        return `
          <span class="ds-row-label${isHighlighted ? ' ds-highlighted' : ''}" id="ds-row-${hwid}">${getDisplayName(hwid)}</span>
          <button class="ds-toggle${s.showRound ? ' ds-on' : ''}" data-hwid="${hwid}" data-field="showRound">${s.showRound ? 'On' : 'Off'}</button>
          <button class="ds-toggle${s.showTimer ? ' ds-on' : ''}" data-hwid="${hwid}" data-field="showTimer">${s.showTimer ? 'On' : 'Off'}</button>
          <button class="ds-toggle ds-rfid-guide-btn${rfidOn ? ' ds-on' : ''}" data-hwid="${hwid}">${rfidOn ? 'On' : 'Off'}</button>`;
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

  el.querySelectorAll<HTMLButtonElement>('.ds-all-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field as keyof DisplayBoxSettings;
      const turnOn = !boxes.every(hwid => getSettings(hwid)[field]);
      boxes.forEach(hwid => setSettings(hwid, { [field]: turnOn }));
      syncDisplay();
      renderDisplaySettingsDialog();
    });
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

  // Scroll highlighted row into view
  if (highlightHwid) {
    const rowEl = el.querySelector(`#ds-row-${highlightHwid}`) as HTMLElement | null;
    rowEl?.scrollIntoView({ block: 'nearest' });
  }
}
