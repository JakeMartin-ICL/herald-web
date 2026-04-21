import { state } from '../state';
import { log } from '../logger';
import { getDisplayName, buildPlayerSelectOptions, setBoxBadges } from '../boxes';
import { render } from '../render';
import { startPhase, endPhase } from '../timers';
import { persistState } from '../persist';
import { syncLeds } from '../leds';
import { syncDisplay } from '../display';
import { sendToBox } from '../websockets';
import type { GameMode, Tag, ActionDef, LedCommand } from '../types';

const ASSEMBLY_GREEN: LedCommand = { type: 'led_alternate_pair', a: '#007f00', b: '#000000' };
const ASSEMBLY_DRAFT_STEP_MS = 80;
const ASSEMBLY_DRAFT_FADE_MS = 20;

export class InisMode implements GameMode {
  readonly id = 'inis';
  readonly scoreBreakdownCategories: readonly string[] = ['Deeds', 'Sanctuaries', 'Clans', 'Other'];

  get turnOrder(): string[] { return state.inis.turnOrder; }
  set turnOrder(order: string[]) { state.inis.turnOrder = order; }

  start(): void {
    state.round = 1;
    state.inis.phase = null;
    state.inis.assemblyStep = null;
    state.inis.brennHwid = null;
    state.inis.turnDirection = 'clockwise';
    state.inis.turnOrder = [...state.boxOrder];
    state.inis.consecutivePasses = 0;
    state.boxOrder.forEach(hwid => {
      state.boxes[hwid].status = 'idle';
      state.boxes[hwid].badges = [];
    });
    log('Inis started — Round 1', 'system');
    this.startAssembly();
  }

  onEndTurn(hwid: string): void {
    if (state.inis.phase === 'assembly') {
      this.onAssemblyEndTurn(hwid);
    } else if (state.inis.phase === 'season') {
      if (hwid !== state.activeBoxId) return;
      state.inis.consecutivePasses = 0;
      log(`${getDisplayName(hwid)} takes an action`, 'system');
      this.advanceSeason(hwid);
    }
  }

  onPass(hwid: string): void {
    if (state.inis.phase === 'assembly' && state.inis.assemblyStep === 'flock') {
      if (hwid !== state.hubHwid) return;
      state.inis.turnDirection = 'anticlockwise';
      log('Turn order: anti-clockwise', 'system');
      this.advanceAssemblyStep();
      render();
      persistState();
      return;
    }
    if (state.inis.phase === 'season') {
      if (hwid !== state.activeBoxId) return;
      state.inis.consecutivePasses++;
      log(`${getDisplayName(hwid)} passes (${state.inis.consecutivePasses} consecutive)`, 'system');

      const activePlayers = state.boxOrder.filter(id => state.boxes[id]?.status !== 'disconnected');
      if (state.inis.consecutivePasses >= activePlayers.length) {
        this.endSeason();
      } else {
        this.advanceSeason(hwid);
      }
    }
  }

  onLongPress(hwid: string): void {
    // Long press hub in assembly skips to next step
    if (hwid !== state.hubHwid) return;
    if (state.inis.phase === 'assembly') {
      log('[DEBUG] Inis: skipping assembly step', 'system');
      this.advanceAssemblyStep();
      render();
      persistState();
    }
  }

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    state.inis.turnOrder = state.inis.turnOrder.map(boxId => (boxId === oldHwid ? newHwid : boxId));
    if (state.inis.brennHwid === oldHwid) state.inis.brennHwid = newHwid;
  }

  getRelevantTags(_hwid: string): Tag[] { return []; }

  getBoxDisplay(hwid: string): Record<string, unknown> | null {
    if (state.inis.phase !== 'assembly') return null;

    switch (state.inis.assemblyStep) {
      case 'brenn':
        return { name: "Press if you're Brenn", status: '', arrow: 'up' };

      case 'victory':
        return { name: 'Check for victory', status: '' };

      case 'advantage':
        return { name: 'Take advantage cards', status: '' };

      case 'flock':
        if (hwid === state.hubHwid) {
          return { layout: 'inis_hub' };
        }
        if (hwid === state.inis.brennHwid) {
          return { name: 'Flip Flock of Crows', status: '' };
        }
        return { name: 'Waiting for Brenn', status: '' };

      case 'deal':
        return { name: 'Deal 4 cards each', status: '' };

      case 'draft': {
        const arrow = state.inis.turnDirection === 'clockwise' ? 'left' : 'right';
        return { name: '', status: '', arrow };
      }

      default:
        return null;
    }
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.inis.phase;
    const step = state.inis.assemblyStep;

    if (phase === 'assembly') {
      const stepLabels: Record<string, string> = {
        brenn: 'Select Brenn',
        victory: 'Check for victory',
        advantage: 'Take advantage cards',
        flock: 'Flock of Crows',
        deal: 'Deal 4 cards',
        draft: 'Draft',
      };
      statusLines.push(`Assembly: ${step ? stepLabels[step] ?? step : '…'}`);
      if (state.inis.brennHwid) {
        statusLines.push(`Brenn: ${getDisplayName(state.inis.brennHwid)}`);
      }
      if (step === 'flock' || step === 'deal' || step === 'draft') {
        statusLines.push(`Turn order: ${state.inis.turnDirection}`);
      }
    }

    if (phase === 'season') {
      statusLines.push(`Season phase — ${state.inis.consecutivePasses} consecutive pass${state.inis.consecutivePasses !== 1 ? 'es' : ''}`);
      statusLines.push(`Turn order: ${state.inis.turnDirection}`);
    }

    // Brenn selector (when brenn is set and in assembly post-brenn step, allow manual reassignment)
    if (phase === 'assembly' && step !== 'brenn' && state.inis.brennHwid) {
      actionDefs.push({
        html: `<div class="gc-secondary-row">
          <span>Brenn:</span>
          <select id="gc-brenn">
            ${buildPlayerSelectOptions().map(option =>
              `<option value="${option.value}"${state.inis.brennHwid === option.value ? ' selected' : ''}>${option.label}</option>`
            ).join('')}
          </select>
        </div>`,
        id: 'gc-brenn',
        event: 'change',
        fn: (e: Event) => {
          const hwid = (e.target as HTMLSelectElement).value;
          state.inis.brennHwid = hwid;
          this.updateBrennBadge();
          this.buildTurnOrder();
          syncDisplay();
          log(`Brenn reassigned to ${getDisplayName(hwid)}`, 'system');
        },
      });
    }
  }

  onPlayerRemoved(hwid: string): void {
    // If Brenn is removed, restart brenn selection
    if (state.inis.brennHwid === hwid) {
      state.inis.brennHwid = null;
      if (state.inis.phase === 'assembly') {
        this.startAssemblyStep('brenn');
        render();
        persistState();
        return;
      }
    }
    if (state.inis.phase === 'season') {
      state.inis.consecutivePasses = 0; // player count changed; reset
      if (state.activeBoxId === hwid) {
        this.advanceSeason(hwid);
      }
    }
    state.inis.turnOrder = state.inis.turnOrder.filter(id => id !== hwid);
  }

  activatePlayer(hwid: string): void {
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    state.activeBoxId = hwid;
    state.boxes[hwid].status = 'active';
    log(`${getDisplayName(hwid)}'s turn`, 'system');
  }

  debugSkip(): void {
    if (state.inis.phase === 'assembly') {
      log('[DEBUG] Inis: skipping assembly step', 'system');
      this.advanceAssemblyStep();
    } else if (state.inis.phase === 'season') {
      log('[DEBUG] Inis: skipping to next assembly', 'system');
      this.endSeason();
    }
    render();
    persistState();
  }

  // ---- Assembly ----

  private startAssembly(): void {
    state.inis.phase = 'assembly';
    state.inis.consecutivePasses = 0;
    state.activeBoxId = null;
    startPhase('assembly');
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid].status !== 'disconnected') {
        state.boxes[hwid].status = 'status';
        state.boxes[hwid].leds = ASSEMBLY_GREEN;
      }
    });
    log(`Round ${state.round} — Assembly phase`, 'system');
    this.startAssemblyStep('brenn');
    render();
    persistState();
  }

  private startAssemblyStep(step: typeof state.inis.assemblyStep): void {
    state.inis.assemblyStep = step;
    switch (step) {
      case 'brenn':
        state.inis.brennHwid = null;
        this.updateBrennBadge();
        // Restore full green on all boxes
        state.boxOrder.forEach(hwid => {
          if (state.boxes[hwid].status !== 'disconnected') state.boxes[hwid].leds = ASSEMBLY_GREEN;
        });
        log('Assembly: first to press End Turn becomes Brenn', 'system');
        break;
      case 'victory':
        log('Assembly: check for victory conditions', 'system');
        break;
      case 'advantage':
        log('Assembly: take advantage cards', 'system');
        break;
      case 'flock':
        // Brenn keeps green; all others go off
        state.boxOrder.forEach(hwid => {
          if (state.boxes[hwid].status !== 'disconnected') {
            state.boxes[hwid].leds = hwid === state.inis.brennHwid
              ? ASSEMBLY_GREEN
              : { type: 'led_off' };
          }
        });
        log('Assembly: hub End Turn = clockwise, Pass = anti-clockwise', 'system');
        break;
      case 'deal':
        // Restore green on all boxes
        state.boxOrder.forEach(hwid => {
          if (state.boxes[hwid].status !== 'disconnected') state.boxes[hwid].leds = ASSEMBLY_GREEN;
        });
        log('Assembly: deal 4 cards each', 'system');
        break;
      case 'draft':
        this.buildTurnOrder();
        // Spinner in the direction of turn order
        this.setDraftLeds();
        log(`Assembly: draft phase — turn order ${state.inis.turnDirection}`, 'system');
        break;
    }
    syncLeds();
    syncDisplay();
  }

  private advanceAssemblyStep(): void {
    const order: (typeof state.inis.assemblyStep)[] = [
      'brenn', 'victory', 'advantage', 'flock', 'deal', 'draft',
    ];
    const current = state.inis.assemblyStep;
    const idx = order.indexOf(current);
    if (idx === -1 || idx === order.length - 1) {
      this.startSeason();
    } else {
      this.startAssemblyStep(order[idx + 1]);
    }
  }

  private onAssemblyEndTurn(hwid: string): void {
    switch (state.inis.assemblyStep) {
      case 'brenn':
        // First player to press ET becomes Brenn
        state.inis.brennHwid = hwid;
        this.updateBrennBadge();
        this.buildTurnOrder();
        log(`${getDisplayName(hwid)} is Brenn`, 'system');
        // Brief gold flash on Brenn's box
        if (!state.boxes[hwid].isVirtual) {
          state.boxes[hwid].ledOverrideUntil = Date.now() + 800;
          sendToBox(hwid, { type: 'led_solid', color: '#d4a017' });
          setTimeout(() => { syncLeds(); }, 900);
        }
        this.advanceAssemblyStep();
        render();
        persistState();
        break;

      case 'victory':
      case 'advantage':
      case 'deal':
        if (hwid !== state.hubHwid) return;
        this.advanceAssemblyStep();
        render();
        persistState();
        break;

      case 'flock':
        if (hwid !== state.hubHwid) return;
        state.inis.turnDirection = 'clockwise';
        log('Turn order: clockwise', 'system');
        this.advanceAssemblyStep();
        render();
        persistState();
        break;

      case 'draft':
        if (hwid !== state.hubHwid) return;
        this.startSeason();
        render();
        persistState();
        break;
    }
  }

  // ---- Season ----

  private startSeason(): void {
    state.inis.phase = 'season';
    state.inis.assemblyStep = null;
    state.inis.consecutivePasses = 0;
    startPhase('season');

    // Clear assembly LED overrides; normal ledStateForStatus takes over
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid]) {
        state.boxes[hwid].leds = null;
        state.boxes[hwid].ledOverrideUntil = null;
        if (state.boxes[hwid].status !== 'disconnected') state.boxes[hwid].status = 'idle';
      }
    });

    log(`Season phase — ${getDisplayName(state.inis.brennHwid!)} leads as Brenn`, 'system');

    // Activate Brenn first
    const first = state.inis.turnOrder.find(id => state.boxes[id]?.status === 'idle');
    if (first) {
      state.activeBoxId = first;
      state.boxes[first].status = 'active';
      log(`${getDisplayName(first)}'s turn`, 'system');
    }
    render();
    persistState();
  }

  private advanceSeason(fromHwid: string): void {
    const order = state.inis.turnOrder;
    const currentIndex = order.indexOf(fromHwid);
    state.boxes[fromHwid].status = 'idle';

    for (let i = 1; i <= order.length; i++) {
      const nextIndex = (currentIndex + i) % order.length;
      const nextId = order[nextIndex];
      if (state.boxes[nextId]?.status !== 'disconnected') {
        state.activeBoxId = nextId;
        state.boxes[nextId].status = 'active';
        log(`${getDisplayName(nextId)}'s turn`, 'system');
        render();
        persistState();
        return;
      }
    }
    state.activeBoxId = null;
    render();
    persistState();
  }

  private endSeason(): void {
    log(`Season over after round ${state.round}`, 'system');
    endPhase();
    state.round++;
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid]?.status !== 'disconnected') state.boxes[hwid].status = 'idle';
    });
    this.startAssembly();
  }

  // ---- Helpers ----

  private buildTurnOrder(): void {
    const brenn = state.inis.brennHwid;
    if (!brenn) {
      state.inis.turnOrder = [...state.boxOrder].filter(id => state.boxes[id]?.status !== 'disconnected');
      return;
    }
    const active = state.boxOrder.filter(id => state.boxes[id]?.status !== 'disconnected');
    const brennIdx = active.indexOf(brenn);
    if (state.inis.turnDirection === 'clockwise') {
      state.inis.turnOrder = [
        ...active.slice(brennIdx),
        ...active.slice(0, brennIdx),
      ];
    } else {
      const reversed: string[] = [];
      for (let i = 0; i < active.length; i++) {
        reversed.push(active[((brennIdx - i) + active.length) % active.length]);
      }
      state.inis.turnOrder = reversed;
    }
  }

  private updateBrennBadge(): void {
    state.boxOrder.forEach(hwid => {
      setBoxBadges(hwid, hwid === state.inis.brennHwid
        ? [{ type: 'text', value: 'Brenn', color: '#c9a84c' }]
        : []);
    });
  }

  private setDraftLeds(): void {
    const reverse = state.inis.turnDirection === 'anticlockwise';
    const spinCmd: LedCommand = {
      type: 'led_anim_spinner',
      color: '#00b400',
      rainbow: false,
      stepMs: ASSEMBLY_DRAFT_STEP_MS,
      fadeMs: ASSEMBLY_DRAFT_FADE_MS,
      reverse,
    };
    state.boxOrder.forEach(hwid => {
      if (state.boxes[hwid].status !== 'disconnected') state.boxes[hwid].leds = spinCmd;
    });
  }
}
