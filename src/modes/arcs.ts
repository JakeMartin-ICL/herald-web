import { state } from '../state';
import { log } from '../logger';
import { getDisplayName, setBoxBadges } from '../boxes';
import { render } from '../render';
import { startPhase, endPhase } from '../timers';
import { persistState } from '../persist';
import { syncDisplay } from '../display';
import { syncLeds, resetActiveAnim } from '../leds';
import { enableRfid, disableRfid, disableAllRfid, sendToBox } from '../websockets';
import type { GameMode, Tag, ActionDef } from '../types';

const CYCLE_END_FLASH_COLOR = '#0044ff';
const CYCLE_END_FLASH_MS = 500;
const INITIATIVE_FLASH_COLOR = '#ffd700';
const INITIATIVE_FLASH_MS = 400;

export class ArcsMode implements GameMode {
  readonly id = 'arcs';

  get turnOrder(): string[] { return state.arcs.turnOrder; }
  set turnOrder(order: string[]) { state.arcs.turnOrder = order; }

  start(): void {
    state.round = 1;
    state.arcs.phase = null;
    state.arcs.leaderHwid = null;
    state.arcs.initiativeSeized = false;
    state.arcs.turnOrder = [...state.boxOrder];
    state.arcs.cycleRemaining = [];
    state.boxOrder.forEach(hwid => {
      state.boxes[hwid].status = 'idle';
      state.boxes[hwid].badges = [];
    });
    log('Arcs started — Round 1', 'system');
    this.enterTapLeader();
  }

  onEndTurn(hwid: string): void {
    if (state.arcs.phase !== 'action') return;
    if (hwid !== state.activeBoxId) return;
    log(`${getDisplayName(hwid)} takes an action`, 'system');
    state.boxes[hwid].status = 'idle';
    state.arcs.cycleRemaining = state.arcs.cycleRemaining.filter(id => id !== hwid);
    this.checkAndAdvance();
  }

  onPass(hwid: string): void {
    if (state.arcs.phase !== 'action') return;
    if (hwid !== state.activeBoxId) return;
    log(`${getDisplayName(hwid)} passes`, 'system');
    state.boxes[hwid].status = 'passed';
    state.arcs.cycleRemaining = state.arcs.cycleRemaining.filter(id => id !== hwid);
    this.checkAndAdvance();
  }

  onLongPress(_hwid: string): void { /* no-op */ }

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    const replaceBoxId = (boxId: string) => (boxId === oldHwid ? newHwid : boxId);
    state.arcs.turnOrder = state.arcs.turnOrder.map(replaceBoxId);
    state.arcs.cycleRemaining = state.arcs.cycleRemaining.map(replaceBoxId);
    if (state.arcs.leaderHwid === oldHwid) state.arcs.leaderHwid = newHwid;
  }

  onRfid(hwid: string, game: string, category: string, _id: string): void {
    if (game !== 'arcs' || category !== 'initiative') return;

    if (state.arcs.phase === 'tap_leader') {
      disableAllRfid();
      state.arcs.leaderHwid = hwid;
      this.updateLeaderBadge();
      log(`${getDisplayName(hwid)} claims initiative`, 'system');
      this.flashInitiative(hwid);
      this.startActionCycle();
      return;
    }

    if (state.arcs.phase === 'action' && hwid === state.activeBoxId) {
      // Initiative seized mid-turn — next tap_leader will be skipped; turn continues normally
      disableRfid(hwid);
      state.arcs.leaderHwid = hwid;
      state.arcs.initiativeSeized = true;
      this.updateLeaderBadge();
      log(`${getDisplayName(hwid)} seizes initiative`, 'system');
      this.flashInitiative(hwid);
      render();
      persistState();
    }
  }

  getRelevantTags(hwid: string): Tag[] {
    if (state.arcs.phase === 'tap_leader') {
      return [{ display: 'Initiative', id: 'arcs:initiative' }];
    }
    if (state.arcs.phase === 'action' && hwid === state.activeBoxId) {
      return [{ display: 'Initiative', id: 'arcs:initiative' }];
    }
    return [];
  }

  getBoxDisplay(_hwid: string): Record<string, unknown> | null {
    if (state.arcs.phase === 'tap_leader') {
      return { name: 'Take initiative', status: 'Tap token' };
    }
    return null;
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.arcs.phase;

    if (phase === 'tap_leader') {
      statusLines.push('Waiting for initiative...');
      if (state.arcs.leaderHwid) {
        statusLines.push(`Previous leader: ${getDisplayName(state.arcs.leaderHwid)}`);
      }
    }

    if (phase === 'action') {
      const leader = state.arcs.leaderHwid;
      statusLines.push(`Action phase — Leader: ${leader ? getDisplayName(leader) : '?'}`);
      if (state.arcs.initiativeSeized) {
        statusLines.push(`Next leader: ${getDisplayName(leader!)}`);
      }
      const passedCount = state.arcs.turnOrder.filter(id => state.boxes[id]?.status === 'passed').length;
      if (passedCount > 0) {
        statusLines.push(`${passedCount} player${passedCount !== 1 ? 's' : ''} passed`);
      }
    }

    if (phase === 'status') {
      statusLines.push('Status phase');
      actionDefs.push({
        html: '<button id="gc-end-status">End Status Phase</button>',
        id: 'gc-end-status',
        fn: () => {
          this.endStatus();
          render();
          persistState();
        },
      });
    }
  }

  onPlayerRemoved(hwid: string): void {
    state.arcs.turnOrder = state.arcs.turnOrder.filter(id => id !== hwid);
    state.arcs.cycleRemaining = state.arcs.cycleRemaining.filter(id => id !== hwid);

    if (state.arcs.leaderHwid === hwid) {
      state.arcs.leaderHwid = null;
      state.arcs.initiativeSeized = false;
      this.updateLeaderBadge();
    }

    if (state.arcs.phase === 'action' && state.activeBoxId === hwid) {
      this.checkAndAdvance();
    }
  }

  activatePlayer(hwid: string): void {
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      disableRfid(state.activeBoxId);
      state.boxes[state.activeBoxId].status = 'idle';
    }
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    if (state.arcs.phase === 'action') enableRfid(hwid);
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  syncRfid(): void {
    if (state.arcs.phase === 'tap_leader') {
      state.boxOrder.forEach(hwid => {
        const box = state.boxes[hwid];
        if (!box || box.isVirtual || box.status === 'disconnected') return;
        enableRfid(hwid);
      });
    } else if (state.arcs.phase === 'action' && state.activeBoxId) {
      const box = state.boxes[state.activeBoxId];
      if (box && !box.isVirtual) enableRfid(state.activeBoxId);
    }
  }

  onResume(): void {
    this.syncRfid();
  }

  debugSkip(): void {
    if (state.arcs.phase === 'tap_leader') {
      const first = state.arcs.turnOrder.find(id =>
        state.boxes[id]?.status !== 'disconnected' &&
        state.boxes[id]?.status !== 'passed'
      );
      if (first) {
        disableAllRfid();
        state.arcs.leaderHwid = first;
        this.updateLeaderBadge();
        log(`[DEBUG] Arcs: ${getDisplayName(first)} gets initiative`, 'system');
        this.startActionCycle();
      }
    } else if (state.arcs.phase === 'action') {
      log('[DEBUG] Arcs: ending action cycle', 'system');
      state.activeBoxId = null;
      if (this.allPassed()) {
        this.startStatus();
      } else {
        this.enterTapLeader();
      }
    } else if (state.arcs.phase === 'status') {
      this.endStatus();
    }
    render();
    persistState();
  }

  // ---- Phases ----

  private enterTapLeader(): void {
    if (state.currentPhaseStart !== null) endPhase();
    disableAllRfid();

    // Skip tap_leader if only one active player remains or initiative was already seized
    const eligible = state.arcs.turnOrder.filter(id =>
      state.boxes[id]?.status !== 'disconnected' &&
      state.boxes[id]?.status !== 'passed'
    );
    if (eligible.length === 1 || state.arcs.initiativeSeized) {
      const next = state.arcs.initiativeSeized ? state.arcs.leaderHwid : eligible[0];
      if (next) {
        const reason = state.arcs.initiativeSeized ? 'seized initiative' : 'leads by default';
        state.arcs.leaderHwid = next;
        this.updateLeaderBadge();
        log(`${getDisplayName(next)} ${reason}`, 'system');
        this.startActionCycle();
        return;
      }
    }

    state.arcs.phase = 'tap_leader';
    state.arcs.cycleRemaining = [];
    state.activeBoxId = null;

    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.isVirtual || box.status === 'disconnected') return;
      enableRfid(hwid);
    });

    log('Waiting for initiative token...', 'system');
    syncDisplay();
    render();
    persistState();
  }

  private startActionCycle(): void {
    state.arcs.phase = 'action';
    state.arcs.initiativeSeized = false;
    startPhase('action');

    const eligible = state.arcs.turnOrder.filter(id =>
      state.boxes[id]?.status !== 'disconnected' &&
      state.boxes[id]?.status !== 'passed'
    );
    state.arcs.cycleRemaining = this.orderFromLeader(eligible);

    if (state.arcs.cycleRemaining.length === 0) {
      this.startStatus();
      return;
    }

    this.activateActionPlayer(state.arcs.cycleRemaining[0]);
    syncDisplay();
    render();
    persistState();
  }

  private startStatus(): void {
    if (state.currentPhaseStart !== null) endPhase();
    disableAllRfid();
    state.arcs.phase = 'status';
    state.arcs.cycleRemaining = [];
    state.activeBoxId = null;
    startPhase('status');

    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') {
        state.boxes[hwid].status = 'status';
      }
    });

    log('Status phase', 'system');
    syncDisplay();
    render();
    persistState();
  }

  private endStatus(): void {
    endPhase();
    state.round++;
    state.arcs.initiativeSeized = false;

    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') {
        state.boxes[hwid].status = 'idle';
      }
    });

    log(`Round ${state.round} — Initiative phase`, 'system');
    this.enterTapLeader();
  }

  // ---- Turn management ----

  private activateActionPlayer(hwid: string): void {
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    const box = state.boxes[hwid];
    if (box && !box.isVirtual) enableRfid(hwid);
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  private checkAndAdvance(): void {
    state.activeBoxId = null;

    if (this.allPassed()) {
      this.flashCycleEnd(() => this.startStatus());
      return;
    }

    const next = state.arcs.cycleRemaining.find(id => state.boxes[id]?.status !== 'disconnected');
    if (next === undefined) {
      // Cycle exhausted — flash then enter initiative phase (auto-skip if applicable)
      this.flashCycleEnd(() => this.enterTapLeader());
      return;
    }

    this.activateActionPlayer(next);
    render();
    persistState();
  }

  private allPassed(): boolean {
    return state.arcs.turnOrder.every(id =>
      state.boxes[id]?.status === 'passed' ||
      state.boxes[id]?.status === 'disconnected'
    );
  }

  private flashCycleEnd(then: () => void): void {
    state.boxOrder.forEach(hwid => {
      const box = state.boxes[hwid];
      if (!box || box.isVirtual || box.status === 'disconnected') return;
      box.ledOverrideUntil = Date.now() + CYCLE_END_FLASH_MS;
      sendToBox(hwid, { type: 'led_solid', color: CYCLE_END_FLASH_COLOR });
    });
    then();
    setTimeout(() => { resetActiveAnim(); syncLeds(); }, CYCLE_END_FLASH_MS + 100);
  }

  private flashInitiative(hwid: string): void {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    resetActiveAnim();
    box.ledOverrideUntil = Date.now() + INITIATIVE_FLASH_MS;
    sendToBox(hwid, { type: 'led_solid', color: INITIATIVE_FLASH_COLOR });
    setTimeout(() => { resetActiveAnim(); syncLeds(); }, INITIATIVE_FLASH_MS + 100);
  }

  // ---- Helpers ----

  private orderFromLeader(players: string[]): string[] {
    const leader = state.arcs.leaderHwid;
    if (!leader || !players.includes(leader)) return [...players];
    const idx = players.indexOf(leader);
    return [...players.slice(idx), ...players.slice(0, idx)];
  }

  private updateLeaderBadge(): void {
    state.boxOrder.forEach(hwid => {
      setBoxBadges(hwid, hwid === state.arcs.leaderHwid
        ? [{ type: 'text', value: 'Leader', color: '#ffd700' }]
        : []);
    });
  }
}
