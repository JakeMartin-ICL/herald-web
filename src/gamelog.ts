import { state } from './state';
import { getDisplayName } from './boxes';
import type { GameLog, GameLogIndexEntry } from './types';

const LOG_INDEX_KEY = 'herald-game-logs-index';
const LOG_KEY_PREFIX = 'herald-game-log-';

export function buildGameLog(): GameLog {
  const now = Date.now();

  // Include in-progress phase
  const phaseLog = [...state.phaseLog];
  if (state.currentPhaseStart) {
    phaseLog.push({
      phase: state.currentPhaseStart.name,
      duration: now - state.currentPhaseStart.startTime,
      round: state.round,
    });
  }

  const players: Record<string, string> = {};
  const factions: Record<string, string | null> = {};
  const scores: Record<string, number | null> = {};
  const stats: Record<string, { turns: number; total_turn_time_ms: number; longest_turn_ms: number }> = {};
  const turn_history: { hwid: string; round: number | null; duration_ms: number }[] = [];

  for (const hwid of state.boxOrder) {
    const box = state.boxes[hwid];
    if (!box) continue;
    players[hwid] = getDisplayName(hwid);
    factions[hwid] = box.factionId;
    scores[hwid] = null;

    const history = box.turnHistory ?? [];
    const inProgress = box.turnStartTime ? now - box.turnStartTime : 0;
    const full = inProgress > 0
      ? [...history, { duration: inProgress, round: state.round }]
      : [...history];

    stats[hwid] = {
      turns: full.length,
      total_turn_time_ms: (box.totalTurnTime ?? 0) + inProgress,
      longest_turn_ms: full.length > 0 ? Math.max(...full.map(t => t.duration)) : 0,
    };
    for (const t of full) turn_history.push({ hwid, round: t.round, duration_ms: t.duration });
  }

  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const filename = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.json`;

  return {
    version: 1,
    filename,
    started_at: state.gameStartTime ? Math.floor(state.gameStartTime / 1000) : Math.floor(now / 1000),
    ended_at: Math.floor(now / 1000),
    game_mode: state.gameMode,
    rounds: state.round,
    total_game_time_ms: state.gameStartTime ? now - state.gameStartTime : null,
    players,
    factions,
    scores,
    stats,
    turn_history,
    phase_log: phaseLog,
  };
}

function toIndexEntry(log: GameLog): GameLogIndexEntry {
  return {
    filename: log.filename,
    started_at: log.started_at,
    ended_at: log.ended_at,
    game_mode: log.game_mode,
    player_names: Object.values(log.players),
  };
}

function upsertIndex(entry: GameLogIndexEntry): void {
  const index = loadGameLogIndex();
  const i = index.findIndex(e => e.filename === entry.filename);
  if (i >= 0) index[i] = entry;
  else index.push(entry);
  index.sort((a, b) => b.started_at - a.started_at);
  localStorage.setItem(LOG_INDEX_KEY, JSON.stringify(index));
}

export function saveGameLog(log: GameLog): void {
  try {
    localStorage.setItem(LOG_KEY_PREFIX + log.filename, JSON.stringify(log));
    upsertIndex(toIndexEntry(log));
  } catch (e) {
    console.error('Failed to save game log', e);
  }
}

/** Store a log received from a remote gist (no local context needed). */
export function importGameLog(log: GameLog): void {
  try {
    localStorage.setItem(LOG_KEY_PREFIX + log.filename, JSON.stringify(log));
    upsertIndex(toIndexEntry(log));
  } catch (e) {
    console.error('Failed to import game log', e);
  }
}

export function loadGameLogIndex(): GameLogIndexEntry[] {
  try {
    const raw = localStorage.getItem(LOG_INDEX_KEY);
    return raw ? JSON.parse(raw) as GameLogIndexEntry[] : [];
  } catch { return []; }
}

export function loadGameLog(filename: string): GameLog | null {
  try {
    const raw = localStorage.getItem(LOG_KEY_PREFIX + filename);
    return raw ? JSON.parse(raw) as GameLog : null;
  } catch { return null; }
}
