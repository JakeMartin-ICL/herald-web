import { state } from '../state';
import { log } from '../logger';
import { getDisplayName } from '../boxes';
import { render } from '../render';
import { startPhase, endPhase } from '../timers';
import { persistState } from '../persist';
import { syncDisplay } from '../display';
import {
  startGuidedPhase, advanceGuidedPhase, clearGuidedPhase,
  isGuidedPhaseActive, guidedPhaseProgress,
} from '../guided-phase';
import { enableRfid, disableAllRfid } from '../websockets';
import type { GameMode, Tag, ActionDef } from '../types';

const TURNS_PER_ROUND = 3;

function buildStatusSteps(disableObjectives: boolean): string[] {
  if (disableObjectives) {
    return [
      'Free advance',
      'Draw 1 Action card',
      'Raze size 1 city?',
      'Change government type?',
    ];
  }
  return [
    'Complete objectives',
    'Free advance',
    'Draw 1 Action card',
    'Draw 1 Objective card',
    'Raze size 1 city?',
    'Change government type?',
  ];
}

export class ClashOfCulturesMode implements GameMode {
  readonly id = 'coc';
  readonly scoreBreakdownCategories = [
    'Settlement/Buildings', 'Advances', 'Objectives', 'Wonders', 'Events', 'Leaders',
  ] as const;

  get turnOrder(): string[] { return state.coc.turnOrder; }
  set turnOrder(order: string[]) { state.coc.turnOrder = order; }

  start(): void {
    state.round = 1;
    state.coc.phase = null;
    state.coc.turnCounts = {};
    state.coc.turnOrder = [...state.boxOrder];
    state.boxOrder.forEach(hwid => { state.boxes[hwid].status = 'idle'; });
    log('Clash of Cultures started', 'system');
    this.beginFirstPlayerPhase();
  }

  onEndTurn(hwid: string): void {
    if (state.coc.phase === 'action') {
      if (hwid !== state.activeBoxId) return;
      state.coc.turnCounts[hwid] = (state.coc.turnCounts[hwid] ?? 0) + 1;
      const turns = state.coc.turnCounts[hwid];
      log(`${getDisplayName(hwid)} ends turn (${turns}/${TURNS_PER_ROUND})`, 'system');
      state.boxes[hwid].status = 'idle';
      this.activateNext(hwid);
      render();
      persistState();
    } else if (state.coc.phase === 'status') {
      if (hwid !== state.hubHwid) return;
      if (isGuidedPhaseActive()) {
        if (!advanceGuidedPhase()) {
          render();
          persistState();
          this.endStatusPhase();
        } else {
          render();
          persistState();
        }
      }
    }
  }

  onPass(_hwid: string): void { /* no-op */ }

  onLongPress(hwid: string): void {
    if (hwid !== state.hubHwid) return;
    if (state.coc.phase === 'status') {
      clearGuidedPhase();
      render();
      persistState();
      this.endStatusPhase();
    }
  }

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    state.coc.turnOrder = state.coc.turnOrder.map(boxId => (boxId === oldHwid ? newHwid : boxId));
    if (oldHwid in state.coc.turnCounts) {
      state.coc.turnCounts[newHwid] = state.coc.turnCounts[oldHwid];
      delete state.coc.turnCounts[oldHwid];
    }
  }

  onRfid(hwid: string, game: string, category: string, id: string): void {
    if (game !== 'coc' || category !== 'token' || id !== 'first_player') return;
    if (state.coc.phase !== 'first_player') return;
    disableAllRfid();
    this.reorderFromFirst(hwid);
    log(`${getDisplayName(hwid)} takes the first player marker`, 'system');
    state.boxOrder.forEach(h => {
      if (state.boxes[h]?.status !== 'disconnected') state.boxes[h].status = 'idle';
    });
    this.startActionPhase();
  }

  getRelevantTags(_hwid: string): Tag[] {
    if (state.coc.phase === 'first_player') {
      return [{ display: 'First Player', id: 'coc:token:first_player' }];
    }
    return [];
  }

  getBoxDisplay(_hwid: string): Record<string, unknown> | null {
    if (state.coc.phase === 'first_player') {
      return { name: 'First player', status: 'Tap marker' };
    }
    return null;
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.coc.phase;

    if (phase === 'first_player') {
      statusLines.push('Waiting for first player marker...');
    } else if (phase === 'action') {
      const activePlayers = state.boxOrder.filter(id => state.boxes[id]?.status !== 'disconnected');
      if (activePlayers.length > 0) {
        const minTurns = Math.min(...activePlayers.map(id => state.coc.turnCounts[id] ?? 0));
        statusLines.push(`Turn cycle: ${minTurns + 1} of ${TURNS_PER_ROUND}`);
      }
    } else if (phase === 'status') {
      if (isGuidedPhaseActive()) {
        statusLines.push(`Status phase — step ${guidedPhaseProgress()}`);
      } else {
        statusLines.push('Status phase — long press hub to finish');
      }
    }

    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-coc-advanced-order"${state.coc.advancedOrder ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Advanced turn order (dialog)</span>
      </label>`,
      id: 'gc-coc-advanced-order',
      event: 'change',
      fn: (e: Event) => {
        state.coc.advancedOrder = (e.target as HTMLInputElement).checked;
        log(`CoC advanced turn order ${state.coc.advancedOrder ? 'enabled' : 'disabled'}`, 'system');
      },
    });

    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-coc-no-objectives"${state.coc.disableObjectives ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Disable objectives</span>
      </label>`,
      id: 'gc-coc-no-objectives',
      event: 'change',
      fn: (e: Event) => {
        state.coc.disableObjectives = (e.target as HTMLInputElement).checked;
        log(`CoC objectives ${state.coc.disableObjectives ? 'disabled' : 'enabled'}`, 'system');
      },
    });
  }

  debugSkip(): void {
    if (state.coc.phase === 'first_player') {
      const first = state.coc.turnOrder.find(id => state.boxes[id]?.status !== 'disconnected');
      if (first) {
        disableAllRfid();
        this.reorderFromFirst(first);
        log(`[DEBUG] CoC: ${getDisplayName(first)} goes first`, 'system');
        state.boxOrder.forEach(h => {
          if (state.boxes[h]?.status !== 'disconnected') state.boxes[h].status = 'idle';
        });
        this.startActionPhase();
      }
    } else if (state.coc.phase === 'action') {
      log('[DEBUG] CoC: skipping to status phase', 'system');
      this.startStatusPhase();
    } else if (state.coc.phase === 'status') {
      log('[DEBUG] CoC: skipping status phase', 'system');
      clearGuidedPhase();
      render();
      persistState();
      this.endStatusPhase();
    }
    render();
    persistState();
  }

  onPlayerRemoved(hwid: string): void {
    state.coc.turnOrder = state.coc.turnOrder.filter(id => id !== hwid);
    delete state.coc.turnCounts[hwid];

    if (state.coc.phase === 'action') {
      if (state.activeBoxId === hwid) {
        this.activateNext(hwid);
      } else if (this.isActionPhaseOver()) {
        this.startStatusPhase();
      }
    }
  }

  activatePlayer(hwid: string): void {
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  syncRfid(): void {
    if (state.coc.phase === 'first_player') {
      state.boxOrder.forEach(hwid => {
        const box = state.boxes[hwid];
        if (!box || box.isVirtual || box.status === 'disconnected') return;
        enableRfid(hwid);
      });
    }
  }

  onResume(): void {
    this.syncRfid();
  }

  // ---- Private helpers ----

  private beginFirstPlayerPhase(): void {
    if (state.coc.advancedOrder) {
      void import('../reorderDialog').then(({ openReorderDialog }) => {
        openReorderDialog(() => this.startActionPhase());
      });
    } else {
      this.enterFirstPlayerScan();
    }
  }

  private enterFirstPlayerScan(): void {
    state.coc.phase = 'first_player';
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.isVirtual || box.status === 'disconnected') return;
      enableRfid(hwid);
    });
    log('Waiting for first player marker...', 'system');
    syncDisplay();
    render();
    persistState();
  }

  private startActionPhase(): void {
    state.coc.phase = 'action';
    startPhase('action');
    state.coc.turnCounts = {};
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') state.boxes[hwid].status = 'idle';
    });
    log(`Round ${state.round} — action phase (${TURNS_PER_ROUND} turns each)`, 'system');

    const first = state.coc.turnOrder.find(id => state.boxes[id]?.status === 'idle');
    if (first) {
      state.activeBoxId = first;
      state.boxes[first].status = 'active';
      log(`${getDisplayName(first)}'s turn`, 'system');
    }
    render();
    persistState();
  }

  private startStatusPhase(): void {
    state.coc.phase = 'status';
    startPhase('status');
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') state.boxes[hwid].status = 'status';
    });
    startGuidedPhase(buildStatusSteps(state.coc.disableObjectives));
    log('Status phase — hub end turn to advance steps, long press to skip', 'system');
    render();
    persistState();
  }

  private endStatusPhase(): void {
    endPhase();
    state.round++;
    if (state.coc.advancedOrder) {
      void import('../reorderDialog').then(({ openReorderDialog }) => {
        openReorderDialog(() => this.startActionPhase());
      });
    } else {
      this.enterFirstPlayerScan();
    }
  }

  private isActionPhaseOver(): boolean {
    return state.boxOrder.every(hwid =>
      state.boxes[hwid]?.status === 'disconnected' ||
      (state.coc.turnCounts[hwid] ?? 0) >= TURNS_PER_ROUND
    );
  }

  private activateNext(fromHwid: string): void {
    const order = state.coc.turnOrder;
    const currentIndex = order.indexOf(fromHwid);

    for (let i = 1; i <= order.length; i++) {
      const nextIndex = (currentIndex + i) % order.length;
      const nextId = order[nextIndex];
      const box = state.boxes[nextId];
      if (box?.status === 'disconnected') continue;
      if ((state.coc.turnCounts[nextId] ?? 0) < TURNS_PER_ROUND) {
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'active';
        log(`${getDisplayName(nextId)}'s turn`, 'system');
        return;
      }
    }

    this.startStatusPhase();
  }

  private reorderFromFirst(firstHwid: string): void {
    const order = state.boxOrder.filter(id => state.boxes[id]?.status !== 'disconnected');
    const idx = order.indexOf(firstHwid);
    if (idx === -1) {
      state.coc.turnOrder = order;
      return;
    }
    state.coc.turnOrder = [...order.slice(idx), ...order.slice(0, idx)];
  }
}
