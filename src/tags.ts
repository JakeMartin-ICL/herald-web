import { state } from './state';
import { log } from './logger';
import { currentGame } from './currentGame';
import type { Tag, AllTags } from './types';

export async function loadTags(): Promise<void> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}tags.json`);
    const raw = await r.json() as Record<string, { display: string; id: string }[]>;
    state.allTags = expandAllTags(raw);
  } catch {
    log('Warning: could not load tags.json', 'error');
  }
}

function expandAllTags(raw: Record<string, { display: string; id: string }[]>): AllTags {
  const result: Record<string, Tag[]> = {};
  for (const [game, entries] of Object.entries(raw)) {
    result[game] = expandTagList(game, entries);
  }
  return result;
}

function expandTagList(game: string, entries: { display: string; id: string }[]): Tag[] {
  const out: Tag[] = [];
  for (const entry of entries) {
    if (entry.display === '*' && entry.id.endsWith(':*')) {
      const prefix = entry.id.slice(0, -1);
      const gameKey = game === 'ti' ? 'twilight_imperium' : game;
      const factions = state.factions?.[gameKey as keyof typeof state.factions];
      if (Array.isArray(factions)) {
        for (const f of factions) {
          out.push({ display: f.name, id: prefix + f.id });
        }
      }
    } else {
      out.push({ display: entry.display, id: entry.id });
    }
  }
  return out;
}

export function getTagsByGame(game: string): Tag[] {
  return state.allTags?.[game] ?? [];
}

export function filterTags(game: string, predicate: (t: Tag) => boolean): Tag[] {
  return getTagsByGame(game).filter(predicate);
}

// Returns relevant RFID tags for a specific box. Empty list → hide the RFID button.
export function getRelevantTagsForBox(hwid: string): Tag[] {
  if (state.factionScanActive) {
    const game = state.gameMode === 'ti' ? 'ti' : 'eclipse';
    return filterTags(game, t => t.id.includes(':faction:'));
  }
  if (!state.gameActive) return [];
  return currentGame?.getRelevantTags(hwid) ?? [];
}
