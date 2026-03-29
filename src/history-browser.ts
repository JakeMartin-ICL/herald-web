import { loadGameLogIndex, loadGameLog, deleteGameLog } from './gamelog';
import { syncWithGist, deleteGameFromGist } from './gist';
import { loadGitHubConfig } from './github-config';
import type { GameLogIndexEntry } from './types';

let _modeFilter = '';
let _unlocked = false;

const MODE_LABELS: Record<string, string> = {
  clockwise: 'Clockwise', clockwise_pass: 'Clockwise w/ Passing',
  eclipse: 'Eclipse', ti: 'Twilight Imperium',
};

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

export async function openHistoryBrowser(): Promise<void> {
  const overlay = document.getElementById('history-browser-overlay') as HTMLElement;
  overlay.style.display = 'flex';
  renderHistoryBrowser();

  // Silently sync in background
  const config = loadGitHubConfig();
  if (config?.pat && config?.gist_id) {
    try {
      await syncWithGist(config);
      renderHistoryBrowser();
    } catch { /* silent fail — no internet or invalid config */ }
  }
}

export function closeHistoryBrowser(): void {
  _unlocked = false;
  (document.getElementById('history-browser-overlay') as HTMLElement).style.display = 'none';
}

async function deleteGame(filename: string): Promise<void> {
  deleteGameLog(filename);
  renderHistoryBrowser();

  const config = loadGitHubConfig();
  if (config?.pat && config?.gist_id) {
    try { await deleteGameFromGist(config, filename); }
    catch { /* silent fail */ }
  }
}

export function renderHistoryBrowser(): void {
  const index = loadGameLogIndex();

  // Populate mode filter
  const filterEl = document.getElementById('history-mode-filter') as HTMLSelectElement | null;
  if (filterEl) {
    const modes = [...new Set(index.map(e => e.game_mode))].sort();
    const prevVal = filterEl.value || _modeFilter;
    filterEl.innerHTML = `<option value="">All modes</option>` +
      modes.map(m => `<option value="${m}"${m === prevVal ? ' selected' : ''}>${modeLabel(m)}</option>`).join('');
    _modeFilter = filterEl.value;
  }

  // Update lock button
  const lockBtn = document.getElementById('history-lock-btn') as HTMLElement | null;
  if (lockBtn) {
    lockBtn.textContent = _unlocked ? '🔓' : '🔒';
    lockBtn.title = _unlocked ? 'Lock (hide delete buttons)' : 'Unlock to enable deletion';
  }

  const filtered: GameLogIndexEntry[] = _modeFilter
    ? index.filter(e => e.game_mode === _modeFilter)
    : index;

  const listEl = document.getElementById('history-list') as HTMLElement;
  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="history-empty">No games recorded yet</div>';
    return;
  }

  listEl.innerHTML = filtered.map(entry => {
    const d = new Date(entry.started_at * 1000);
    const dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const players = entry.player_names.join(', ');
    const deleteBtnHtml = _unlocked
      ? `<button class="history-delete-btn" data-filename="${entry.filename}" title="Delete game">🗑</button>`
      : '';
    return `<div class="history-entry" data-filename="${entry.filename}">
      <div class="history-entry-main">
        <div class="history-entry-meta">
          <span class="history-entry-date">${dateStr} ${timeStr}</span>
          <span class="history-entry-mode">${modeLabel(entry.game_mode)}</span>
        </div>
        <div class="history-entry-players">${players}</div>
      </div>
      ${deleteBtnHtml}
    </div>`;
  }).join('');

  listEl.querySelectorAll<HTMLElement>('.history-entry').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.history-delete-btn')) return;
      const filename = el.dataset.filename!;
      const logData = loadGameLog(filename);
      if (!logData) return;
      void import('./graphs').then(({ openGraphOverlayWithLog }) => openGraphOverlayWithLog(logData));
    });
  });

  listEl.querySelectorAll<HTMLElement>('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteGame(btn.dataset.filename!);
    });
  });
}

export function toggleHistoryLock(): void {
  _unlocked = !_unlocked;
  renderHistoryBrowser();
}
