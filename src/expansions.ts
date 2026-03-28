import { state } from './state';
import { log } from './logger';
import type { Expansion } from './types';

export async function loadExpansions(): Promise<void> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}expansions.json`);
    state.expansions = await r.json() as Record<string, Expansion[]>;
  } catch {
    log('Warning: could not load expansions.json', 'error');
  }
}

/** Returns true if the given expansion is enabled for the game.
 *  Base game content is always enabled. If no explicit selection exists (key absent),
 *  all expansions are enabled. */
export function isExpansionEnabled(game: string, expansionId: string): boolean {
  if (expansionId === 'base') return true;
  const selected = state.selectedExpansions[game];
  if (!selected) return true;
  return selected.includes(expansionId);
}

function nonBaseExps(game: string): Expansion[] {
  return (state.expansions[game] ?? []).filter(e => e.id !== 'base');
}

function saveExpansionSelection(game: string, selected: string[]): void {
  const allNonBase = nonBaseExps(game).map(e => e.id);
  if (selected.length === allNonBase.length) {
    // All selected = same as default — remove the key
    const copy = { ...state.selectedExpansions };
    delete copy[game];
    state.selectedExpansions = copy;
  } else {
    state.selectedExpansions = { ...state.selectedExpansions, [game]: selected };
  }
  if (Object.keys(state.selectedExpansions).length === 0) {
    localStorage.removeItem('herald-expansions');
  } else {
    localStorage.setItem('herald-expansions', JSON.stringify(state.selectedExpansions));
  }
  updateExpansionBtn(game);
}

function updateExpansionBtn(game: string): void {
  const btn = document.getElementById('expansion-open-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const exps = nonBaseExps(game);
  const selected = state.selectedExpansions[game] ?? exps.map(e => e.id);
  if (selected.length === exps.length) {
    btn.textContent = 'All expansions';
  } else if (selected.length === 0) {
    btn.textContent = 'Base game only';
  } else {
    btn.textContent = exps.filter(e => selected.includes(e.id)).map(e => e.name).join(', ');
  }
}

/** Show/hide the expansion button row and update its label. */
export function renderExpansionUI(mode: string): void {
  const row = document.getElementById('expansion-row') as HTMLElement | null;
  if (!row) return;

  const game = mode === 'ti' ? 'ti' : mode === 'eclipse' ? 'eclipse' : null;
  const exps = game ? nonBaseExps(game) : null;

  row.style.display = (game && exps && exps.length > 0) ? 'flex' : 'none';
  if (game && exps && exps.length > 0) updateExpansionBtn(game);
}

export function openExpansionDialog(game: string): void {
  const overlay = document.getElementById('expansion-overlay') as HTMLElement;
  const container = document.getElementById('expansion-dialog-checkboxes') as HTMLElement;
  const exps = nonBaseExps(game);
  const selected = state.selectedExpansions[game] ?? exps.map(e => e.id);

  container.innerHTML = exps.map(e =>
    `<label class="expansion-cb-label">` +
    `<input type="checkbox" class="expansion-cb" data-game="${game}" data-id="${e.id}"${selected.includes(e.id) ? ' checked' : ''}>` +
    `${e.name}</label>`
  ).join('');

  container.querySelectorAll<HTMLInputElement>('.expansion-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const g = cb.dataset.game!;
      const allCbs = container.querySelectorAll<HTMLInputElement>(`.expansion-cb[data-game="${g}"]`);
      const newSelected = Array.from(allCbs).filter(c => c.checked).map(c => c.dataset.id!);
      saveExpansionSelection(g, newSelected);
    });
  });

  overlay.style.display = 'flex';
}

export function closeExpansionDialog(): void {
  (document.getElementById('expansion-overlay') as HTMLElement).style.display = 'none';
}
