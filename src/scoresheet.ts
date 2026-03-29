import type { ScoreBreakdown } from './types';

export interface ScoresheetPlayer { hwid: string; name: string; factionName?: string }
type CloseCallback = (result: ScoreBreakdown | null) => void;

let _players: ScoresheetPlayer[] = [];
let _categories: string[] = [];
let _values: Record<string, Record<string, number | null>> = {};
let _readOnly = false;
let _onClose: CloseCallback | null = null;

export function openScoresheet(
  players: ScoresheetPlayer[],
  categories: string[],
  values: Record<string, Record<string, number | null>> = {},
  readOnly = false,
  onClose?: CloseCallback,
): void {
  _players = players;
  _categories = [...categories];
  _values = {};
  for (const { hwid } of players) _values[hwid] = { ...(values[hwid] ?? {}) };
  _readOnly = readOnly;
  _onClose = onClose ?? null;
  (document.getElementById('scoresheet-overlay') as HTMLElement).style.display = 'flex';
  renderScoresheet();
}

function hide(): void {
  (document.getElementById('scoresheet-overlay') as HTMLElement).style.display = 'none';
}

function finish(cancelled: boolean): void {
  if (!_readOnly && !cancelled) collectValues();
  const result = cancelled ? null : { categories: [..._categories], values: copyValues() };
  hide();
  const cb = _onClose;
  _onClose = null;
  cb?.(result);
}

export function closeScoresheetDone(): void  { finish(false); }
export function closeScoresheetCancel(): void { finish(true); }

function copyValues(): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {};
  for (const k of Object.keys(_values)) out[k] = { ..._values[k] };
  return out;
}

function collectValues(): void {
  document.querySelectorAll<HTMLInputElement>('.ss-cell-input').forEach(inp => {
    const { hwid, cat } = inp.dataset as { hwid: string; cat: string };
    if (!_values[hwid]) _values[hwid] = {};
    const raw = inp.value.trim();
    _values[hwid][cat] = raw !== '' ? parseFloat(raw) : null;
  });
}

function computeTotal(hwid: string): number | null {
  if (_categories.length === 0) return null;
  const vals = _categories.map(c => _values[hwid]?.[c] ?? null);
  if (!vals.some(v => v !== null)) return null;
  return vals.reduce<number>((s, v) => s + (v ?? 0), 0);
}

function fmt(v: number | null): string {
  if (v === null) return '';
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function renderScoresheet(): void {
  const el = document.getElementById('scoresheet-content') as HTMLElement;
  const footer = document.getElementById('scoresheet-footer') as HTMLElement;

  footer.innerHTML = _readOnly
    ? `<button id="ss-done-btn">Close</button>`
    : `<div style="display:flex;gap:0.5rem;width:100%">
         <button id="ss-cancel-btn" style="flex:1;background:#1a1a3e;color:#aaa">Cancel</button>
         <button id="ss-done-btn" style="flex:1">Done</button>
       </div>`;
  document.getElementById('ss-done-btn')?.addEventListener('click', closeScoresheetDone);
  document.getElementById('ss-cancel-btn')?.addEventListener('click', closeScoresheetCancel);

  // colgroup — widths assigned later by applyScoresheetLayout
  const cols = `<col class="ss-col-cat">${_players.map(() => `<col class="ss-col-player">`).join('')}`;

  // Header row: empty corner + one column per player
  const playerHeaders = _players.map(p => {
    const faction = (p.factionName && p.factionName !== p.name)
      ? `<div class="ss-player-faction">${esc(p.factionName)}</div>` : '';
    return `<th class="ss-th ss-th-player"><div class="ss-player-name">${esc(p.name)}</div>${faction}</th>`;
  }).join('');

  // One row per category
  const catRows = _categories.map(cat => {
    const rmBtn = _readOnly ? '' :
      `<button class="ss-rm-cat" data-cat="${escAttr(cat)}" title="Remove">×</button>`;
    const cells = _players.map(({ hwid }) => {
      const v = _values[hwid]?.[cat] ?? null;
      return _readOnly
        ? `<td class="ss-td ss-val">${fmt(v) || '—'}</td>`
        : `<td class="ss-td ss-val"><input type="number" step="any" class="ss-cell-input"
             data-hwid="${escAttr(hwid)}" data-cat="${escAttr(cat)}" value="${fmt(v)}"></td>`;
    }).join('');
    return `<tr><th class="ss-th ss-th-cat">${esc(cat)}${rmBtn}</th>${cells}</tr>`;
  }).join('');

  // Total row
  const totalCells = _players.map(({ hwid }) => {
    const tot = computeTotal(hwid);
    return `<td class="ss-td ss-total-cell" data-hwid="${escAttr(hwid)}">${tot !== null ? fmt(tot) : '—'}</td>`;
  }).join('');

  const addRow = _readOnly ? '' :
    `<tr class="ss-add-row">
       <td colspan="${_players.length + 1}">
         <div class="ss-add-wrap">
           <input type="text" id="ss-new-cat" class="ss-new-cat-input" placeholder="Add category…">
           <button id="ss-add-cat-btn">Add</button>
         </div>
       </td>
     </tr>`;

  el.innerHTML = `<div class="ss-scroll-wrap"><table class="ss-table">
    <colgroup>${cols}</colgroup>
    <thead><tr>
      <th class="ss-th ss-th-cat-label"></th>
      ${playerHeaders}
    </tr></thead>
    <tbody>
      ${catRows}
      <tr class="ss-total-row">
        <th class="ss-th ss-th-cat ss-total-label">Total</th>
        ${totalCells}
      </tr>
      ${addRow}
    </tbody>
  </table></div>`;

  wireEvents(el);
  requestAnimationFrame(applyScoresheetLayout);
}

function wireEvents(el: HTMLElement): void {
  if (_readOnly) return;

  el.querySelectorAll<HTMLInputElement>('.ss-cell-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const { hwid, cat } = inp.dataset as { hwid: string; cat: string };
      if (!_values[hwid]) _values[hwid] = {};
      const raw = inp.value.trim();
      _values[hwid][cat] = raw !== '' ? parseFloat(raw) : null;
      const totalCell = el.querySelector<HTMLElement>(`.ss-total-cell[data-hwid="${hwid}"]`);
      if (totalCell) {
        const tot = computeTotal(hwid);
        totalCell.textContent = tot !== null ? fmt(tot) : '—';
      }
    });
  });

  el.querySelectorAll<HTMLElement>('.ss-rm-cat').forEach(btn => {
    btn.addEventListener('click', () => {
      collectValues();
      _categories = _categories.filter(c => c !== btn.dataset.cat);
      renderScoresheet();
    });
  });

  const addInput = document.getElementById('ss-new-cat') as HTMLInputElement | null;
  const addBtn = document.getElementById('ss-add-cat-btn');
  const doAdd = () => {
    const name = addInput?.value.trim() ?? '';
    if (!name || _categories.includes(name)) { if (addInput) addInput.value = ''; return; }
    collectValues();
    _categories.push(name);
    renderScoresheet();
    el.querySelector<HTMLInputElement>(`.ss-cell-input[data-cat="${name}"]`)?.focus();
  };
  addBtn?.addEventListener('click', doAdd);
  addInput?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') doAdd(); });
}

function applyScoresheetLayout(): void {
  const dialog = document.getElementById('scoresheet-dialog');
  const wrap = document.querySelector<HTMLElement>('.ss-scroll-wrap');
  if (!dialog || !wrap || _players.length === 0) return;

  const thead = wrap.querySelector<HTMLElement>('thead');
  if (!thead) return;

  const availW = wrap.clientWidth;
  const availH = wrap.clientHeight;
  const headerH = thead.offsetHeight;

  // Category name column: proportional to available width, bounded
  const catColW = Math.max(80, Math.min(180, Math.round(availW * 0.18)));
  // Player columns: fill remaining width exactly — guarantees no horizontal scroll
  const playerColW = Math.max(40, Math.floor((availW - catColW) / _players.length));

  const catCol = wrap.querySelector<HTMLElement>('.ss-col-cat');
  if (catCol) catCol.style.width = `${catColW}px`;
  wrap.querySelectorAll<HTMLElement>('.ss-col-player').forEach(col => {
    col.style.width = `${playerColW}px`;
  });

  // Row height: fill available vertical space
  const nDataRows = _categories.length + 1 + (_readOnly ? 0 : 1); // cats + total + add-row
  const rowH = Math.max(28, Math.min(100, Math.floor((availH - headerH) / nDataRows)));

  // Font: constrained by both column width and row height
  const fontFromCol = playerColW / 4.0;
  const fontFromRow = rowH / 2.0;
  const fontPx = Math.max(11, Math.min(26, Math.min(fontFromCol, fontFromRow)));

  dialog.style.setProperty('--ss-row-h', `${rowH}px`);
  dialog.style.setProperty('--ss-font', `${(fontPx / 16).toFixed(2)}rem`);
}
