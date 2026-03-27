import { state } from './state';
import { getDisplayName } from './boxes';
import { currentGame } from './currentGame';
import { snapshotForUndo } from './undo';
import { syncLeds } from './leds';
import { syncDisplay } from './display';
import { persistState } from './persist';
import { log } from './logger';
import { render } from './render';

export function openRemovePlayerDialog(): void {
  (document.getElementById('remove-player-overlay') as HTMLElement).style.display = 'flex';
  renderRemovePlayerDialog();
}

export function closeRemovePlayerDialog(): void {
  (document.getElementById('remove-player-overlay') as HTMLElement).style.display = 'none';
}

function renderRemovePlayerDialog(): void {
  const el = document.getElementById('remove-player-content');
  if (!el) return;

  if (!state.gameActive) {
    el.innerHTML = '<div style="color:#888">No game in progress</div>';
    return;
  }

  const players = state.boxOrder.filter(hwid => {
    const box = state.boxes[hwid];
    return box && !box.isVirtual && box.status !== 'disconnected';
  });

  if (players.length === 0) {
    el.innerHTML = '<div style="color:#888">No active players</div>';
    return;
  }

  el.innerHTML = players.map(hwid =>
    `<div class="rp-row">
      <span class="rp-name">${getDisplayName(hwid)}</span>
      <button class="rp-remove-btn" data-hwid="${hwid}">Remove</button>
    </div>`
  ).join('');

  el.querySelectorAll<HTMLButtonElement>('.rp-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      removePlayer(btn.dataset.hwid!);
      renderRemovePlayerDialog();
    });
  });
}

export function removePlayer(hwid: string): void {
  if (!state.boxes[hwid]) return;

  snapshotForUndo();
  log(`${getDisplayName(hwid)} removed from game`, 'system');

  // Mark disconnected so all game-mode iteration naturally skips this player
  state.boxes[hwid].status = 'disconnected';

  // Game-mode-specific handling: order arrays, turn advancement, etc.
  currentGame?.onPlayerRemoved?.(hwid);

  // Remove from display order (hides the card; box object kept for stats)
  state.boxOrder = state.boxOrder.filter(id => id !== hwid);

  // Safety net in case game mode didn't clear activeBoxId
  if (state.activeBoxId === hwid) state.activeBoxId = null;

  syncLeds();
  syncDisplay();
  render();
  persistState();
}
