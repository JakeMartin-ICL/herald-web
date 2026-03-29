import { buildGameLog, saveGameLog } from './gamelog';
import { loadGitHubConfig } from './github-config';
import { syncWithGist } from './gist';
import { log } from './logger';
import type { GameLog } from './types';

let _pendingLog: GameLog | null = null;
let _finalize: (() => void) | null = null;

/** Build the game log snapshot and show the score entry dialog.
 *  finalizeEndGame must be the render.ts finalizeEndGame function — it is called
 *  after the user confirms/skips, so game state is still valid when this is called. */
export function openScoreEntryDialog(finalizeEndGame: () => void): void {
  if (_pendingLog) return; // already open
  _pendingLog = buildGameLog();
  _finalize = finalizeEndGame;

  const overlay = document.getElementById('score-entry-overlay') as HTMLElement;
  const content = document.getElementById('score-entry-content') as HTMLElement;

  const hwids = Object.keys(_pendingLog.players);
  content.innerHTML = hwids.map(hwid =>
    `<div class="score-row">
      <span class="score-name">${_pendingLog!.players[hwid]}</span>
      <input type="number" class="score-input" data-hwid="${hwid}" min="0" max="9999" placeholder="—" inputmode="numeric">
    </div>`
  ).join('');

  overlay.style.display = 'flex';
  content.querySelector<HTMLInputElement>('.score-input')?.focus();
}

/** Close dialog and discard — game remains active. */
export function cancelScoreEntry(): void {
  _pendingLog = null;
  _finalize = null;
  (document.getElementById('score-entry-overlay') as HTMLElement).style.display = 'none';
}

function collectScores(): void {
  if (!_pendingLog) return;
  document.querySelectorAll<HTMLInputElement>('.score-input[data-hwid]').forEach(input => {
    const v = input.value.trim();
    _pendingLog!.scores[input.dataset.hwid!] = v !== '' ? parseInt(v, 10) : null;
  });
}

export function confirmScoreEntry(): void {
  collectScores();
  finish();
}

export function skipScoreEntry(): void {
  finish(); // scores stay null
}

function finish(): void {
  const gameLog = _pendingLog;
  const finalize = _finalize;
  _pendingLog = null;
  _finalize = null;
  (document.getElementById('score-entry-overlay') as HTMLElement).style.display = 'none';
  finalize?.();
  if (gameLog) {
    saveGameLog(gameLog);
    void autoSync();
  }
}

async function autoSync(): Promise<void> {
  const config = loadGitHubConfig();
  if (!config) return;
  try {
    await syncWithGist(config);
  } catch (e) {
    log(`Auto-sync failed: ${(e as Error).message}`, 'error');
  }
}
