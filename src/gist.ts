import { loadGameLogIndex, loadGameLog, importGameLog } from './gamelog';
import { log } from './logger';
import type { GameLog, GameLogIndexEntry, GitHubConfig } from './types';

const GIST_API = 'https://api.github.com/gists';

function authHeaders(pat: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

export async function createGist(pat: string): Promise<string> {
  const resp = await fetch(GIST_API, {
    method: 'POST',
    headers: authHeaders(pat),
    body: JSON.stringify({
      description: 'Herald game logs',
      public: false,
      files: { '_index.json': { content: JSON.stringify({ version: 1, games: [] }, null, 2) } },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${resp.status}${text ? ': ' + text : ''}`);
  }
  return ((await resp.json()) as { id: string }).id;
}

export interface SyncResult { uploaded: number; downloaded: number }
export type SyncStatusFn = (msg: string) => void;

export async function syncWithGist(config: GitHubConfig, onStatus?: SyncStatusFn): Promise<SyncResult> {
  const status = (msg: string) => { log(msg, 'system'); onStatus?.(msg); };

  status('Fetching gist…');
  const resp = await fetch(`${GIST_API}/${config.gist_id}`, {
    headers: { 'Authorization': `Bearer ${config.pat}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('GitHub authentication failed — check your PAT');
    if (resp.status === 404) throw new Error('Gist not found — check Gist ID or create a new one');
    throw new Error(`GitHub API ${resp.status}`);
  }
  const gist = (await resp.json()) as { files: Record<string, { content?: string; raw_url?: string }> };

  // Parse remote index
  let remoteGames: GameLogIndexEntry[] = [];
  const indexContent = gist.files['_index.json']?.content;
  if (indexContent) {
    try { remoteGames = (JSON.parse(indexContent) as { games: GameLogIndexEntry[] }).games ?? []; }
    catch { /* malformed — treat as empty */ }
  }
  const remoteNames = new Set(remoteGames.map(g => g.filename));

  const localIndex = loadGameLogIndex();
  const localNames = new Set(localIndex.map(e => e.filename));

  const patchFiles: Record<string, { content: string }> = {};
  let uploaded = 0;
  let downloaded = 0;

  // Upload local games absent from remote
  for (const entry of localIndex) {
    if (remoteNames.has(entry.filename)) continue;
    const gameLog = loadGameLog(entry.filename);
    if (!gameLog) continue;
    patchFiles[entry.filename] = { content: JSON.stringify(gameLog) };
    uploaded++;
  }

  // Download remote games absent locally
  for (const entry of remoteGames) {
    if (localNames.has(entry.filename)) continue;
    const file = gist.files[entry.filename];
    if (!file) continue;
    let content = file.content;
    if (!content && file.raw_url) {
      const r = await fetch(file.raw_url);
      content = await r.text();
    }
    if (!content) continue;
    try { importGameLog(JSON.parse(content) as GameLog); downloaded++; }
    catch { /* skip malformed */ }
  }

  // Build merged index and upload if anything changed
  const merged = new Map<string, GameLogIndexEntry>();
  for (const e of localIndex) merged.set(e.filename, e);
  for (const e of remoteGames) if (!merged.has(e.filename)) merged.set(e.filename, e);
  const mergedList = [...merged.values()].sort((a, b) => b.started_at - a.started_at);

  if (uploaded > 0 || downloaded > 0 || mergedList.length !== remoteGames.length) {
    patchFiles['_index.json'] = { content: JSON.stringify({ version: 1, games: mergedList }, null, 2) };
  }

  if (Object.keys(patchFiles).length > 0) {
    if (uploaded > 0) status(`Uploading ${uploaded} game(s)…`);
    const patchResp = await fetch(`${GIST_API}/${config.gist_id}`, {
      method: 'PATCH',
      headers: authHeaders(config.pat),
      body: JSON.stringify({ files: patchFiles }),
    });
    if (!patchResp.ok) throw new Error(`GitHub PATCH ${patchResp.status}`);
  }

  status(`Sync complete — ${uploaded} uploaded, ${downloaded} downloaded`);
  return { uploaded, downloaded };
}
