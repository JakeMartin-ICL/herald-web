import { state } from './state';
import { formatDuration, getCurrentRound, timerSettings } from './timers';
import { getDisplayName } from './boxes';
import { getFactionForBox } from './modes/eclipse';
import type { GameLog, Faction, ScoreBreakdown } from './types';

const SORT_MODES  = ['table', 'name', 'faction', 'highest'] as const;
type SortMode = typeof SORT_MODES[number];
const SORT_LABELS: Record<SortMode, string> = {
  table: 'Table order', name: 'Name', faction: 'Faction', highest: 'Highest',
};

let graphType   = 'total';
let graphSort: SortMode = 'table';
let graphSource = 'live'; // 'live' | 'prev' | 'log'
let _graphInterval: ReturnType<typeof setInterval> | null = null;
let _logStats: GameStats | null = null;
let _logTitle = '';
let _logBreakdown: ScoreBreakdown | null = null;
let _logPlayers: { hwid: string; name: string }[] = [];

interface PlayerSnapshot {
  name: string;
  color: string;
  factionName: string;
  totalTurnTime: number;
  turnHistory: { duration: number; round: number | null }[];
  score?: number | null;
}

interface GameStats {
  gameMode: string;
  players: PlayerSnapshot[];
  totalGameTime: number | null;
  phaseLog: typeof state.phaseLog;
  playerCount: number;
}

export let prevGameStats: GameStats | null = null;

export function snapshotPlayer(id: string): PlayerSnapshot {
  const box = state.boxes[id];
  const faction = getFactionForBox(id);
  const inProgress = box.turnStartTime ? Date.now() - box.turnStartTime : 0;
  return {
    name: getDisplayName(id),
    color: faction?.color ?? '#c9a84c',
    factionName: faction?.nickname ?? faction?.name ?? '',
    totalTurnTime: (box.totalTurnTime ?? 0) + inProgress,
    turnHistory: [
      ...(box.turnHistory ?? []),
      ...(inProgress > 0 ? [{ duration: inProgress, round: getCurrentRound() }] : []),
    ],
  };
}

export function captureGameStats(): void {
  const phaseLog = [...state.phaseLog];
  if (state.currentPhaseStart) {
    phaseLog.push({
      phase: state.currentPhaseStart.name,
      duration: Date.now() - state.currentPhaseStart.startTime,
      round: state.round,
    });
  }
  prevGameStats = {
    gameMode: MODE_NAMES[state.gameMode] || state.gameMode,
    players: state.boxOrder.filter(id => state.boxes[id]).map(snapshotPlayer),
    totalGameTime: state.gameStartTime ? Date.now() - state.gameStartTime : null,
    phaseLog,
    playerCount: state.boxOrder.filter(id => state.boxes[id]).length,
  };
}

function getGraphPlayers(): PlayerSnapshot[] {
  if (graphSource === 'log' && _logStats) return _logStats.players;
  if (graphSource === 'prev' && prevGameStats) return prevGameStats.players;
  return state.boxOrder.filter(id => state.boxes[id]).map(snapshotPlayer);
}

function graphValueForPlayer(player: PlayerSnapshot): number {
  const hist = player.turnHistory;
  switch (graphType) {
    case 'total':   return player.totalTurnTime;
    case 'longest': return hist.length > 0 ? Math.max(...hist.map(t => t.duration)) : 0;
    case 'average': return hist.length > 0 ? Math.round(player.totalTurnTime / hist.length) : 0;
    case 'turns':   return hist.length;
    default:        return 0;
  }
}

function getSortedPlayers(): PlayerSnapshot[] {
  const players = getGraphPlayers();
  if (graphSort === 'name')    return [...players].sort((a, b) => a.name.localeCompare(b.name));
  if (graphSort === 'faction') return [...players].sort((a, b) => a.factionName.localeCompare(b.factionName));
  if (graphSort === 'highest') return [...players].sort((a, b) => graphValueForPlayer(b) - graphValueForPlayer(a));
  return players;
}

function getPhaseLog() {
  if (graphSource === 'log' && _logStats) return _logStats.phaseLog;
  if (graphSource === 'prev' && prevGameStats) return prevGameStats.phaseLog;
  const log = [...state.phaseLog];
  if (state.currentPhaseStart) {
    log.push({ phase: state.currentPhaseStart.name, duration: Date.now() - state.currentPhaseStart.startTime, round: state.round });
  }
  return log;
}

function getDistinctPhases(): string[] {
  const seen = new Set<string>();
  return getPhaseLog().filter(e => !seen.has(e.phase) && seen.add(e.phase)).map(e => e.phase);
}

function getPhaseRoundItems(phaseName: string) {
  return getPhaseLog()
    .filter(e => e.phase === phaseName)
    .sort((a, b) => (a.round || 0) - (b.round || 0))
    .map(e => ({ name: `Round ${e.round ?? '?'}`, color: '#c9a84c', value: e.duration }));
}

function getRoundItems() {
  const roundMap: Record<number, { total: number; count: number }> = {};
  getGraphPlayers().forEach(player => {
    player.turnHistory.forEach(({ duration, round }) => {
      if (round === null) return;
      if (!roundMap[round]) roundMap[round] = { total: 0, count: 0 };
      roundMap[round].total += duration;
      roundMap[round].count++;
    });
  });
  return Object.entries(roundMap)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([round, { total, count }]) => ({
      name: `Round ${round}`,
      color: '#c9a84c',
      value: count > 0 ? Math.round(total / count) : 0,
    }));
}

function axisName(p: PlayerSnapshot): string {
  if (p.factionName && p.factionName !== p.name) return `${p.name} – ${p.factionName}`;
  return p.name;
}

function getGraphItems() {
  if (graphType === 'by_round') return getRoundItems();
  if (graphType.startsWith('phase:')) return getPhaseRoundItems(graphType.slice(6));
  return getSortedPlayers().map(p => ({ name: axisName(p), color: p.color, value: graphValueForPlayer(p) }));
}

function formatGraphValue(value: number): string {
  if (graphType === 'turns') return value > 0 ? String(value) : '0';
  return value > 0 ? formatDuration(value) : '—';
}

function renderScores(): void {
  const el = document.getElementById('graph-content');
  if (!el) return;
  const players = [...getGraphPlayers()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const maxScore = Math.max(...players.map(p => p.score ?? 0), 1);
  el.innerHTML = players.map(p => {
    const score = p.score ?? null;
    const pct = score !== null ? (score / maxScore * 100).toFixed(1) : '0';
    const scoreStr = score !== null ? String(score) : '—';
    return `<div class="graph-row">
      <div class="graph-name" style="color:${p.color}">${axisName(p)}</div>
      <div class="graph-bar-wrap">
        ${score !== null ? `<div class="graph-bar" style="width:${pct}%;background:${p.color}66;border-right:2px solid ${p.color}"></div>` : ''}
      </div>
      <div class="graph-val">${scoreStr}</div>
    </div>`;
  }).join('');
  requestAnimationFrame(applyExpandedLayout);
}

function renderGraph(): void {
  const el = document.getElementById('graph-content');
  if (!el) return;
  if (graphType === 'stats') { renderStats(); return; }
  if (graphType === 'scores') { renderScores(); return; }
  const items  = getGraphItems();
  const maxVal = Math.max(...items.map(i => i.value), 1);
  el.innerHTML = items.map(item => {
    const pct = (item.value / maxVal * 100).toFixed(1);
    return `<div class="graph-row">
      <div class="graph-name" style="color:${item.color}">${item.name}</div>
      <div class="graph-bar-wrap">
        <div class="graph-bar" style="width:${pct}%;background:${item.color}66;border-right:2px solid ${item.color}"></div>
      </div>
      <div class="graph-val">${formatGraphValue(item.value)}</div>
    </div>`;
  }).join('');
  requestAnimationFrame(applyExpandedLayout);
}

function renderStats(): void {
  const el = document.getElementById('graph-content');
  if (!el) return;

  const activeStats =
    (graphSource === 'log' && _logStats) ? _logStats :
    (graphSource === 'prev' && prevGameStats) ? prevGameStats : null;
  const gameTime = activeStats
    ? activeStats.totalGameTime
    : (state.gameStartTime ? Date.now() - state.gameStartTime : null);
  const playerCount = activeStats
    ? activeStats.playerCount
    : state.boxOrder.filter(id => state.boxes[id]).length;

  const phaseLog = getPhaseLog();
  const players = getGraphPlayers();
  const allTurns = players.flatMap(p => p.turnHistory.map(t => t.duration));
  const overallAvg = allTurns.length > 0
    ? Math.round(allTurns.reduce((s, d) => s + d, 0) / allTurns.length) : null;

  const rows: { label: string; value: string }[] = [];

  if (gameTime !== null) {
    rows.push({ label: 'Total game time', value: formatDuration(gameTime) });
    if (playerCount > 0) {
      rows.push({ label: 'Game time per player', value: formatDuration(Math.round(gameTime / playerCount)) });
    }
  }

  rows.push({ label: 'Overall avg turn time', value: overallAvg !== null ? formatDuration(overallAvg) : '—' });

  if (phaseLog.length > 0) {
    const phaseTotals: Record<string, number> = {};
    const phaseOrder: string[] = [];
    phaseLog.forEach(({ phase, duration }) => {
      if (!phaseTotals[phase]) { phaseTotals[phase] = 0; phaseOrder.push(phase); }
      phaseTotals[phase] += duration;
    });
    phaseOrder.forEach(phase => {
      const label = phase.charAt(0).toUpperCase() + phase.slice(1);
      rows.push({ label: `Total ${label} time`, value: formatDuration(phaseTotals[phase]) });
    });
  }

  el.innerHTML = `<div class="stats-list">${rows.map(r =>
    `<div class="stats-row"><span class="stats-label">${r.label}</span><span class="stats-val">${r.value}</span></div>`
  ).join('')}</div>`;
  requestAnimationFrame(applyExpandedLayout);
}

function renderGraphOverlay(): void {
  const isLog = graphSource === 'log' && _logStats;
  const title = isLog ? _logTitle
    : (graphSource === 'prev' && prevGameStats ? `Previous game — ${prevGameStats.gameMode}` : 'Current game');
  (document.getElementById('graph-dialog-title') as HTMLElement).textContent = title;

  const select = document.getElementById('graph-type-select') as HTMLSelectElement;
  Array.from(select.options).filter(o => o.value.startsWith('phase:')).forEach(o => o.remove());

  // Add/remove 'Scores' option based on source
  const scoresOpt = Array.from(select.options).find(o => o.value === 'scores');
  if (isLog && !scoresOpt) {
    const opt = document.createElement('option');
    opt.value = 'scores';
    opt.textContent = 'Scores';
    select.appendChild(opt);
  } else if (!isLog && scoresOpt) {
    scoresOpt.remove();
  }

  const statsOpt = Array.from(select.options).find(o => o.value === 'stats');
  getDistinctPhases().forEach(phase => {
    const opt = document.createElement('option');
    opt.value = `phase:${phase}`;
    opt.textContent = `${phase.charAt(0).toUpperCase() + phase.slice(1)} time by round`;
    select.insertBefore(opt, statsOpt ?? null);
  });
  if (!Array.from(select.options).some(o => o.value === graphType)) graphType = 'total';
  select.value = graphType;

  const sortBtn = document.getElementById('graph-sort-btn') as HTMLElement;
  sortBtn.textContent = `Sort: ${SORT_LABELS[graphSort]}`;
  const hideSort = graphType === 'by_round' || graphType === 'stats' || graphType === 'scores' || graphType.startsWith('phase:');
  sortBtn.style.display = hideSort ? 'none' : '';
  const ssBtn = document.getElementById('graph-scoresheet-btn') as HTMLElement;
  ssBtn.style.display = (graphSource === 'log' && _logBreakdown) ? '' : 'none';

  renderGraph();
}

function findFactionById(factionId: string | null): Faction | null {
  if (!factionId || !state.factions) return null;
  for (const list of Object.values(state.factions)) {
    const f = (list as Faction[]).find(x => x.id === factionId);
    if (f) return f;
  }
  return null;
}

const MODE_NAMES: Record<string, string> = {
  clockwise: 'Clockwise', clockwise_pass: 'Clockwise with Passing',
  eclipse: 'Eclipse', ti: 'Twilight Imperium',
};

export function openGraphOverlayWithLog(log: GameLog): void {
  const players: PlayerSnapshot[] = Object.keys(log.players).map(hwid => {
    const faction = findFactionById(log.factions[hwid] ?? null);
    const s = log.stats[hwid] ?? { turns: 0, total_turn_time_ms: 0, longest_turn_ms: 0 };
    const history = log.turn_history
      .filter(t => t.hwid === hwid)
      .map(t => ({ duration: t.duration_ms, round: t.round }));
    return {
      name: log.players[hwid],
      color: faction?.color ?? '#c9a84c',
      factionName: faction?.nickname ?? faction?.name ?? '',
      totalTurnTime: s.total_turn_time_ms,
      turnHistory: history,
      score: log.scores[hwid] ?? null,
    };
  });

  const d = new Date(log.started_at * 1000);
  const dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const modeName = MODE_NAMES[log.game_mode] || log.game_mode;

  _logStats = {
    gameMode: modeName,
    players,
    totalGameTime: log.total_game_time_ms,
    phaseLog: log.phase_log,
    playerCount: players.length,
  };
  _logTitle = `${dateStr} — ${modeName}`;
  _logBreakdown = log.score_breakdown ?? null;
  _logPlayers = Object.keys(log.players).map((hwid, i) => {
    const fn = players[i].factionName;
    return { hwid, name: log.players[hwid], factionName: fn && fn !== log.players[hwid] ? fn : undefined };
  });
  graphSource = 'log';
  graphType = 'total';
  const dialog = document.getElementById('graph-dialog') as HTMLElement;
  dialog.classList.remove('expanded');
  (document.getElementById('graph-expand-btn') as HTMLElement).textContent = '⤢';
  (document.getElementById('graph-overlay') as HTMLElement).style.display = 'flex';
  renderGraphOverlay();
}

function applyExpandedLayout(): void {
  const dialog = document.getElementById('graph-dialog') as HTMLElement | null;
  if (!dialog?.classList.contains('expanded')) return;
  const content = document.getElementById('graph-content') as HTMLElement | null;
  if (!content) return;

  const graphRows = content.querySelectorAll<HTMLElement>('.graph-row');
  const statsRows = content.querySelectorAll<HTMLElement>('.stats-row');

  if (graphRows.length > 0) {
    const availH = content.clientHeight;
    const dialogW = dialog.clientWidth - 48;
    const n = graphRows.length;
    const GAP = 10;
    const rowH = Math.max(22, Math.min(80, Math.floor((availH - (n - 1) * GAP) / n)));
    const fontSize = Math.max(0.75, Math.min(3.0, rowH / 24));
    const nameW = Math.max(140, Math.min(Math.round(dialogW * 0.35), Math.round(fontSize * 200)));
    const valW = Math.max(52, Math.round(rowH * 2.2));
    dialog.style.setProperty('--exp-row-h', `${rowH}px`);
    dialog.style.setProperty('--exp-font', `${fontSize.toFixed(2)}rem`);
    dialog.style.setProperty('--exp-name-w', `${nameW}px`);
    dialog.style.setProperty('--exp-val-w', `${valW}px`);
  } else if (statsRows.length > 0) {
    const availH = content.clientHeight;
    const n = statsRows.length;
    const GAP = 8;
    const rowH = Math.max(24, Math.min(80, Math.floor((availH - (n - 1) * GAP) / n)));
    const fontSize = Math.max(0.85, Math.min(2.5, rowH / 24));
    dialog.style.setProperty('--exp-stats-font', `${fontSize.toFixed(2)}rem`);
  }
}

export function toggleGraphExpand(): void {
  const dialog = document.getElementById('graph-dialog') as HTMLElement;
  const btn = document.getElementById('graph-expand-btn') as HTMLElement;
  const expanded = dialog.classList.toggle('expanded');
  btn.textContent = expanded ? '⤡' : '⤢';
  // Apply after CSS transition settles (200ms)
  setTimeout(() => requestAnimationFrame(applyExpandedLayout), 220);
}

export function openGraphOverlay(source = 'live'): void {
  graphSource = source;
  _logBreakdown = null;
  _logPlayers = [];
  const dialog = document.getElementById('graph-dialog') as HTMLElement;
  dialog.classList.remove('expanded');
  (document.getElementById('graph-expand-btn') as HTMLElement).textContent = '⤢';
  (document.getElementById('graph-overlay') as HTMLElement).style.display = 'flex';
  renderGraphOverlay();
  if (source === 'live') _graphInterval = setInterval(renderGraph, 1000);
}

export function closeGraphOverlay(): void {
  (document.getElementById('graph-overlay') as HTMLElement).style.display = 'none';
  if (_graphInterval) { clearInterval(_graphInterval); _graphInterval = null; }
}

export function cycleGraphSort(): void {
  const idx = SORT_MODES.indexOf(graphSort);
  graphSort = SORT_MODES[(idx + 1) % SORT_MODES.length];
  renderGraphOverlay();
}

export function onGraphTypeChange(val: string): void {
  graphType = val;
  renderGraphOverlay();
}

export function openLogScoresheet(): void {
  if (!_logBreakdown || _logPlayers.length === 0) return;
  void import('./scoresheet').then(({ openScoresheet }) => {
    openScoresheet(_logPlayers, _logBreakdown!.categories, _logBreakdown!.values, true);
  });
}

export function renderTimerInfo(_hwid: string, box: typeof state.boxes[string]): string {
  if (!timerSettings.showCurrent && !timerSettings.showTotal) return '';
  const parts: string[] = [];
  if (timerSettings.showCurrent && box.turnStartTime) {
    parts.push(formatDuration(Date.now() - box.turnStartTime));
  }
  if (timerSettings.showTotal) {
    const total = (box.totalTurnTime ?? 0) + (box.turnStartTime ? Date.now() - box.turnStartTime : 0);
    if (total > 0) parts.push(`Σ ${formatDuration(total)}`);
  }
  if (parts.length === 0) return '';
  return `<div class="box-timer">${parts.join(' · ')}</div>`;
}
