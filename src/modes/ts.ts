import { state } from '../state';
import { log } from '../logger';
import { getDisplayName, getFactionForBox } from '../boxes';
import { render, endGame } from '../render';
import { startPhase } from '../timers';
import { persistState } from '../persist';
import { startGuidedPhase, advanceGuidedPhase, clearGuidedPhase, currentGuidedStep, guidedPhaseProgress, isGuidedPhaseActive } from '../guided-phase';
import type { ActionDef, Box, GameMode, LedCommand, StartValidationResult, Tag } from '../types';

const HEADLINE_SPINNER: LedCommand = {
  type: 'led_anim_spinner',
  color: '#ffffff',
  rainbow: false,
  stepMs: 90,
  fadeMs: 25,
};

const HEADLINE_READY: LedCommand = {
  type: 'led_alternate_pair',
  a: '#ffffff',
  b: '#000000',
};

const RESOLVE_HEADLINES: LedCommand = {
  type: 'led_alternate_pair',
  a: '#cc2222',
  b: '#000000',
};

const DEFCON_WARNING: LedCommand = {
  type: 'led_sectors',
  sectors: [
    { color: '#ffd400', count: 2 },
    { color: '#000000', count: 4 },
    { color: '#ffd400', count: 4 },
    { color: '#000000', count: 4 },
    { color: '#ffd400', count: 4 },
    { color: '#000000', count: 4 },
    { color: '#ffd400', count: 2 },
  ],
};

export class TwilightStruggleMode implements GameMode {
  readonly id = 'twilight_struggle';

  get turnOrder(): string[] { return state.ts.turnOrder; }
  set turnOrder(order: string[]) { state.ts.turnOrder = order; }

  getTableLabel(): string {
    switch (state.ts.phase) {
      case 'headline': return 'TS — HEADLINE';
      case 'resolve_headlines': return 'TS — RESOLVE HEADLINES';
      case 'action': return 'TS — ACTION';
      case 'status': return 'TS — STATUS';
      default: return 'TWILIGHT STRUGGLE';
    }
  }

  getStartValidation(): StartValidationResult {
    if (state.boxOrder.length !== 2) {
      return { valid: false, reason: 'Twilight Struggle requires exactly 2 players' };
    }

    const factions = state.boxOrder.map(hwid => state.boxes[hwid]?.factionId ?? null);
    const hasUs = factions.includes('us');
    const hasUssr = factions.includes('ussr');
    if (!hasUs || !hasUssr) {
      return { valid: false, reason: 'Assign USSR and US factions before starting Twilight Struggle' };
    }

    return { valid: true };
  }

  disableNewPlayerMidGame(): boolean {
    return true;
  }

  getLedForStatus(status: string, _box: Box | null, _hwid: string | null): LedCommand | null {
    if (status === 'status' && state.ts.phase === 'status' && currentGuidedStep() === 'Improve DEFCON') {
      return DEFCON_WARNING;
    }
    return null;
  }

  start(): void {
    this.turnOrder = this.buildFactionTurnOrder();
    state.round = 1;
    state.totalRounds = 10;
    state.ts.actionTurnsTaken = {};
    state.ts.headlineReady = [];
    clearGuidedPhase();
    this.startHeadlinePhase();
    log(`Twilight Struggle started — ${getDisplayName(this.turnOrder[0])} (USSR) goes first`, 'system');
  }

  onEndTurn(hwid: string): void {
    switch (state.ts.phase) {
      case 'headline':
        this.markHeadlineReady(hwid);
        break;
      case 'resolve_headlines':
        if (this.canAdvanceHubGatedPhase(hwid)) this.startActionPhase();
        break;
      case 'action':
        this.finishActionTurn(hwid);
        break;
      case 'status':
        if (this.canAdvanceHubGatedPhase(hwid)) this.advanceStatusPhase();
        break;
    }
  }

  onPass(_hwid: string): void { /* no-op */ }

  onLongPress(_hwid: string): void { /* no-op */ }

  getRelevantTags(_hwid: string): Tag[] { return []; }

  getBoxDisplay(hwid: string): Record<string, unknown> | null {
    if (state.ts.phase !== 'action') return null;
    const turnsPerRound = this.getTurnsPerRound();
    const turnsTaken = state.ts.actionTurnsTaken[hwid] ?? 0;
    const displayTurn = hwid === state.activeBoxId ? turnsTaken + 1 : turnsTaken;
    return {
      name: getDisplayName(hwid),
      status: `${displayTurn}/${turnsPerRound}`,
    };
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    switch (state.ts.phase) {
      case 'headline':
        statusLines.push(`Headline phase — ${state.ts.headlineReady.length}/2 ready`);
        break;
      case 'resolve_headlines':
        statusLines.push('Resolve headlines — hub press End to continue');
        break;
      case 'action':
        statusLines.push(`Action phase — ${this.getActionRoundLabel()}`);
        break;
      case 'status':
        if (isGuidedPhaseActive()) {
          statusLines.push(`Status phase — step ${guidedPhaseProgress()}`);
        }
        break;
    }

    if (state.ts.phase === 'action' && state.activeBoxId) {
      actionDefs.push({
        html: `<div class="gc-secondary-row"><span>Current:</span><span>${getDisplayName(state.activeBoxId)} (${this.getActionRoundLabel()})</span></div>`,
      });
    }
  }

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    const replaceBoxId = (boxId: string) => (boxId === oldHwid ? newHwid : boxId);
    state.ts.turnOrder = state.ts.turnOrder.map(replaceBoxId);
    state.ts.headlineReady = state.ts.headlineReady.map(replaceBoxId);
    if (oldHwid in state.ts.actionTurnsTaken) {
      state.ts.actionTurnsTaken[newHwid] = state.ts.actionTurnsTaken[oldHwid];
      delete state.ts.actionTurnsTaken[oldHwid];
    }
  }

  onPlayerRemoved(hwid: string): void {
    state.ts.turnOrder = state.ts.turnOrder.filter(id => id !== hwid);
    state.ts.headlineReady = state.ts.headlineReady.filter(id => id !== hwid);
    delete state.ts.actionTurnsTaken[hwid];
    if (state.activeBoxId === hwid) state.activeBoxId = null;
  }

  debugSkip(): void {
    switch (state.ts.phase) {
      case 'headline':
        this.startResolveHeadlines();
        break;
      case 'resolve_headlines':
        this.startActionPhase();
        break;
      case 'action':
        this.startStatusPhase();
        break;
      case 'status':
        this.advanceStatusPhase();
        break;
    }
    render();
    persistState();
  }

  private buildFactionTurnOrder(): string[] {
    const ussr = state.boxOrder.find(hwid => getFactionForBox(hwid)?.id === 'ussr');
    const us = state.boxOrder.find(hwid => getFactionForBox(hwid)?.id === 'us');
    return [ussr, us].filter((hwid): hwid is string => !!hwid);
  }

  private startHeadlinePhase(): void {
    state.ts.phase = 'headline';
    state.ts.headlineReady = [];
    state.activeBoxId = null;
    startPhase('headline');
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.status === 'disconnected') return;
      box.status = 'idle';
      box.leds = HEADLINE_SPINNER;
    });
    log(`Round ${state.round} — headline phase`, 'system');
  }

  private markHeadlineReady(hwid: string): void {
    if (!state.ts.turnOrder.includes(hwid)) return;
    if (state.ts.headlineReady.includes(hwid)) return;
    state.ts.headlineReady.push(hwid);
    state.boxes[hwid].leds = HEADLINE_READY;
    log(`${getDisplayName(hwid)} is ready to resolve headlines`, 'system');
    if (state.ts.headlineReady.length === state.ts.turnOrder.length) {
      this.startResolveHeadlines();
    }
  }

  private startResolveHeadlines(): void {
    state.ts.phase = 'resolve_headlines';
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.status === 'disconnected') return;
      box.status = 'idle';
      box.leds = RESOLVE_HEADLINES;
    });
    log('Resolve headlines — hub press End to continue', 'system');
  }

  private startActionPhase(): void {
    state.ts.phase = 'action';
    state.ts.actionTurnsTaken = Object.fromEntries(state.ts.turnOrder.map(hwid => [hwid, 0]));
    startPhase('action');
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.status === 'disconnected') return;
      box.status = 'idle';
      box.leds = null;
    });
    this.activateActionPlayer(state.ts.turnOrder[0] ?? null);
    log(`Action phase — ${this.getActionRoundLabel()}`, 'system');
  }

  private finishActionTurn(hwid: string): void {
    if (hwid !== state.activeBoxId) return;
    state.ts.actionTurnsTaken[hwid] = (state.ts.actionTurnsTaken[hwid] ?? 0) + 1;
    state.boxes[hwid].status = 'idle';
    if (this.isActionPhaseComplete()) {
      this.startStatusPhase();
      return;
    }
    this.activateNextActionPlayer(hwid);
  }

  private activateNextActionPlayer(fromHwid: string): void {
    const order = state.ts.turnOrder;
    const currentIndex = order.indexOf(fromHwid);
    for (let step = 1; step <= order.length; step++) {
      const nextId = order[(currentIndex + step) % order.length];
      if (!nextId) continue;
      if ((state.ts.actionTurnsTaken[nextId] ?? 0) >= this.getTurnsPerRound()) continue;
      if (state.boxes[nextId]?.status === 'disconnected') continue;
      this.activateActionPlayer(nextId);
      return;
    }
    this.startStatusPhase();
  }

  private activateActionPlayer(hwid: string | null): void {
    state.activeBoxId = hwid;
    if (!hwid) return;
    state.boxes[hwid].status = 'active';
    log(`${getDisplayName(hwid)}'s turn (${this.getPlayerDisplayTurn(hwid)}/${this.getTurnsPerRound()})`, 'system');
  }

  private startStatusPhase(): void {
    state.ts.phase = 'status';
    state.activeBoxId = null;
    startPhase('status');
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.status === 'disconnected') return;
      box.status = 'status';
      box.leds = null;
    });
    startGuidedPhase(this.getStatusSteps());
    log('Status phase — hub press End to advance', 'system');
  }

  private advanceStatusPhase(): void {
    if (isGuidedPhaseActive() && advanceGuidedPhase()) return;
    clearGuidedPhase();
    if (state.round >= 10) {
      endGame();
      return;
    }
    state.round++;
    this.startHeadlinePhase();
  }

  private getTurnsPerRound(): number {
    return state.round <= 3 ? 6 : 7;
  }

  private isActionPhaseComplete(): boolean {
    const turnsPerRound = this.getTurnsPerRound();
    return state.ts.turnOrder.every(hwid => (state.ts.actionTurnsTaken[hwid] ?? 0) >= turnsPerRound);
  }

  private getPlayerDisplayTurn(hwid: string): number {
    const turnsTaken = state.ts.actionTurnsTaken[hwid] ?? 0;
    return hwid === state.activeBoxId ? turnsTaken + 1 : turnsTaken;
  }

  private getActionRoundLabel(): string {
    const activeHwid = state.activeBoxId ?? state.ts.turnOrder[0] ?? null;
    const currentTurn = activeHwid ? this.getPlayerDisplayTurn(activeHwid) : 0;
    return `${currentTurn}/${this.getTurnsPerRound()}`;
  }

  private getStatusSteps(): string[] {
    if (state.round >= 10) {
      return ['Check military ops', 'Flip China card', 'Final scoring'];
    }
    const dealCount = state.round <= 3 ? 8 : 9;
    return [
      'Check military ops',
      'Flip China card',
      'Advance Turn Marker',
      'Improve DEFCON',
      `Deal up to ${dealCount} cards`,
    ];
  }

  private canAdvanceHubGatedPhase(hwid: string): boolean {
    return hwid === state.hubHwid || !!state.boxes[hwid]?.isVirtual;
  }
}
