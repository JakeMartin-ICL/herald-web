import { state } from '../state';
import { log } from '../logger';
import { disableAllRfid } from '../websockets';
import { getDisplayName } from '../boxes';
import { render } from '../render';
import { startPhase } from '../timers';
import { persistState } from '../persist';
import type { GameMode, Tag, ActionDef } from '../types';

abstract class ClockwiseBase implements GameMode {
  abstract readonly id: string;

  turnOrder: string[] = [];

  start(): void {
    this.turnOrder = [...state.boxOrder];
    state.round = 1;
    startPhase('round');
    this.turnOrder.forEach(hwid => { state.boxes[hwid].status = 'idle'; });
    this.activateFirst();
    log(`Round 1 started`, 'system');
  }

  private activateFirst(): void {
    const first = this.turnOrder.find(id => state.boxes[id]?.status === 'idle');
    if (first) {
      state.activeBoxId = first;
      state.boxes[first].status = 'active';
    }
  }

  onEndTurn(hwid: string): void {
    if (hwid !== state.activeBoxId) return;
    state.boxes[hwid].status = 'idle';
    this.activateNext(hwid);
  }

  onPass(_hwid: string): void { /* no-op for base clockwise */ }

  onLongPress(_hwid: string): void { /* no-op */ }

  getRelevantTags(_hwid: string): Tag[] { return []; }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    if (!state.activeBoxId) {
      statusLines.push('Round over — all passed');
      actionDefs.push({
        html: '<button id="gc-new-round">New Round</button>',
        id: 'gc-new-round',
        fn: () => { this.newRound(); render(); },
      });
    }
  }

  onPlayerRemoved(hwid: string): void {
    if (state.activeBoxId === hwid) {
      this.activateNext(hwid); // hwid still in this.turnOrder for position lookup
    }
    this.turnOrder = this.turnOrder.filter(id => id !== hwid);
  }

  activatePlayer(hwid: string): void {
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  debugSkip(): void { /* no-op */ }

  protected activateNext(fromHwid: string): void {
    const order = this.turnOrder;
    const currentIndex = order.indexOf(fromHwid);

    for (let i = 1; i <= order.length; i++) {
      const nextIndex = (currentIndex + i) % order.length;
      const nextId = order[nextIndex];

      if (state.boxes[nextId]?.status === 'idle') {
        if (nextIndex === 0 && this.id === 'clockwise') {
          state.round++;
          startPhase('round');
        }
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'active';
        log(`${getDisplayName(nextId)}'s turn`, 'system');
        return;
      }
    }

    // All passed
    state.activeBoxId = null;
    disableAllRfid();
    log('Round over — all passed', 'system');
  }

  private newRound(): void {
    state.round++;
    startPhase('round');
    this.turnOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (box && box.status !== 'disconnected') box.status = 'idle';
    });
    const first = this.turnOrder.find(id => state.boxes[id]?.status === 'idle');
    if (first) {
      state.activeBoxId = first;
      state.boxes[first].status = 'active';
    }
    log(`Round ${state.round} started`, 'system');
    persistState();
  }
}

export class ClockwiseMode extends ClockwiseBase {
  readonly id = 'clockwise';
}

export class ClockwisePassMode extends ClockwiseBase {
  readonly id = 'clockwise_pass';

  onPass(hwid: string): void {
    if (hwid !== state.activeBoxId) return;
    state.boxes[hwid].status = 'passed';
    log(`${getDisplayName(hwid)} passes`, 'system');
    this.activateNext(hwid);
  }
}
