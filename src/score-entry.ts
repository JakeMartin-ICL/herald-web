import { buildGameLog, saveGameLog, loadGameLogIndex } from './gamelog';
import { loadGitHubConfig } from './github-config';
import { syncWithGist } from './gist';
import { log } from './logger';
import { openScoresheet } from './scoresheet';
import { currentGame } from './currentGame';
import { getFactionForBox } from './boxes';
import { MODE_NAMES } from './modes/index';
import type { GameLog, ScoreBreakdown } from './types';

let _pendingLog: GameLog | null = null;
let _finalize: (() => void) | null = null;
let _breakdown: ScoreBreakdown | null = null;


export function openScoreEntryDialog(finalizeEndGame: () => void): void {
  if (_pendingLog) return;
  _pendingLog = buildGameLog();
  _finalize = finalizeEndGame;
  _breakdown = null;

  const overlay = document.getElementById('score-entry-overlay') as HTMLElement;
  const content = document.getElementById('score-entry-content') as HTMLElement;

  // Game label + datalist
  const labelInput = document.getElementById('score-game-input') as HTMLInputElement;
  const datalist = document.getElementById('score-game-datalist') as HTMLDataListElement;
  const defaultLabel = MODE_NAMES[_pendingLog.game_mode] ?? _pendingLog.game_mode;
  labelInput.value = defaultLabel;
  const seen = new Set<string>([defaultLabel]);
  const options: string[] = [defaultLabel];
  for (const entry of loadGameLogIndex()) {
    const label = MODE_NAMES[entry.game_mode] ?? entry.game_mode;
    if (!seen.has(label)) { seen.add(label); options.push(label); }
  }
  datalist.innerHTML = options.map(o => `<option value="${o}">`).join('');

  const hwids = Object.keys(_pendingLog.players);
  content.innerHTML = hwids.map(hwid =>
    `<div class="score-row">
      <span class="score-name">${_pendingLog!.players[hwid]}</span>
      <input type="number" class="score-input" data-hwid="${hwid}" min="0" max="9999" placeholder="—" inputmode="numeric">
    </div>`
  ).join('');

  overlay.style.display = 'flex';
  labelInput.select();
}

export function cancelScoreEntry(): void {
  _pendingLog = null;
  _finalize = null;
  _breakdown = null;
  (document.getElementById('score-entry-overlay') as HTMLElement).style.display = 'none';
}

export function openScoresheetFromScoreEntry(): void {
  if (!_pendingLog) return;
  const players = Object.entries(_pendingLog.players).map(([hwid, name]) => {
    const faction = getFactionForBox(hwid);
    const fn = faction?.nickname ?? faction?.name;
    return { hwid, name, factionName: fn && fn !== name ? fn : undefined };
  });
  const defaultCats = currentGame?.scoreBreakdownCategories
    ? [...currentGame.scoreBreakdownCategories]
    : [];
  const categories = _breakdown?.categories ?? defaultCats;
  const values = _breakdown?.values ?? {};

  openScoresheet(players, categories, values, false, (result) => {
    if (!result || !_pendingLog) return;
    _breakdown = result;
    // Write totals back into the score inputs
    for (const { hwid } of players) {
      const total = result.categories.reduce((s, cat) => {
        const v = result.values[hwid]?.[cat] ?? null;
        return s + (v ?? 0);
      }, 0);
      const hasAny = result.categories.some(c => (result.values[hwid]?.[c] ?? null) !== null);
      const input = document.querySelector<HTMLInputElement>(`.score-input[data-hwid="${hwid}"]`);
      if (input) input.value = hasAny ? String(total) : '';
    }
  });
}

function collectScores(): void {
  if (!_pendingLog) return;
  document.querySelectorAll<HTMLInputElement>('.score-input[data-hwid]').forEach(input => {
    const v = input.value.trim();
    _pendingLog!.scores[input.dataset.hwid!] = v !== '' ? parseFloat(v) : null;
  });
}

function collectGameLabel(): void {
  if (!_pendingLog) return;
  const label = (document.getElementById('score-game-input') as HTMLInputElement | null)?.value.trim();
  if (label) _pendingLog.game_mode = label;
}

export function confirmScoreEntry(): void {
  collectScores();
  collectGameLabel();
  finish();
}

export function skipScoreEntry(): void {
  collectGameLabel();
  finish();
}

function finish(): void {
  const gameLog = _pendingLog;
  const finalize = _finalize;
  const breakdown = _breakdown;
  _pendingLog = null;
  _finalize = null;
  _breakdown = null;
  (document.getElementById('score-entry-overlay') as HTMLElement).style.display = 'none';
  finalize?.();
  if (gameLog) {
    if (breakdown) gameLog.score_breakdown = breakdown;
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
