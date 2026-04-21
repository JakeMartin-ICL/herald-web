import { state } from './state';
import { log } from './logger';
import { sendSilent } from './websockets';
import { syncLeds } from './leds';
import { render } from './render';
import { updateSetupUI } from './boxes';
import { MODE_NAMES } from './modes/index';

// ---- State extraction ----

export function extractPersistableState() {
  const boxes: Record<string, object> = {};
  for (const hwid of state.boxOrder) {
    const box = state.boxes[hwid];
    if (!box) continue;
    boxes[hwid] = {
      hwid:         box.hwid,
      isVirtual:    box.isVirtual,
      status:       box.status,
      factionId:    box.factionId ?? null,
      badges:       box.badges ?? [],
      version:      box.version ?? null,
      totalTurnTime: box.totalTurnTime ?? 0,
      turnHistory:  box.turnHistory ?? [],
    };
  }

  const ti = JSON.parse(JSON.stringify(state.ti)) as typeof state.ti;
  if (ti.players) {
    for (const hwid of Object.keys(ti.players)) {
      if (ti.players[hwid]) delete (ti.players[hwid] as unknown as Record<string, unknown>).confirmedSecondary;
    }
  }

  return {
    gameActive:         state.gameActive,
    gameMode:           state.gameMode,
    boxes,
    boxOrder:           [...state.boxOrder],
    activeBoxId:        state.activeBoxId,
    hubHwid:            state.hubHwid,
    round:              state.round,
    totalRounds:        state.totalRounds,
    gameStartTime:      state.gameStartTime,
    phaseLog:           [...state.phaseLog],
    currentPhaseStart:  state.currentPhaseStart ?? null,
    eclipse: {
      phase:         state.eclipse.phase,
      firstPlayerId: state.eclipse.firstPlayerId,
      passOrder:     [...state.eclipse.passOrder],
      turnOrder:     [...state.eclipse.turnOrder],
      tapToPass:     state.eclipse.tapToPass,
      advancedOrder: state.eclipse.advancedOrder,
      upkeepReady:   [...state.eclipse.upkeepReady],
    },
    ti,
    kemet: {
      phase:            state.kemet.phase,
      turnOrder:        [...state.kemet.turnOrder],
      turnCounts:       { ...state.kemet.turnCounts },
      turnsPerRound:    state.kemet.turnsPerRound,
      guidedNightPhase: state.kemet.guidedNightPhase,
    },
    inis: {
      phase:             state.inis.phase,
      assemblyStep:      state.inis.assemblyStep,
      brennHwid:         state.inis.brennHwid,
      turnDirection:     state.inis.turnDirection,
      turnOrder:         [...state.inis.turnOrder],
      consecutivePasses: state.inis.consecutivePasses,
    },
    arcs: {
      phase:            state.arcs.phase,
      leaderHwid:       state.arcs.leaderHwid,
      initiativeSeized: state.arcs.initiativeSeized,
      turnOrder:        [...state.arcs.turnOrder],
      cycleRemaining:   [...state.arcs.cycleRemaining],
    },
    coc: {
      phase:             state.coc.phase,
      turnOrder:         [...state.coc.turnOrder],
      turnCounts:        { ...state.coc.turnCounts },
      advancedOrder:     state.coc.advancedOrder,
      disableObjectives: state.coc.disableObjectives,
    },
    ts: {
      phase:            state.ts.phase,
      turnOrder:        [...state.ts.turnOrder],
      headlineReady:    [...state.ts.headlineReady],
      actionTurnsTaken: { ...state.ts.actionTurnsTaken },
    },
    factions:  state.factions,
    boxNames:  JSON.parse(JSON.stringify(state.boxNames)) as typeof state.boxNames,
  };
}

// ---- Compression helpers ----

async function compressState(jsonString: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const input = new TextEncoder().encode(jsonString);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(input as unknown as Uint8Array<ArrayBuffer>);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function decompressState(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  void writer.write(bytes as unknown as Uint8Array<ArrayBuffer>);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- Persist ----

function persistStateLocally(): void {
  if (!state.gameActive) return;
  try {
    localStorage.setItem('herald-game-state', JSON.stringify(extractPersistableState()));
  } catch (e) {
    log(`State backup (local) failed: ${(e as Error).message}`, 'error');
  }
}

async function persistStateToHub(): Promise<void> {
  if (!state.gameActive) return;
  const json = JSON.stringify(extractPersistableState());
  let payload: string;
  let compressed: boolean;
  const bytes = await compressState(json);
  if (bytes) {
    payload = uint8ArrayToBase64(bytes);
    compressed = true;
  } else {
    log('State backup: CompressionStream unavailable, sending uncompressed', 'system');
    payload = uint8ArrayToBase64(new TextEncoder().encode(json));
    compressed = false;
  }
  sendSilent({ type: 'state_backup', payload, compressed });
}

export function persistState(): void {
  persistStateLocally();
  void persistStateToHub();
}

export function clearPersistedState(): void {
  localStorage.removeItem('herald-game-state');
  sendSilent({ type: 'state_backup_clear' });
}

// ---- Box assignment (persisted HWIDs → current HWIDs) ----

function buildBoxAssignment(persisted: { boxOrder: string[] }): Record<string, string> {
  const persistedOrder = persisted.boxOrder;
  const currentBoxes = [...state.boxOrder];
  const assignment: Record<string, string> = {};
  const matchedCurrent = new Set<string>();
  const matchedPersisted = new Set<string>();

  for (const ph of persistedOrder) {
    if (currentBoxes.includes(ph) && !matchedCurrent.has(ph)) {
      assignment[ph] = ph;
      matchedCurrent.add(ph);
      matchedPersisted.add(ph);
    }
  }

  const remainingCurrent = currentBoxes.filter(h => !matchedCurrent.has(h));
  const remainingPersisted = persistedOrder.filter(h => !matchedPersisted.has(h));
  for (let i = 0; i < remainingPersisted.length && i < remainingCurrent.length; i++) {
    assignment[remainingPersisted[i]] = remainingCurrent[i];
  }

  return assignment;
}

// ---- Restore ----

let _pendingPersistedBoxes: Record<string, Record<string, unknown>> = {};

function mergePersistedBox(hwid: string, persBox: Record<string, unknown>): void {
  const box = state.boxes[hwid];
  if (!box) return;
  box.status        = (persBox.status as typeof box.status) ?? 'idle';
  box.factionId     = (persBox.factionId as string | null) ?? null;
  box.badges        = (persBox.badges as typeof box.badges) ?? [];
  box.totalTurnTime = (persBox.totalTurnTime as number) ?? 0;
  box.turnHistory   = (persBox.turnHistory as typeof box.turnHistory) ?? [];
}

export function applyPendingPersistedBox(hwid: string): void {
  if (!_pendingPersistedBoxes[hwid]) return;
  mergePersistedBox(hwid, _pendingPersistedBoxes[hwid]);
  delete _pendingPersistedBoxes[hwid];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function restoreState(persisted: any, silent = false): void {
  const assignment = buildBoxAssignment(persisted as { boxOrder: string[] });
  const remap = (ph: string) => assignment[ph] ?? ph;

  state.gameActive        = persisted.gameActive;
  state.gameMode          = persisted.gameMode;
  state.activeBoxId       = persisted.activeBoxId ? remap(persisted.activeBoxId) : null;
  state.boxOrder          = (persisted.boxOrder as string[]).map(remap);
  state.hubHwid           = persisted.hubHwid ? remap(persisted.hubHwid) : state.hubHwid;
  state.round             = persisted.round ?? 0;
  state.totalRounds       = persisted.totalRounds ?? null;
  state.gameStartTime     = persisted.gameStartTime ?? null;
  state.phaseLog          = persisted.phaseLog ?? [];
  state.currentPhaseStart = persisted.currentPhaseStart ?? null;

  if (persisted.factions) state.factions = persisted.factions;

  for (const [ph, nameObj] of Object.entries(persisted.boxNames ?? {})) {
    const ch = remap(ph);
    if (ch) state.boxNames[ch] = nameObj as typeof state.boxNames[string];
  }

  if (persisted.eclipse) {
    state.eclipse = {
      phase:         persisted.eclipse.phase,
      firstPlayerId: persisted.eclipse.firstPlayerId ? remap(persisted.eclipse.firstPlayerId) : null,
      passOrder:     ((persisted.eclipse.passOrder ?? []) as string[]).map(remap),
      turnOrder:     ((persisted.eclipse.turnOrder ?? []) as string[]).map(remap),
      tapToPass:     persisted.eclipse.tapToPass !== undefined ? persisted.eclipse.tapToPass : true,
      advancedOrder: persisted.eclipse.advancedOrder ?? false,
      upkeepReady:   ((persisted.eclipse.upkeepReady ?? []) as string[]).map(remap),
    };
  }

  if (persisted.ti) {
    const ti = { ...persisted.ti };
    ti.speakerHwid = ti.speakerHwid ? remap(ti.speakerHwid) : null;
    ti.turnOrder   = ((ti.turnOrder ?? []) as string[]).map(remap);
    if (ti.players) {
      const remapped: typeof state.ti.players = {};
      for (const [ph, data] of Object.entries(ti.players)) {
        remapped[remap(ph)] = data as typeof state.ti.players[string];
      }
      ti.players = remapped;
    }
    if (ti.secondary) {
      ti.secondary = { ...ti.secondary };
      if (ti.secondary.activeHwid) ti.secondary.activeHwid = remap(ti.secondary.activeHwid);
      ti.secondary.pendingHwids = ((ti.secondary.pendingHwids ?? []) as string[]).map(remap);
    }
    state.ti = ti;
  }

  if (persisted.kemet) {
    const remappedCounts: Record<string, number> = {};
    for (const [ph, count] of Object.entries(persisted.kemet.turnCounts ?? {})) {
      remappedCounts[remap(ph)] = count as number;
    }
    state.kemet = {
      phase:            persisted.kemet.phase ?? null,
      turnOrder:        ((persisted.kemet.turnOrder ?? []) as string[]).map(remap),
      turnCounts:       remappedCounts,
      turnsPerRound:    persisted.kemet.turnsPerRound ?? 5,
      guidedNightPhase: persisted.kemet.guidedNightPhase ?? false,
    };
  }

  if (persisted.inis) {
    state.inis = {
      phase:             persisted.inis.phase ?? null,
      assemblyStep:      persisted.inis.assemblyStep ?? null,
      brennHwid:         persisted.inis.brennHwid ? remap(persisted.inis.brennHwid) : null,
      turnDirection:     persisted.inis.turnDirection ?? 'clockwise',
      turnOrder:         ((persisted.inis.turnOrder ?? []) as string[]).map(remap),
      consecutivePasses: persisted.inis.consecutivePasses ?? 0,
    };
  }

  if (persisted.arcs) {
    state.arcs = {
      phase:            persisted.arcs.phase ?? null,
      leaderHwid:       persisted.arcs.leaderHwid ? remap(persisted.arcs.leaderHwid) : null,
      initiativeSeized: persisted.arcs.initiativeSeized ?? false,
      turnOrder:        ((persisted.arcs.turnOrder ?? []) as string[]).map(remap),
      cycleRemaining:   ((persisted.arcs.cycleRemaining ?? []) as string[]).map(remap),
    };
  }

  if (persisted.coc) {
    const remappedCounts: Record<string, number> = {};
    for (const [ph, count] of Object.entries(persisted.coc.turnCounts ?? {})) {
      remappedCounts[remap(ph)] = count as number;
    }
    state.coc = {
      phase:             persisted.coc.phase ?? null,
      turnOrder:         ((persisted.coc.turnOrder ?? []) as string[]).map(remap),
      turnCounts:        remappedCounts,
      advancedOrder:     persisted.coc.advancedOrder ?? false,
      disableObjectives: persisted.coc.disableObjectives ?? false,
    };
  }

  if (persisted.ts) {
    const remappedTurns: Record<string, number> = {};
    for (const [ph, count] of Object.entries(persisted.ts.actionTurnsTaken ?? {})) {
      remappedTurns[remap(ph)] = count as number;
    }
    state.ts = {
      phase:            persisted.ts.phase ?? null,
      turnOrder:        ((persisted.ts.turnOrder ?? []) as string[]).map(remap),
      headlineReady:    ((persisted.ts.headlineReady ?? []) as string[]).map(remap),
      actionTurnsTaken: remappedTurns,
    };
  }

  _pendingPersistedBoxes = {};
  for (const [ph, persBox] of Object.entries(persisted.boxes ?? {})) {
    const ch = assignment[ph];
    if (!ch) continue;
    if (state.boxes[ch]) {
      mergePersistedBox(ch, persBox as Record<string, unknown>);
    } else {
      const pb = persBox as Record<string, unknown>;
      state.boxes[ch] = {
        hwid:         ch,
        isVirtual:    (pb.isVirtual as boolean) ?? false,
        status:       'disconnected',
        factionId:    (pb.factionId as string | null) ?? null,
        badges:       (pb.badges as typeof state.boxes[string]['badges']) ?? [],
        totalTurnTime: (pb.totalTurnTime as number) ?? 0,
        turnHistory:  (pb.turnHistory as typeof state.boxes[string]['turnHistory']) ?? [],
      };
      _pendingPersistedBoxes[ch] = pb;
    }
  }

  (document.getElementById('game-mode') as HTMLSelectElement).value = state.gameMode;
  (document.getElementById('setup-panel') as HTMLElement).style.display = 'none';

  syncLeds();
  updateSetupUI();
  render();

  if (!silent) log(`Game resumed: ${state.gameMode}, round ${state.round}`, 'system');
}

// ---- Resume UI ----

let _pendingResumeState: unknown = null;


export function offerResume(persistedState: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = persistedState as any;
  if (!ps?.gameActive) return;
  _pendingResumeState = persistedState;

  const modeName = MODE_NAMES[ps.gameMode] ?? ps.gameMode;
  const playerCount = ps.boxOrder.length;
  (document.getElementById('resume-mode-label') as HTMLElement).textContent =
    `Game in progress: ${modeName} · ${playerCount} players`;

  let detail = '';
  if (ps.round) detail += `Round ${ps.round}`;
  const phase = ps.eclipse?.phase ?? ps.ti?.phase ?? ps.kemet?.phase ?? ps.inis?.phase ?? ps.arcs?.phase ?? ps.coc?.phase ?? ps.ts?.phase ?? ps.currentPhaseStart?.name;
  if (phase) detail += `${detail ? ' · ' : ''}${(phase as string).charAt(0).toUpperCase() + (phase as string).slice(1)} Phase`;
  (document.getElementById('resume-detail-label') as HTMLElement).textContent = detail;

  (document.getElementById('resume-banner') as HTMLElement).style.display = 'block';
  updateResumeBtnState();
}

export function updateResumeBtnState(): void {
  if (!_pendingResumeState) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = _pendingResumeState as any;
  const needed = ps.boxOrder.length;
  const have = state.boxOrder.length;
  const ready = have >= needed;
  (document.getElementById('resume-btn') as HTMLButtonElement).disabled = !ready;
  const waitingEl = document.getElementById('resume-waiting') as HTMLElement;
  waitingEl.style.display = ready ? 'none' : 'block';
  waitingEl.textContent = `Waiting for players to connect (${have} / ${needed})…`;
}

export function confirmResume(): void {
  if (!_pendingResumeState) return;
  const toRestore = _pendingResumeState;
  _pendingResumeState = null;
  (document.getElementById('resume-banner') as HTMLElement).style.display = 'none';
  restoreState(toRestore);
  void Promise.all([
    import('./modes/index'),
    import('./currentGame'),
    import('./timers'),
    import('./init'),
  ]).then(([{ createGameMode }, { setCurrentGame }, { needsTimerInterval, startCurrentTimerInterval }, { requestWakeLock, initSilentAudio }]) => {
    const mode = createGameMode(state.gameMode);
    if (mode) {
      setCurrentGame(mode);
      mode.onResume?.();
    }
    if (needsTimerInterval()) startCurrentTimerInterval();
    void requestWakeLock();
    initSilentAudio();
  });
}

export function discardResume(): void {
  _pendingResumeState = null;
  (document.getElementById('resume-banner') as HTMLElement).style.display = 'none';
  clearPersistedState();
}

// ---- Decode incoming hub backup ----

export async function applyHubBackup(payload: string, compressed: boolean): Promise<void> {
  try {
    let json: string;
    if (compressed && typeof DecompressionStream !== 'undefined') {
      json = await decompressState(base64ToUint8Array(payload));
    } else {
      json = new TextDecoder().decode(base64ToUint8Array(payload));
    }
    const parsed = JSON.parse(json);
    if (parsed.gameActive) offerResume(parsed);
  } catch (e) {
    log(`State backup decode failed: ${(e as Error).message}`, 'error');
  }
}
