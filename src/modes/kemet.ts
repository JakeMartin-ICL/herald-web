import { state } from '../state';
import { log } from '../logger';
import { getDisplayName } from '../boxes';
import { render } from '../render';
import { startPhase } from '../timers';
import { persistState } from '../persist';
import {
  startGuidedPhase, advanceGuidedPhase, clearGuidedPhase,
  isGuidedPhaseActive, guidedPhaseProgress,
} from '../guided-phase';
import { isHubOrSim } from './helpers';
import type { GameMode, Tag, ActionDef } from '../types';

const KEMET_NIGHT_STEPS = [
  'Sanctuary: 2 units -> 1FP',
  'Delta Temple: 1 unit -> 5PP',
  'Temple control: 2 -> 1FP',
  'Temple PP',
  'Gain 2 PP',
  'Gain 1 DI',
  'Spend veteran tokens',
  'Return action tokens',
  'Turn order',
];

export class KemetMode implements GameMode {
  readonly id = 'kemet';

  get turnOrder(): string[] { return state.kemet.turnOrder; }
  set turnOrder(order: string[]) { state.kemet.turnOrder = order; }

  start(): void {
    state.round = 1;
    state.kemet.phase = null;
    state.kemet.turnCounts = {};
    state.kemet.turnsPerRound = 5;
    state.kemet.turnOrder = [...state.boxOrder];
    state.boxOrder.forEach(hwid => { state.boxes[hwid].status = 'idle'; });

    log('Kemet started — set turn order to begin', 'system');

    void import('../reorderDialog').then(({ openReorderDialog }) => {
      openReorderDialog(() => this.startActionPhase());
    });
  }

  onEndTurn(hwid: string): void {
    if (state.kemet.phase === 'action') {
      if (hwid !== state.activeBoxId) return;
      state.kemet.turnCounts[hwid] = (state.kemet.turnCounts[hwid] ?? 0) + 1;
      const turns = state.kemet.turnCounts[hwid];
      log(`${getDisplayName(hwid)} ends turn (${turns}/${state.kemet.turnsPerRound})`, 'system');
      state.boxes[hwid].status = 'idle';

      if (this.isActionPhaseOver()) {
        this.startNightPhase();
      } else {
        this.activateNext(hwid);
      }
      render();
      persistState();
    } else if (state.kemet.phase === 'night') {
      if (!isHubOrSim(hwid)) return;
      if (isGuidedPhaseActive()) {
        if (!advanceGuidedPhase()) {
          render();
          persistState();
          this.openReorderForNextRound();
        } else {
          render();
          persistState();
        }
      }
    }
  }

  onPass(_hwid: string): void { /* no-op */ }

  onLongPress(hwid: string): void {
    if (!isHubOrSim(hwid)) return;
    if (state.kemet.phase === 'night') {
      clearGuidedPhase();
      render();
      persistState();
      this.openReorderForNextRound();
    }
  }

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    state.kemet.turnOrder = state.kemet.turnOrder.map(boxId => (boxId === oldHwid ? newHwid : boxId));
    if (oldHwid in state.kemet.turnCounts) {
      state.kemet.turnCounts[newHwid] = state.kemet.turnCounts[oldHwid];
      delete state.kemet.turnCounts[oldHwid];
    }
  }

  getRelevantTags(_hwid: string): Tag[] { return []; }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.kemet.phase;

    if (phase === null) {
      statusLines.push('Set turn order to begin');
      actionDefs.push({
        html: '<button id="gc-set-order">Set Turn Order</button>',
        id: 'gc-set-order',
        fn: () => {
          void import('../reorderDialog').then(({ openReorderDialog }) => {
            openReorderDialog(() => this.startActionPhase());
          });
        },
      });
      return;
    }

    if (phase === 'action') {
      const activePlayers = state.boxOrder.filter(id => state.boxes[id]?.status !== 'disconnected');
      if (activePlayers.length > 0) {
        const minTurns = Math.min(...activePlayers.map(id => state.kemet.turnCounts[id] ?? 0));
        statusLines.push(`Turn cycle: ${minTurns + 1} of ${state.kemet.turnsPerRound}`);
      }
    }

    if (phase === 'night') {
      if (isGuidedPhaseActive()) {
        statusLines.push(`Night phase — step ${guidedPhaseProgress()}`);
      } else {
        statusLines.push('Night phase — long press hub to set turn order');
      }
    }

    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-guided-night"${state.kemet.guidedNightPhase ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Guided night phase</span>
      </label>`,
      id: 'gc-guided-night',
      event: 'change',
      fn: (e: Event) => {
        state.kemet.guidedNightPhase = (e.target as HTMLInputElement).checked;
        log(`Guided night phase ${state.kemet.guidedNightPhase ? 'enabled' : 'disabled'}`, 'system');
      },
    });
  }

  debugSkip(): void {
    if (state.kemet.phase === 'action') {
      log('[DEBUG] Kemet: skipping to night phase', 'system');
      this.startNightPhase();
    } else if (state.kemet.phase === 'night') {
      log('[DEBUG] Kemet: skipping night phase', 'system');
      clearGuidedPhase();
      render();
      persistState();
      this.openReorderForNextRound();
    }
  }

  onPlayerRemoved(hwid: string): void {
    if (state.kemet.phase === 'action') {
      if (state.activeBoxId === hwid) {
        this.activateNext(hwid);
      }
      if (this.isActionPhaseOver()) {
        this.startNightPhase();
        return;
      }
    }
    state.kemet.turnOrder = state.kemet.turnOrder.filter(id => id !== hwid);
    delete state.kemet.turnCounts[hwid];
  }

  activatePlayer(hwid: string): void {
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  // ---- Private helpers ----

  private startActionPhase(): void {
    state.kemet.phase = 'action';
    startPhase('action');
    state.kemet.turnCounts = {};
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid].status !== 'disconnected') state.boxes[hwid].status = 'idle';
    });
    log(`Round ${state.round} — action phase (${state.kemet.turnsPerRound} turns each)`, 'system');

    const first = state.kemet.turnOrder.find(id => state.boxes[id]?.status === 'idle');
    if (first) {
      state.activeBoxId = first;
      state.boxes[first].status = 'active';
      log(`${getDisplayName(first)}'s turn`, 'system');
    }
    render();
    persistState();
  }

  private startNightPhase(): void {
    state.kemet.phase = 'night';
    startPhase('night');
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid].status !== 'disconnected') state.boxes[hwid].status = 'status';
    });

    if (state.kemet.guidedNightPhase) {
      startGuidedPhase(KEMET_NIGHT_STEPS);
      log('Night phase — hub end turn to advance steps, long press to skip', 'system');
    } else {
      log('Night phase — long press hub to set turn order', 'system');
    }
    render();
    persistState();
  }

  private openReorderForNextRound(): void {
    void import('../reorderDialog').then(({ openReorderDialog }) => {
      openReorderDialog(() => {
        state.round++;
        this.startActionPhase();
      });
    });
  }

  private isActionPhaseOver(): boolean {
    return state.boxOrder.every(hwid =>
      state.boxes[hwid].status === 'disconnected' ||
      (state.kemet.turnCounts[hwid] ?? 0) >= state.kemet.turnsPerRound
    );
  }

  private activateNext(fromHwid: string): void {
    const order = state.kemet.turnOrder;
    const maxTurns = state.kemet.turnsPerRound;
    const currentIndex = order.indexOf(fromHwid);

    for (let i = 1; i <= order.length; i++) {
      const nextIndex = (currentIndex + i) % order.length;
      const nextId = order[nextIndex];
      const box = state.boxes[nextId];
      if (box?.status === 'disconnected') continue;
      if ((state.kemet.turnCounts[nextId] ?? 0) < maxTurns) {
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'active';
        log(`${getDisplayName(nextId)}'s turn`, 'system');
        return;
      }
    }

    // All players done
    this.startNightPhase();
  }
}
