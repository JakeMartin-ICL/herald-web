import { state } from '../state';
import { log } from '../logger';
import { getDisplayName } from '../boxes';
import { render } from '../render';
import { startPhase } from '../timers';
import { persistState } from '../persist';
import { disableAllRfid } from '../websockets';
import { isHubOrSim } from './helpers';
import type { ActionDef, GameMode, LedCommand, Tag } from '../types';

type DunePhase = NonNullable<typeof state.duneImperium.phase>;

const PHASE_LABELS: Record<DunePhase, string> = {
  action: 'Action',
  combat: 'Combat',
  makers: 'Makers',
  recall: 'Recall',
};

export class DuneImperiumMode implements GameMode {
  readonly id = 'dune_imperium';

  get turnOrder(): string[] { return state.duneImperium.turnOrder; }
  set turnOrder(order: string[]) { state.duneImperium.turnOrder = order; }

  getTableLabel(): string {
    const phase = state.duneImperium.phase;
    return phase ? `DUNE: IMPERIUM - ${PHASE_LABELS[phase].toUpperCase()}` : 'DUNE: IMPERIUM';
  }

  getLedForStatus(status: string): LedCommand | null {
    switch (status) {
      case 'combat':
        return { type: 'led_solid', color: '#ff0000' };
      case 'makers':
        return { type: 'led_anim_spinner', color: '#ff8c00', rainbow: false, stepMs: 55, fadeMs: 20 };
      case 'recall':
        return { type: 'led_solid', color: '#00c853' };
      default:
        return null;
    }
  }

  start(): void {
    state.round = 1;
    state.duneImperium.phase = null;
    state.duneImperium.turnOrder = [...state.boxOrder];
    state.duneImperium.firstPlayerId = this.firstAvailablePlayer();
    state.boxOrder.forEach(hwid => { state.boxes[hwid].status = 'idle'; });
    log('Dune: Imperium started', 'system');
    this.startActionPhase();
  }

  onEndTurn(hwid: string): void {
    const phase = state.duneImperium.phase;
    if (phase === 'action') {
      if (hwid !== state.activeBoxId) return;
      state.boxes[hwid].status = 'idle';
      this.activateNext(hwid);
      render();
      persistState();
      return;
    }

    if (!isHubOrSim(hwid)) return;
    if (phase === 'combat') this.startStatusPhase('makers');
    else if (phase === 'makers') this.startStatusPhase('recall');
    else if (phase === 'recall') this.startNextRound();
  }

  onPass(hwid: string): void {
    if (state.duneImperium.phase !== 'action') return;
    if (hwid !== state.activeBoxId) return;
    state.boxes[hwid].status = 'passed';
    log(`${getDisplayName(hwid)} passes`, 'system');
    this.activateNext(hwid);
  }

  onLongPress(_hwid: string): void { /* no-op */ }

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    state.duneImperium.turnOrder = state.duneImperium.turnOrder.map(id => id === oldHwid ? newHwid : id);
    if (state.duneImperium.firstPlayerId === oldHwid) state.duneImperium.firstPlayerId = newHwid;
  }

  onPlayerRemoved(hwid: string): void {
    if (state.activeBoxId === hwid && state.duneImperium.phase === 'action') {
      this.activateNext(hwid);
    }
    state.duneImperium.turnOrder = state.duneImperium.turnOrder.filter(id => id !== hwid);
    if (state.duneImperium.firstPlayerId === hwid) {
      state.duneImperium.firstPlayerId = this.firstAvailablePlayer();
    }
  }

  activatePlayer(hwid: string): void {
    if (state.duneImperium.phase !== 'action') return;
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  getRelevantTags(_hwid: string): Tag[] { return []; }

  getBoxDisplay(_hwid: string): Record<string, unknown> | null {
    const phase = state.duneImperium.phase;
    if (phase === 'combat' || phase === 'makers' || phase === 'recall') {
      return { name: PHASE_LABELS[phase], status: 'Hub End to advance' };
    }
    return null;
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.duneImperium.phase;
    if (phase === 'action') {
      const first = state.duneImperium.firstPlayerId;
      if (first) statusLines.push(`First player: ${getDisplayName(first)}`);
      const passed = state.duneImperium.turnOrder.filter(id => state.boxes[id]?.status === 'passed').length;
      if (passed > 0) statusLines.push(`${passed} player${passed === 1 ? '' : 's'} passed`);
      return;
    }

    if (phase === 'combat' || phase === 'makers' || phase === 'recall') {
      statusLines.push(`${PHASE_LABELS[phase]} phase - hub End Turn advances`);
      actionDefs.push({
        html: '<button id="gc-dune-advance">Advance Phase</button>',
        id: 'gc-dune-advance',
        fn: () => {
          this.advanceStatusPhase();
          render();
          persistState();
        },
      });
    }
  }

  debugSkip(): void {
    const phase = state.duneImperium.phase;
    log(`[DEBUG] Dune: skipping ${phase ?? 'unknown'} phase`, 'system');
    if (phase === 'action') this.startStatusPhase('combat');
    else this.advanceStatusPhase();
  }

  onResume(): void {
    disableAllRfid();
  }

  private startActionPhase(): void {
    state.duneImperium.phase = 'action';
    startPhase('action');
    state.activeBoxId = null;
    disableAllRfid();
    state.duneImperium.turnOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') state.boxes[hwid].status = 'idle';
    });

    const first = state.duneImperium.firstPlayerId ?? this.firstAvailablePlayer();
    state.duneImperium.firstPlayerId = first;
    if (first) {
      state.activeBoxId = first;
      state.boxes[first].status = 'active';
      log(`Round ${state.round} - ${getDisplayName(first)} starts`, 'system');
    }
    render();
    persistState();
  }

  private startStatusPhase(phase: Exclude<DunePhase, 'action'>): void {
    state.duneImperium.phase = phase;
    startPhase(phase);
    state.activeBoxId = null;
    disableAllRfid();
    state.duneImperium.turnOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') state.boxes[hwid].status = phase;
    });
    log(`${PHASE_LABELS[phase]} phase`, 'system');
    render();
    persistState();
  }

  private startNextRound(): void {
    state.round++;
    state.duneImperium.firstPlayerId = this.nextFirstPlayer();
    this.startActionPhase();
  }

  private advanceStatusPhase(): void {
    const phase = state.duneImperium.phase;
    if (phase === 'combat') this.startStatusPhase('makers');
    else if (phase === 'makers') this.startStatusPhase('recall');
    else if (phase === 'recall') this.startNextRound();
  }

  private activateNext(fromHwid: string): void {
    const order = state.duneImperium.turnOrder;
    const currentIndex = order.indexOf(fromHwid);

    for (let i = 1; i <= order.length; i++) {
      const nextIndex = ((currentIndex === -1 ? 0 : currentIndex) + i) % order.length;
      const nextId = order[nextIndex];
      if (state.boxes[nextId]?.status === 'idle') {
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'active';
        log(`${getDisplayName(nextId)}'s turn`, 'system');
        return;
      }
    }

    log('Action phase over - combat!', 'system');
    this.startStatusPhase('combat');
  }

  private firstAvailablePlayer(): string | null {
    return state.duneImperium.turnOrder.find(id => state.boxes[id]?.status !== 'disconnected') ?? null;
  }

  private nextFirstPlayer(): string | null {
    const order = state.duneImperium.turnOrder;
    if (order.length === 0) return null;
    const previous = state.duneImperium.firstPlayerId;
    const start = previous ? order.indexOf(previous) : -1;
    for (let i = 1; i <= order.length; i++) {
      const candidate = order[((start === -1 ? 0 : start) + i) % order.length];
      if (state.boxes[candidate]?.status !== 'disconnected') return candidate;
    }
    return null;
  }
}
