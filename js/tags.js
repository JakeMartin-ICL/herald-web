// ---- Tag definitions ----
//
// state.allTags: { ti: [{display, id}], eclipse: [{display, id}] }
// Loaded from tags.json; wildcard entries { display: "*", id: "game:faction:*" }
// are expanded from factions.json at load time.

function loadTags() {
  fetch('./tags.json')
    .then(r => r.json())
    .then(raw => { state.allTags = expandAllTags(raw); })
    .catch(() => log('Warning: could not load tags.json', 'error'));
}

function expandAllTags(raw) {
  const result = {};
  for (const [game, entries] of Object.entries(raw)) {
    result[game] = expandTagList(game, entries);
  }
  return result;
}

function expandTagList(game, entries) {
  const out = [];
  for (const entry of entries) {
    if (entry.display === '*' && entry.id.endsWith(':*')) {
      const prefix = entry.id.slice(0, -1); // strip trailing *
      const gameKey = game === 'ti' ? 'twilight_imperium' : game;
      for (const f of (state.factions?.[gameKey] || [])) {
        out.push({ display: f.name, id: prefix + f.id });
      }
    } else {
      out.push({ display: entry.display, id: entry.id });
    }
  }
  return out;
}

function getTagsByGame(game) {
  return state.allTags?.[game] || [];
}

// Filter expanded tag list by predicate.
function filterTags(game, predicate) {
  return getTagsByGame(game).filter(predicate);
}

// Returns the relevant RFID tags for a specific box given current game state.
// Used by the sim RFID dialog. Empty list → hide the RFID button.
function getRelevantTagsForBox(hwid) {
  if (state.factionScanActive) {
    const game = state.gameMode === 'ti' ? 'ti' : 'eclipse';
    return filterTags(game, t => t.id.includes(':faction:'));
  }
  if (!state.gameActive) return [];
  if (state.gameMode === 'ti') return tiRelevantTags(hwid);
  if (state.gameMode.startsWith('eclipse')) return eclipseRelevantTags(hwid);
  return [];
}
