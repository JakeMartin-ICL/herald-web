// ---- Turn time graphs ----

const SORT_MODES  = ['table', 'name', 'faction', 'highest'];
const SORT_LABELS = { table: 'Table order', name: 'Name', faction: 'Faction', highest: 'Highest' };

let graphType     = 'total';
let graphSort     = 'table';
let graphSource   = 'live'; // 'live' | 'prev'
let prevGameStats = null;
let _graphInterval = null;

function snapshotPlayer(id) {
  const box = state.boxes[id];
  const faction = getFactionForBox(id);
  const inProgress = box.turnStartTime ? Date.now() - box.turnStartTime : 0;
  return {
    name: getDisplayName(id),
    color: faction?.color || '#c9a84c',
    factionName: faction?.name || '',
    totalTurnTime: (box.totalTurnTime || 0) + inProgress,
    // turnHistory entries are { duration, round }; append in-progress as current round
    turnHistory: [
      ...(box.turnHistory || []),
      ...(inProgress > 0 ? [{ duration: inProgress, round: getCurrentRound() }] : []),
    ],
  };
}

function captureGameStats() {
  const modeNames = {
    clockwise: 'Clockwise', clockwise_pass: 'Clockwise with Passing',
    eclipse: 'Eclipse',
    ti: 'Twilight Imperium',
  };
  // Snapshot current phase into log before capturing (don't mutate state)
  const phaseLog = [...state.phaseLog];
  if (state.currentPhaseStart) {
    phaseLog.push({ phase: state.currentPhaseStart.name, duration: Date.now() - state.currentPhaseStart.startTime, round: state.round });
  }
  prevGameStats = {
    gameMode: modeNames[state.gameMode] || state.gameMode,
    players: state.boxOrder.filter(id => state.boxes[id]).map(snapshotPlayer),
    totalGameTime: state.gameStartTime ? Date.now() - state.gameStartTime : null,
    phaseLog,
    playerCount: state.boxOrder.filter(id => state.boxes[id]).length,
  };
}

function getGraphPlayers() {
  if (graphSource === 'prev' && prevGameStats) return prevGameStats.players;
  return state.boxOrder.filter(id => state.boxes[id]).map(snapshotPlayer);
}

function graphValueForPlayer(player) {
  const hist = player.turnHistory;
  switch (graphType) {
    case 'total':   return player.totalTurnTime;
    case 'longest': return hist.length > 0 ? Math.max(...hist.map(t => t.duration)) : 0;
    case 'average': return hist.length > 0 ? Math.round(player.totalTurnTime / hist.length) : 0;
    case 'turns':   return hist.length;
    default:        return 0;
  }
}

function getSortedPlayers() {
  const players = getGraphPlayers();
  if (graphSort === 'name')    return players.sort((a, b) => a.name.localeCompare(b.name));
  if (graphSort === 'faction') return players.sort((a, b) => a.factionName.localeCompare(b.factionName));
  if (graphSort === 'highest') return players.sort((a, b) => graphValueForPlayer(b) - graphValueForPlayer(a));
  return players;
}

function getPhaseLog() {
  if (graphSource === 'prev' && prevGameStats) return prevGameStats.phaseLog;
  const log = [...state.phaseLog];
  if (state.currentPhaseStart) {
    log.push({ phase: state.currentPhaseStart.name, duration: Date.now() - state.currentPhaseStart.startTime, round: state.round });
  }
  return log;
}

function getDistinctPhases() {
  const seen = new Set();
  return getPhaseLog().filter(e => !seen.has(e.phase) && seen.add(e.phase)).map(e => e.phase);
}

function getPhaseRoundItems(phaseName) {
  return getPhaseLog()
    .filter(e => e.phase === phaseName)
    .sort((a, b) => (a.round || 0) - (b.round || 0))
    .map(e => ({ name: `Round ${e.round ?? '?'}`, color: '#c9a84c', value: e.duration }));
}

function getRoundItems() {
  const roundMap = {};
  getGraphPlayers().forEach(player => {
    player.turnHistory.forEach(({ duration, round }) => {
      if (round == null) return;
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

function getGraphItems() {
  if (graphType === 'by_round') return getRoundItems();
  if (graphType.startsWith('phase:')) return getPhaseRoundItems(graphType.slice(6));
  return getSortedPlayers().map(p => ({ name: p.name, color: p.color, value: graphValueForPlayer(p) }));
}

function formatGraphValue(value) {
  if (graphType === 'turns') return value > 0 ? String(value) : '0';
  return value > 0 ? formatDuration(value) : '—';
}

function renderGraph() {
  const el = document.getElementById('graph-content');
  if (!el) return;
  if (graphType === 'stats') { renderStats(); return; }
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
}

function renderStats() {
  const el = document.getElementById('graph-content');
  if (!el) return;

  const isPrev = graphSource === 'prev' && prevGameStats;
  const gameTime = isPrev
    ? prevGameStats.totalGameTime
    : (state.gameStartTime ? Date.now() - state.gameStartTime : null);
  const playerCount = isPrev
    ? prevGameStats.playerCount
    : state.boxOrder.filter(id => state.boxes[id]).length;

  const phaseLog = getPhaseLog();

  const players = getGraphPlayers();
  const allTurns = players.flatMap(p => p.turnHistory.map(t => t.duration));
  const overallAvg = allTurns.length > 0
    ? Math.round(allTurns.reduce((s, d) => s + d, 0) / allTurns.length) : null;

  const rows = [];

  if (gameTime != null) {
    rows.push({ label: 'Total game time', value: formatDuration(gameTime) });
    if (playerCount > 0) {
      rows.push({ label: 'Game time per player', value: formatDuration(Math.round(gameTime / playerCount)) });
    }
  }

  rows.push({ label: 'Overall avg turn time', value: overallAvg != null ? formatDuration(overallAvg) : '—' });

  // Phase totals — one row per distinct phase name, in order of first appearance
  if (phaseLog.length > 0) {
    const phaseTotals = {};
    const phaseOrder = [];
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
}

function renderGraphOverlay() {
  const title = graphSource === 'prev' && prevGameStats
    ? `Previous game — ${prevGameStats.gameMode}`
    : 'Current game';
  document.getElementById('graph-dialog-title').textContent = title;

  // Rebuild phase-by-round options dynamically
  const select = document.getElementById('graph-type-select');
  Array.from(select.options).filter(o => o.value.startsWith('phase:')).forEach(o => o.remove());
  const statsOpt = Array.from(select.options).find(o => o.value === 'stats');
  getDistinctPhases().forEach(phase => {
    const opt = document.createElement('option');
    opt.value = `phase:${phase}`;
    opt.textContent = `${phase.charAt(0).toUpperCase() + phase.slice(1)} time by round`;
    select.insertBefore(opt, statsOpt);
  });
  if (!Array.from(select.options).some(o => o.value === graphType)) graphType = 'total';
  select.value = graphType;

  const sortBtn = document.getElementById('graph-sort-btn');
  sortBtn.textContent = `Sort: ${SORT_LABELS[graphSort]}`;
  const hideSort = graphType === 'by_round' || graphType === 'stats' || graphType.startsWith('phase:');
  sortBtn.style.display = hideSort ? 'none' : '';
  renderGraph();
}

function openGraphOverlay(source = 'live') {
  graphSource = source;
  document.getElementById('graph-overlay').style.display = 'flex';
  renderGraphOverlay();
  if (source === 'live') _graphInterval = setInterval(renderGraph, 1000);
}

function closeGraphOverlay() {
  document.getElementById('graph-overlay').style.display = 'none';
  if (_graphInterval) { clearInterval(_graphInterval); _graphInterval = null; }
}

function cycleGraphSort() {
  const idx = SORT_MODES.indexOf(graphSort);
  graphSort = SORT_MODES[(idx + 1) % SORT_MODES.length];
  renderGraphOverlay();
}

function onGraphTypeChange(val) {
  graphType = val;
  renderGraphOverlay(); // also updates sort button visibility
}

function renderTimerInfo(hwid, box) {
  if (!timerSettings.showCurrent && !timerSettings.showTotal) return '';
  const parts = [];
  if (timerSettings.showCurrent && box.turnStartTime) {
    parts.push(formatDuration(Date.now() - box.turnStartTime));
  }
  if (timerSettings.showTotal) {
    const total = (box.totalTurnTime || 0) + (box.turnStartTime ? Date.now() - box.turnStartTime : 0);
    if (total > 0) parts.push(`Σ ${formatDuration(total)}`);
  }
  if (parts.length === 0) return '';
  return `<div class="box-timer">${parts.join(' · ')}</div>`;
}
