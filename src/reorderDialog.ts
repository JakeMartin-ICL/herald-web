import { state } from './state';
import { getDisplayName } from './boxes';
import { currentGame } from './currentGame';
import { snapshotForUndo } from './undo';
import { cancelCurrentTurn } from './timers';
import { syncLeds } from './leds';
import { syncDisplay } from './display';
import { persistState } from './persist';
import { render } from './render';

let pendingOrder: string[] = [];
let dragSrcIdx: number | null = null;

export function openReorderDialog(): void {
  if (!currentGame) return;
  pendingOrder = [...currentGame.turnOrder];
  (document.getElementById('reorder-overlay') as HTMLElement).style.display = 'flex';
  renderReorderDialog();
}

export function closeReorderDialog(): void {
  (document.getElementById('reorder-overlay') as HTMLElement).style.display = 'none';
}

function renderReorderDialog(): void {
  const el = document.getElementById('reorder-list');
  if (!el) return;

  el.innerHTML = pendingOrder.map((hwid, idx) => {
    const box = state.boxes[hwid];
    const status = box?.status ?? 'disconnected';
    const isActive = hwid === state.activeBoxId;
    const isPassed = status === 'passed';
    const isDisconnected = status === 'disconnected';
    const canActivate = state.activeBoxId !== null && !isActive && !isPassed && !isDisconnected;

    let rowClass = 'ro-row';
    if (isActive) rowClass += ' ro-active';
    if (isPassed || isDisconnected) rowClass += ' ro-dim';

    return `<div class="${rowClass}" draggable="true" data-idx="${idx}" data-hwid="${hwid}">
      <span class="ro-handle">≡</span>
      <span class="ro-name">${getDisplayName(hwid)}${isActive ? ' ●' : isPassed ? ' (passed)' : ''}</span>
      ${canActivate
        ? `<button class="ro-activate-btn" data-hwid="${hwid}">Activate</button>`
        : '<span class="ro-activate-placeholder"></span>'}
    </div>`;
  }).join('');

  // Drag-and-drop: insert-before semantics
  el.querySelectorAll<HTMLElement>('.ro-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      dragSrcIdx = Number(row.dataset.idx);
      e.dataTransfer!.effectAllowed = 'move';
      row.classList.add('ro-dragging');
    });

    row.addEventListener('dragend', () => {
      dragSrcIdx = null;
      el.querySelectorAll('.ro-row').forEach(r => r.classList.remove('ro-dragging', 'ro-drag-over'));
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      el.querySelectorAll('.ro-row').forEach(r => r.classList.remove('ro-drag-over'));
      if (dragSrcIdx !== Number(row.dataset.idx)) row.classList.add('ro-drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('ro-drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIdx = Number(row.dataset.idx);
      if (dragSrcIdx !== null && dragSrcIdx !== targetIdx) {
        const [item] = pendingOrder.splice(dragSrcIdx, 1);
        pendingOrder.splice(targetIdx, 0, item);
        dragSrcIdx = null;
        renderReorderDialog();
      }
    });
  });

  // Activate buttons
  el.querySelectorAll<HTMLButtonElement>('.ro-activate-btn').forEach(btn => {
    btn.addEventListener('click', () => applyActivate(btn.dataset.hwid!));
  });
}

function applyContinue(): void {
  if (!currentGame) return;
  snapshotForUndo();
  currentGame.turnOrder = [...pendingOrder];
  syncLeds();
  syncDisplay();
  render();
  persistState();
  closeReorderDialog();
}

function applyActivate(hwid: string): void {
  if (!currentGame) return;
  snapshotForUndo();
  cancelCurrentTurn(); // discard in-progress turn timing without recording it
  currentGame.turnOrder = [...pendingOrder];
  currentGame.activatePlayer?.(hwid);
  syncLeds();
  syncDisplay();
  render();
  persistState();
  closeReorderDialog();
}

export function initReorderDialogButtons(): void {
  document.getElementById('reorder-continue-btn')?.addEventListener('click', applyContinue);
  document.getElementById('reorder-cancel-btn')?.addEventListener('click', closeReorderDialog);
}
