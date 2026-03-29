import { state } from '../state';
import { log } from '../logger';
import { disableAllRfid, enableRfid, sendToBox } from '../websockets';
import { getDisplayName } from '../boxes';
import { render } from '../render';
import { startPhase, endPhase } from '../timers';
import { persistState } from '../persist';
import { LED_COUNT, normalizeColor } from '../leds';
import { captureGameStats } from '../graphs';
import type { GameMode, Tag, ActionDef } from '../types';

const UPKEEP_GOLD  = '#d4a017';
const UPKEEP_PINK  = '#e64da0';
const UPKEEP_BROWN = '#cc7700';

export class EclipseMode implements GameMode {
  readonly id = 'eclipse';
  readonly scoreBreakdownCategories: readonly string[] = [
    'Reputation', 'Ambassadors', 'Sectors', 'Monoliths',
    'Discoveries', 'Traitor', 'Tech', 'Species',
  ];

  get turnOrder(): string[] { return state.eclipse.turnOrder; }
  set turnOrder(order: string[]) { state.eclipse.turnOrder = order; }

  private upkeepAnimTimer: ReturnType<typeof setTimeout> | null = null;
  private upkeepAnimFrames: { leds: string[]; duration: number; fade?: boolean }[] = [];

  start(): void {
    const firstPlayerId = (document.getElementById('first-player') as HTMLSelectElement).value;
    state.eclipse.firstPlayerId = firstPlayerId;
    state.eclipse.passOrder = [];
    state.eclipse.upkeepReady = [];
    state.eclipse.tapToPass = (document.getElementById('eclipse-reaction-cards') as HTMLInputElement).checked;
    state.eclipse.advancedOrder = (document.getElementById('eclipse-advanced-order') as HTMLInputElement).checked;
    state.eclipse.phase = 'action';
    state.round = 1;
    state.totalRounds = 8;
    startPhase('action');
    this.buildTurnOrder(firstPlayerId);
    this.activateNext();
    log(`Eclipse started — ${getDisplayName(firstPlayerId)} goes first`, 'system');
  }

  onEndTurn(hwid: string): void {
    if (state.eclipse.phase === 'upkeep') {
      this.upkeepReady(hwid, 'button');
      return;
    }
    if (hwid !== state.activeBoxId) return;
    const box = state.boxes[hwid];
    if (box.status === 'reacting') {
      box.status = 'can-react';
      log(`${getDisplayName(hwid)} reaction done`, 'system');
    } else {
      box.status = 'idle';
    }
    this.activateNext();
  }

  onPass(hwid: string): void {
    if (state.eclipse.phase === 'upkeep') {
      this.upkeepReady(hwid, 'button');
      return;
    }
    if (hwid !== state.activeBoxId) return;
    const box = state.boxes[hwid];

    if (box.status === 'reacting') {
      box.status = 'passed';
      log(`${getDisplayName(hwid)} opts out of reactions`, 'system');
    } else if (box.status === 'active') {
      if (state.eclipse.tapToPass) {
        log(`${getDisplayName(hwid)}: tap your reaction card to pass`, 'system');
        return;
      }
      box.status = 'can-react';
      state.eclipse.passOrder.push(hwid);
      log(`${getDisplayName(hwid)} passes`, 'system');
    }

    if (this.isActionOver()) {
      this.endActionPhase();
    } else {
      this.activateNext();
    }
  }

  onLongPress(hwid: string): void {
    if (hwid !== state.hubHwid) return;
    this.advancePhase();
  }

  advancePhase(): void {
    switch (state.eclipse.phase) {
      case 'combat': this.startUpkeep(); break;
      case 'upkeep': this.endRound(); break;
    }
  }

  onRfid(hwid: string, _game: string, category: string, _id: string): void {
    if (!state.eclipse.tapToPass) return;
    if (category !== 'faction') return;

    if (state.eclipse.phase === 'action' && hwid === state.activeBoxId) {
      const box = state.boxes[hwid];
      if (box?.status !== 'active') return;
      box.status = 'can-react';
      state.eclipse.passOrder.push(hwid);
      log(`${getDisplayName(hwid)} passes (tapped)`, 'system');
      if (this.isActionOver()) {
        this.endActionPhase();
      } else {
        this.activateNext();
      }
      render();
      persistState();
    } else if (state.eclipse.phase === 'upkeep') {
      this.upkeepReady(hwid, 'tap');
      render();
      persistState();
    }
  }

  getRelevantTags(hwid: string): Tag[] {
    const box = state.boxes[hwid];
    if (!box || !state.eclipse.tapToPass) return [];

    const factionTag: Tag[] = box.factionId
      ? [{ display: getDisplayName(hwid), id: `eclipse:faction:${box.factionId}` }]
      : [];

    if (state.eclipse.phase === 'action' && hwid === state.activeBoxId) {
      if (box.status === 'active') return factionTag;
    }
    if (state.eclipse.phase === 'upkeep' && box.status === 'upkeep') {
      return factionTag;
    }
    return [];
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.eclipse.phase ?? '';

    // Next order hint during action phase
    if (phase === 'action' && state.eclipse.passOrder.length > 0) {
      let nextOrder: string[];
      if (state.eclipse.advancedOrder) {
        nextOrder = state.eclipse.passOrder.map(id => getDisplayName(id));
        const remaining = state.boxOrder.filter(id =>
          !state.eclipse.passOrder.includes(id) &&
          state.boxes[id].status !== 'disconnected' &&
          state.boxes[id].status !== 'passed'
        );
        if (remaining.length > 0) nextOrder.push('…');
      } else {
        const firstNext = state.eclipse.passOrder[0];
        const firstIdx = state.boxOrder.indexOf(firstNext);
        nextOrder = [
          ...state.boxOrder.slice(firstIdx),
          ...state.boxOrder.slice(0, firstIdx),
        ].filter(id => state.boxes[id].status !== 'disconnected')
         .map(id => getDisplayName(id));
      }
      statusLines.push(`Next order: ${nextOrder.join(' → ')}`);
    }

    // Tap-to-pass toggle
    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-tap-to-pass"${state.eclipse.tapToPass ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Tap to pass</span>
      </label>`,
      id: 'gc-tap-to-pass', event: 'change',
      fn: (e) => {
        state.eclipse.tapToPass = (e.target as HTMLInputElement).checked;
        log(`Tap to pass ${state.eclipse.tapToPass ? 'enabled' : 'disabled'}`, 'system');
        if (state.eclipse.phase === 'action') this.syncActionRfid();
        if (state.eclipse.phase === 'upkeep') {
          if (state.eclipse.tapToPass) {
            disableAllRfid();
            state.boxOrder.forEach(id => { if (state.boxes[id]?.status === 'upkeep') enableRfid(id); });
          } else {
            disableAllRfid();
          }
        }
      },
    });

    if (['combat', 'upkeep'].includes(phase)) {
      actionDefs.push({ html: '<button id="gc-advance">Advance Phase</button>', id: 'gc-advance', fn: () => { this.advancePhase(); render(); persistState(); } });
    }

    if (phase === 'upkeep') {
      actionDefs.push({
        html: `<div class="gc-swatch-row">
          <span class="gc-swatch" style="background:${UPKEEP_GOLD}"></span>Money
          <span class="gc-swatch" style="background:${UPKEEP_PINK}"></span>Science
          <span class="gc-swatch" style="background:${UPKEEP_BROWN}"></span>Materials
        </div>`,
      });
    }
  }

  activatePlayer(hwid: string): void {
    if (state.eclipse.phase !== 'action') return;
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      const curr = state.boxes[state.activeBoxId];
      if (curr?.status === 'active' || curr?.status === 'reacting') curr.status = 'idle';
    }
    state.activeBoxId = hwid;
    const box = state.boxes[hwid];
    box.status = box.status === 'can-react' ? 'reacting' : 'active';
    disableAllRfid();
    enableRfid(hwid);
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  onPlayerRemoved(hwid: string): void {
    state.eclipse.passOrder    = state.eclipse.passOrder.filter(id => id !== hwid);
    state.eclipse.upkeepReady  = state.eclipse.upkeepReady.filter(id => id !== hwid);

    if (state.eclipse.firstPlayerId === hwid) {
      state.eclipse.firstPlayerId = state.boxOrder.find(id => id !== hwid) ?? null;
    }

    const wasActive = state.activeBoxId === hwid;

    if (state.eclipse.phase === 'action') {
      if (wasActive) {
        // Keep hwid in turnOrder so activateNext can find the correct next position,
        // then remove it. activateNext skips 'disconnected' boxes naturally.
        this.activateNext();
      } else if (this.isActionOver()) {
        this.endActionPhase();
      }
    }

    // Safe to remove from turn order now
    state.eclipse.turnOrder = state.eclipse.turnOrder.filter(id => id !== hwid);

    if (state.eclipse.phase === 'upkeep') {
      const allDone = state.boxOrder.every(id =>
        state.boxes[id].status === 'idle' || state.boxes[id].status === 'disconnected'
      );
      if (allDone) this.endRound();
    }
  }

  onResume(): void {
    if (state.eclipse.phase === 'upkeep') this.startUpkeepAnimation();
  }

  debugSkip(): void {
    const phase = state.eclipse.phase;
    log(`[DEBUG] Skipping Eclipse phase: ${phase}`, 'system');
    switch (phase) {
      case 'action': this.endActionPhase(); break;
      case 'combat': this.startUpkeep(); break;
      case 'upkeep': this.endRound(); break;
      default: log('[DEBUG] Unknown Eclipse phase', 'system');
    }
  }

  // ---- Private helpers ----

  private buildTurnOrder(firstPlayerId: string): void {
    if (state.eclipse.advancedOrder && state.eclipse.passOrder.length > 0) {
      state.eclipse.turnOrder = [...state.eclipse.passOrder];
    } else {
      const firstIndex = state.boxOrder.indexOf(firstPlayerId);
      state.eclipse.turnOrder = [
        ...state.boxOrder.slice(firstIndex),
        ...state.boxOrder.slice(0, firstIndex),
      ].filter(id => state.boxes[id].status !== 'disconnected');
    }
  }

  private activateNext(): void {
    const current = state.activeBoxId;
    const order = state.eclipse.turnOrder;
    const currentIndex = current !== null ? order.indexOf(current) : -1;

    for (let i = 1; i <= order.length; i++) {
      const nextIndex = (currentIndex + i) % order.length;
      const nextId = order[nextIndex];
      const status = state.boxes[nextId]?.status;

      if (status === 'idle') {
        if (current !== null && state.boxes[current]?.status === 'idle') {
          state.boxes[current].status = 'idle';
        }
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'active';
        log(`${getDisplayName(nextId)}'s turn`, 'system');
        this.syncActionRfid();
        return;
      }

      if (status === 'can-react') {
        if (current !== null && state.boxes[current]?.status === 'idle') {
          state.boxes[current].status = 'idle';
        }
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'reacting';
        log(`${getDisplayName(nextId)} reaction opportunity`, 'system');
        this.syncActionRfid();
        return;
      }
    }

    this.endActionPhase();
  }

  private syncActionRfid(): void {
    disableAllRfid();
    if (state.activeBoxId) enableRfid(state.activeBoxId);
  }

  private isActionOver(): boolean {
    return state.boxOrder.every(id =>
      state.boxes[id].status === 'can-react' ||
      state.boxes[id].status === 'passed' ||
      state.boxes[id].status === 'disconnected'
    );
  }

  private endActionPhase(): void {
    log('Action phase over — combat!', 'system');
    state.eclipse.phase = 'combat';
    startPhase('combat');
    disableAllRfid();
    state.activeBoxId = null;
    state.boxOrder.forEach(id => {
      if (state.boxes[id].status !== 'disconnected') state.boxes[id].status = 'combat';
    });
  }

  private upkeepReady(hwid: string, source: 'button' | 'tap'): void {
    if (state.eclipse.phase !== 'upkeep') return;
    const box = state.boxes[hwid];
    if (box?.status !== 'upkeep') return;

    if (source === 'button' && state.eclipse.tapToPass) {
      log(`${getDisplayName(hwid)}: tap your reaction card to mark upkeep done`, 'system');
      return;
    }

    if (state.eclipse.upkeepReady.includes(hwid)) return;
    state.eclipse.upkeepReady.push(hwid);
    box.status = 'idle';
    box.leds = null;
    if (!box.isVirtual) sendToBox(hwid, { type: 'led_anim_stop' });
    log(`${getDisplayName(hwid)} upkeep done`, 'system');

    const allDone = state.boxOrder.every(id =>
      state.boxes[id].status === 'idle' || state.boxes[id].status === 'disconnected'
    );
    if (allDone) this.endRound();
  }

  private startUpkeep(): void {
    log('Upkeep phase', 'system');
    state.eclipse.phase = 'upkeep';
    state.eclipse.upkeepReady = [];
    startPhase('upkeep');
    state.boxOrder.forEach(id => {
      if (state.boxes[id].status !== 'disconnected') state.boxes[id].status = 'upkeep';
    });
    if (state.eclipse.tapToPass) {
      disableAllRfid();
      state.boxOrder.forEach(id => { if (state.boxes[id]?.status === 'upkeep') enableRfid(id); });
    }
    this.startUpkeepAnimation();
  }

  private endRound(): void {
    this.stopUpkeepAnimation();
    state.boxOrder.forEach(id => { if (state.boxes[id]) state.boxes[id].leds = null; });
    state.round++;

    if (state.round > (state.totalRounds ?? Infinity)) {
      log(`Game over after ${state.totalRounds} rounds!`, 'system');
      endPhase();
      captureGameStats();
      state.gameActive = false;
      state.eclipse.phase = null;
      state.boxOrder.forEach(id => { state.boxes[id].status = 'idle'; state.boxes[id].factionId = null; });
      state.activeBoxId = null;
      (document.getElementById('start-btn') as HTMLButtonElement).disabled = false;
      render();
      return;
    }

    log(`Round ${state.round} begins`, 'system');
    state.eclipse.phase = 'action';
    startPhase('action');

    const nextFirst = state.eclipse.passOrder.length > 0
      ? state.eclipse.passOrder[0]
      : state.eclipse.firstPlayerId!;

    state.boxOrder.forEach(id => {
      if (state.boxes[id].status !== 'disconnected') state.boxes[id].status = 'idle';
    });

    state.activeBoxId = null;
    state.eclipse.firstPlayerId = nextFirst;
    this.buildTurnOrder(nextFirst);
    state.eclipse.passOrder = [];
    this.activateNext();
    log(`New round — ${getDisplayName(nextFirst)} goes first`, 'system');
  }

  // ---- Upkeep animation ----

  private buildUpkeepFrames(): { leds: string[]; duration: number; fade?: boolean }[] {
    const N = LED_COUNT;
    const T = N / 3;
    const OFF = '#000000';
    const frames: { leds: string[]; duration: number; fade?: boolean }[] = [];

    frames.push({ leds: Array(N).fill(OFF) as string[], duration: 100 });

    for (let i = 1; i <= T; i++) {
      const leds = Array(N).fill(OFF) as string[];
      for (let j = 0; j < i; j++) leds[j] = UPKEEP_GOLD;
      frames.push({ leds, duration: 100, fade: true });
    }

    const afterGold = Array(N).fill(OFF) as string[];
    for (let j = 0; j < T; j++) afterGold[j] = UPKEEP_GOLD;
    frames.push({ leds: [...afterGold], duration: 2000 });

    for (let i = 1; i <= T; i++) {
      const leds = [...afterGold];
      for (let j = 0; j < i; j++) leds[T + j] = UPKEEP_PINK;
      frames.push({ leds, duration: 100, fade: true });
    }
    const afterPink = [...afterGold];
    for (let j = 0; j < T; j++) afterPink[T + j] = UPKEEP_PINK;
    for (let i = 1; i <= T; i++) {
      const leds = [...afterPink];
      for (let j = 0; j < i; j++) leds[T * 2 + j] = UPKEEP_BROWN;
      frames.push({ leds, duration: 100, fade: true });
    }

    const full = [...afterGold];
    for (let j = 0; j < T; j++) { full[T + j] = UPKEEP_PINK; full[T * 2 + j] = UPKEEP_BROWN; }
    frames.push({ leds: full, duration: 5000 });

    return frames;
  }

  private startUpkeepAnimation(): void {
    this.stopUpkeepAnimation();
    this.upkeepAnimFrames = this.buildUpkeepFrames();

    // Send named animation command to real boxes (firmware generates frames on-device)
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (box?.status === 'upkeep' && !box.isVirtual) sendToBox(hwid, { type: 'led_anim_upkeep' });
    });

    // JS timer only drives virtual (sim) boxes for the browser UI
    const hasVirtual = state.boxOrder.some(hwid => state.boxes[hwid]?.status === 'upkeep' && state.boxes[hwid]?.isVirtual);
    if (!hasVirtual) return;

    let frameIndex = 0;
    const tick = () => {
      if (!state.gameActive || state.eclipse.phase !== 'upkeep') return;
      const { leds, duration } = this.upkeepAnimFrames[frameIndex];
      frameIndex = (frameIndex + 1) % this.upkeepAnimFrames.length;
      state.boxOrder.forEach(hwid => {
        const box = state.boxes[hwid];
        if (box?.status === 'upkeep' && box.isVirtual) box.leds = { type: 'led_raw', leds: leds.map(normalizeColor) };
      });
      render();
      this.upkeepAnimTimer = setTimeout(tick, duration);
    };
    tick();
  }

  private stopUpkeepAnimation(): void {
    if (this.upkeepAnimTimer !== null) {
      clearTimeout(this.upkeepAnimTimer);
      this.upkeepAnimTimer = null;
    }
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (box?.status === 'upkeep' && !box.isVirtual) sendToBox(hwid, { type: 'led_anim_stop' });
    });
  }
}

// Re-export for sim RFID
export function eclipseRelevantTags(hwid: string): Tag[] {
  const box = state.boxes[hwid];
  if (!box || !state.eclipse.tapToPass) return [];
  const factionTag: Tag[] = box.factionId
    ? [{ display: getDisplayName(hwid), id: `eclipse:faction:${box.factionId}` }]
    : [];
  if (state.eclipse.phase === 'action' && hwid === state.activeBoxId && box.status === 'active') return factionTag;
  if (state.eclipse.phase === 'upkeep' && box.status === 'upkeep') return factionTag;
  return [];
}

// Faction display helper (used by rfid.ts)
export function getFactionForBox(hwid: string) {
  const box = state.boxes[hwid];
  if (!box?.factionId || !state.factions) return null;
  const gameKey = state.gameMode === 'ti' ? 'twilight_imperium' : 'eclipse';
  return state.factions[gameKey as keyof typeof state.factions]?.find(f => f.id === box.factionId) ?? null;
}
