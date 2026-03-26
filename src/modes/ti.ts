import { state } from '../state';
import { log } from '../logger';
import { disableAllRfid, enableRfid, sendToBox } from '../websockets';
import { getDisplayName } from '../boxes';
import { render, renderBoxes } from '../render';
import { setBoxBadges } from '../boxes';
import { startPhase } from '../timers';
import { persistState } from '../persist';
import { snapshotForUndo } from '../undo';
import { LED_COUNT } from '../leds';
import { filterTags } from '../tags';
import { getFactionForBox } from './eclipse';
import type { GameMode, Tag, ActionDef, StrategyCard } from '../types';

const TI_STRATEGY_COLORS: Record<string, string> = {
  leadership:   '#cc0000',
  diplomacy:    '#ff8800',
  politics:     '#dddd00',
  construction: '#00aa00',
  trade:        '#00aaaa',
  warfare:      '#0055ff',
  technology:   '#000066',
  imperial:     '#660088',
};

const TI_STRATEGY_INITIATIVES: Record<string, number> = {
  leadership: 1, diplomacy: 2, politics: 3, construction: 4,
  trade: 5, warfare: 6, technology: 7, imperial: 8,
};

const TI_STRATEGY_LABELS: Record<string, string> = {
  leadership: 'Leadership', diplomacy: 'Diplomacy', politics: 'Politics',
  construction: 'Construction', trade: 'Trade', warfare: 'Warfare',
  technology: 'Technology', imperial: 'Imperial',
};

export class TwilightImperiumMode implements GameMode {
  readonly id = 'ti';

  start(): void {
    const speakerHwid = (document.getElementById('ti-speaker') as HTMLSelectElement).value;
    state.ti.speakerHwid = speakerHwid;
    state.round = 1;
    state.ti.phase = null;
    state.ti.players = {};

    state.boxOrder.forEach(hwid => {
      state.ti.players[hwid] = {
        hwid,
        strategyCards: [],
        passed: false,
        confirmedSecondary: false,
      };
    });

    log(`TI started — Round 1, Speaker: ${getDisplayName(speakerHwid)}`, 'system');
    this.startStrategyPhase();
  }

  onEndTurn(hwid: string): void {
    switch (state.ti.phase) {
      case 'strategy':
        if (hwid === state.hubHwid) {
          state.ti.strategyTurnIndex++;
          this.activateStrategyTurn();
        }
        break;

      case 'action':
        if (state.ti.secondary) {
          this.confirmSecondary(hwid);
        } else {
          if (hwid !== state.activeBoxId) return;
          state.ti.actionTurnIndex =
            (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
          this.activateActionTurn();
        }
        break;

      case 'agenda_reveal':
        if (hwid === state.activeBoxId) this.advanceAgendaPhase();
        break;
      case 'when_agenda_revealed':
      case 'after_agenda_revealed':
      case 'agenda_vote':
        this.agendaEndTurn(hwid);
        break;
    }
  }

  onPass(hwid: string): void {
    switch (state.ti.phase) {
      case 'action':
        if (state.ti.secondary) {
          if (hwid === state.ti.secondary.activeHwid) {
            const secondary = state.ti.secondary;
            const card = state.ti.players[hwid].strategyCards.find(c => c.id === secondary.cardId);
            if (card) card.used = false;
            secondary.pendingHwids.forEach(id => {
              if (state.boxes[id].status === 'secondary') {
                state.boxes[id].status = 'idle';
              }
            });
            state.ti.secondary = null;
            state.boxes[hwid].status = 'active';
            log(`${getDisplayName(hwid)} cancels ${secondary.cardId} use`, 'system');
            this.updateBadges();
          } else {
            this.confirmSecondary(hwid);
          }
        } else {
          if (hwid !== state.activeBoxId) return;
          const player = state.ti.players[hwid];
          const allUsed = player.strategyCards.every(c => c.used);
          if (!allUsed) {
            log(`${getDisplayName(hwid)} can't pass — strategy cards not used`, 'system');
            return;
          }
          player.passed = true;
          state.boxes[hwid].status = 'passed';
          log(`${getDisplayName(hwid)} passes`, 'system');

          const allPassed = state.boxOrder.every(id =>
            state.ti.players[id].passed ||
            state.boxes[id].status === 'disconnected'
          );

          if (allPassed) {
            this.endActionPhase();
          } else {
            state.ti.actionTurnIndex =
              (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
            this.activateActionTurn();
          }
        }
        break;
    }
  }

  onLongPress(hwid: string): void {
    if (hwid !== state.hubHwid) return;
    switch (state.ti.phase) {
      case 'status':
        if (state.ti.mecatolControlled) {
          this.startAgendaPhase();
        } else {
          this.endRound();
        }
        break;
      case 'status2':
        this.endRound();
        break;
      case 'agenda_reveal':
      case 'when_agenda_revealed':
      case 'after_agenda_revealed':
      case 'agenda_vote':
        this.advanceAgendaPhase();
        break;
    }
  }

  onRfid(hwid: string, game: string, category: string, id: string): void {
    if (game !== 'ti') { log(`Tag game mismatch: expected ti, got ${game}`, 'error'); return; }

    if (category === 'token' && id === 'speaker') {
      if (hwid === state.activeBoxId) {
        state.ti.speakerHwid = hwid;
        log(`${getDisplayName(hwid)} takes the speaker token`, 'system');
        this.updateBadges();
      }
      return;
    }

    if (category === 'strategy') {
      const label = TI_STRATEGY_LABELS[id] || id;
      const color = TI_STRATEGY_COLORS[id] || '#ffffff';
      const initiative = TI_STRATEGY_INITIATIVES[id] || 99;

      if (state.ti.phase === 'strategy') {
        if (hwid !== state.activeBoxId) return;
        const player = state.ti.players[hwid];
        const alreadyTaken = state.boxOrder.some(pid =>
          state.ti.players[pid].strategyCards.some(c => c.id === id)
        );
        if (alreadyTaken) { log(`${label} already taken`, 'error'); return; }
        player.strategyCards.push({ id, label, color, initiative, used: false });
        log(`${getDisplayName(hwid)} takes ${label}`, 'system');
        this.updateBadges();
        state.boxes[hwid].leds = { type: 'led_solid', color };
        state.boxes[hwid].ledOverrideUntil = Date.now() + 800;
        if (!state.boxes[hwid].isVirtual) sendToBox(hwid, { type: 'led_solid', color });
        renderBoxes();
        setTimeout(() => {
          state.boxes[hwid].ledOverrideUntil = null;
          state.boxes[hwid].leds = null;
          state.ti.strategyTurnIndex++;
          this.activateStrategyTurn();
          render();
        }, 800);
      } else if (state.ti.phase === 'action') {
        if (hwid !== state.activeBoxId) return;
        const player = state.ti.players[hwid];
        const card = player.strategyCards.find(c => c.id === id);
        if (!card) { log(`${getDisplayName(hwid)} doesn't have ${label}`, 'error'); return; }
        this.useStrategyCard(hwid, card);
      }
      return;
    }

    // faction tag — no-op during gameplay
  }

  advancePhase(): void {
    switch (state.ti.phase) {
      case 'status':
        if (state.ti.mecatolControlled) {
          this.startAgendaPhase();
        } else {
          this.endRound();
        }
        break;
      case 'status2':
        this.endRound();
        break;
      case 'agenda_reveal':
      case 'when_agenda_revealed':
      case 'after_agenda_revealed':
      case 'agenda_vote':
        this.advanceAgendaPhase();
        break;
    }
  }

  getRelevantTags(hwid: string): Tag[] {
    if (hwid !== state.activeBoxId) return [];
    const phase = state.ti.phase;

    if (phase === 'strategy') {
      return filterTags('ti', t => t.id.startsWith('ti:strategy:'));
    }

    if (phase === 'action') {
      const player = state.ti.players[hwid];
      if (!player) return [];
      const heldIds = new Set(player.strategyCards.map(c => c.id));
      return filterTags('ti', t => {
        if (t.id === 'ti:token:speaker') return true;
        const parts = t.id.split(':');
        return parts[1] === 'strategy' && heldIds.has(parts[2]);
      });
    }

    return [];
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.ti.phase ?? '';
    if (state.ti.speakerHwid) statusLines.push(`Speaker: ${getDisplayName(state.ti.speakerHwid)}`);
    if (['agenda_reveal', 'when_agenda_revealed', 'after_agenda_revealed', 'agenda_vote'].includes(phase)) {
      statusLines.push(`Agenda ${(state.ti.agendaCount ?? 0) + 1} of 2`);
    }

    const advanceable = ['status', 'status2', 'agenda_reveal', 'when_agenda_revealed', 'after_agenda_revealed', 'agenda_vote'];
    if (advanceable.includes(phase)) {
      actionDefs.push({
        html: '<button id="gc-advance">Advance Phase</button>',
        id: 'gc-advance',
        fn: () => { snapshotForUndo(); this.advancePhase(); render(); persistState(); },
      });
    }
    actionDefs.push({
      html: `<div class="gc-secondary-row">
        <span>Secondary:</span>
        <select id="gc-secondary">
          <option value="fastest"${state.ti.secondaryMode === 'fastest' ? ' selected' : ''}>Fastest</option>
          <option value="fast"${state.ti.secondaryMode === 'fast' ? ' selected' : ''}>Fast</option>
          <option value="standard"${state.ti.secondaryMode === 'standard' ? ' selected' : ''}>Standard</option>
        </select>
      </div>`,
      id: 'gc-secondary',
      event: 'change',
      fn: (e: Event) => {
        state.ti.secondaryMode = (e.target as HTMLSelectElement).value as 'fastest' | 'fast' | 'standard';
        log(`Secondary mode: ${state.ti.secondaryMode}`, 'system');
      },
    });
    actionDefs.push({
      html: `<label class="gc-check-row">
        <input type="checkbox" id="gc-mecatol"${state.ti.mecatolControlled ? ' checked' : ''}>
        Mecatol Rex controlled
      </label>`,
      id: 'gc-mecatol',
      event: 'change',
      fn: (e: Event) => {
        state.ti.mecatolControlled = (e.target as HTMLInputElement).checked;
        log(`Mecatol ${state.ti.mecatolControlled ? 'controlled' : 'not controlled'}`, 'system');
      },
    });
    if (state.factions) {
      actionDefs.push({
        html: '<button id="gc-factions">Set Factions</button>',
        id: 'gc-factions',
        fn: () => { void import('../rfid').then(({ startFactionScan }) => startFactionScan()); },
      });
    }
  }

  onFactionChanged(): void {
    this.updateBadges();
  }

  debugSkip(): void {
    const phase = state.ti.phase;
    log(`[DEBUG] Skipping TI phase: ${phase}`, 'system');
    state.boxOrder.forEach(hwid => { state.boxes[hwid].status = 'idle'; });
    state.activeBoxId = null;
    state.ti.secondary = null;
    switch (phase) {
      case 'strategy': this.startActionPhase(); break;
      case 'action':   this.startStatusPhase(); break;
      case 'status':
        if (state.ti.mecatolControlled) this.startAgendaPhase();
        else this.endRound();
        break;
      case 'agenda_reveal':        this.startAgendaWhen(); break;
      case 'when_agenda_revealed': this.startAgendaAfter(); break;
      case 'after_agenda_revealed':this.startAgendaVote(); break;
      case 'agenda_vote':          this.startStatusPhase(true); break;
      case 'status2':              this.endRound(); break;
      default: log('[DEBUG] Unknown TI phase', 'system');
    }
  }

  // ---- Choosing animation ----

  private sendChoosingAnim(hwid: string): void {
    sendToBox(hwid, {
      type: 'led_anim_choosing',
      colors: Object.values(TI_STRATEGY_COLORS),
      activeMs: 600,
      fadeMs: 100,
    });
  }

  // ---- Strategy Phase ----

  private startStrategyPhase(): void {
    state.ti.phase = 'strategy';
    startPhase('strategy');
    state.activeBoxId = null;

    state.boxOrder.forEach(hwid => {
      state.ti.players[hwid].strategyCards = [];
      state.ti.players[hwid].passed = false;
      state.boxes[hwid].status = 'idle';
    });

    const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid ?? '');
    state.ti.turnOrder = [
      ...state.boxOrder.slice(speakerIndex),
      ...state.boxOrder.slice(0, speakerIndex),
    ];

    if (state.boxOrder.length <= 4) {
      state.ti.turnOrder = [...state.ti.turnOrder, ...state.ti.turnOrder];
    }

    state.ti.strategyTurnIndex = 0;
    this.activateStrategyTurn();
    log('Strategy phase', 'system');
  }

  private activateStrategyTurn(): void {
    while (state.ti.strategyTurnIndex < state.ti.turnOrder.length) {
      const hwid = state.ti.turnOrder[state.ti.strategyTurnIndex];
      const player = state.ti.players[hwid];
      if (player.strategyCards.length < 2) break;
      state.ti.strategyTurnIndex++;
    }

    if (state.ti.strategyTurnIndex >= state.ti.turnOrder.length) {
      this.endStrategyPhase();
      return;
    }

    const hwid = state.ti.turnOrder[state.ti.strategyTurnIndex];
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    disableAllRfid();
    state.activeBoxId = hwid;
    if (hwid) enableRfid(hwid);
    state.boxes[hwid].status = 'choosing';
    state.boxes[hwid].choosingLeds = {
      type: 'led_sectors',
      sectors: Object.values(TI_STRATEGY_COLORS).map(color => ({ color, count: LED_COUNT / 8 })),
    };
    if (!state.boxes[hwid].isVirtual) this.sendChoosingAnim(hwid);
    log(`${getDisplayName(hwid)} picks a strategy card`, 'system');
    this.updateBadges();
  }

  private endStrategyPhase(): void {
    log('Strategy phase complete', 'system');
    if (state.activeBoxId) {
      state.boxes[state.activeBoxId].status = 'idle';
      state.activeBoxId = null;
    }
    this.startActionPhase();
  }

  // ---- Action Phase ----

  private startActionPhase(): void {
    state.ti.phase = 'action';
    state.ti.secondary = null;
    startPhase('action');

    state.boxOrder.forEach(hwid => {
      state.ti.players[hwid].passed = false;
      state.ti.players[hwid].confirmedSecondary = false;
      state.boxes[hwid].status = 'idle';
    });

    state.ti.turnOrder = [...state.boxOrder].sort((a, b) => {
      return this.lowestInitiative(a) - this.lowestInitiative(b);
    });

    state.ti.actionTurnIndex = 0;
    this.activateActionTurn();
    log('Action phase', 'system');
  }

  private lowestInitiative(hwid: string): number {
    const cards = state.ti.players[hwid].strategyCards;
    if (cards.length === 0) return 999;
    return Math.min(...cards.map(c => c.initiative));
  }

  private activateActionTurn(): void {
    const order = state.ti.turnOrder;
    let found = false;

    for (let i = 0; i < order.length; i++) {
      const idx = (state.ti.actionTurnIndex + i) % order.length;
      const hwid = order[idx];
      const player = state.ti.players[hwid];
      if (!player.passed && state.boxes[hwid].status !== 'disconnected') {
        if (state.activeBoxId && state.activeBoxId !== hwid) {
          if (state.boxes[state.activeBoxId].status !== 'passed') {
            state.boxes[state.activeBoxId].status = 'idle';
          }
        }
        state.ti.actionTurnIndex = idx;
        disableAllRfid();
        state.activeBoxId = hwid;
        enableRfid(hwid);
        state.boxes[hwid].status = 'active';
        log(`${getDisplayName(hwid)}'s turn`, 'system');
        found = true;
        break;
      }
    }

    if (!found) {
      this.endActionPhase();
    }
    this.updateBadges();
  }

  private endActionPhase(): void {
    log('Action phase over', 'system');
    state.activeBoxId = null;
    this.startStatusPhase();
  }

  // ---- Strategy Card Use ----

  private useStrategyCard(hwid: string, card: StrategyCard): void {
    if (hwid !== state.activeBoxId) return;
    if (state.ti.phase !== 'action') return;
    if (card.used) {
      state.boxes[hwid].status = 'active';
      state.ti.secondary = null;
      log(`${getDisplayName(hwid)} cancels ${card.label} use`, 'system');
      this.updateBadges();
      return;
    }

    state.boxes[hwid].status = 'strategy';
    state.boxes[hwid].strategyColor = card.color;
    card.used = true;

    const otherPlayers = state.boxOrder.filter(id =>
      id !== hwid && state.boxes[id].status !== 'disconnected'
    );

    state.ti.secondary = {
      activeHwid: hwid,
      cardId: card.id,
      cardColor: card.color,
      pendingHwids: [...otherPlayers],
      activeTurnEnded: false,
    };

    state.boxOrder.forEach(id => {
      state.ti.players[id].confirmedSecondary = false;
    });

    log(`${getDisplayName(hwid)} uses ${card.label} — secondaries pending`, 'system');

    const mode = state.ti.secondaryMode;
    if (mode === 'fastest') {
      otherPlayers.forEach(id => {
        state.boxes[id].status = 'secondary';
        state.boxes[id].strategyColor = card.color;
      });
    }
    // 'fast' and 'standard': secondaries activate when primary ends their turn

    this.updateBadges();
  }

  private activateNextSecondary(): void {
    const secondary = state.ti.secondary;
    if (!secondary) return;

    const activeIndex = state.boxOrder.indexOf(secondary.activeHwid);
    for (let i = 1; i <= state.boxOrder.length; i++) {
      const idx = (activeIndex + i) % state.boxOrder.length;
      const hwid = state.boxOrder[idx];
      if (secondary.pendingHwids.includes(hwid) &&
          !state.ti.players[hwid].confirmedSecondary &&
          state.boxes[hwid].status !== 'disconnected') {
        state.boxes[hwid].status = 'secondary';
        state.boxes[hwid].strategyColor = secondary.cardColor;
        log(`${getDisplayName(hwid)} secondary`, 'system');
        return;
      }
    }
  }

  private confirmSecondary(hwid: string): void {
    const secondary = state.ti.secondary;
    if (!secondary) return;

    if (hwid === secondary.activeHwid) {
      secondary.activeTurnEnded = true;
      state.boxes[hwid].status = 'idle';
      state.activeBoxId = null;

      if (state.ti.secondaryMode === 'fast') {
        secondary.pendingHwids.forEach(id => {
          if (state.boxes[id].status !== 'disconnected') {
            state.boxes[id].status = 'secondary';
            state.boxes[id].strategyColor = secondary.cardColor;
          }
        });
      } else if (state.ti.secondaryMode === 'standard') {
        this.activateNextSecondary();
      } else { // fastest
        const allConfirmed = secondary.pendingHwids.every(id =>
          state.ti.players[id].confirmedSecondary ||
          state.boxes[id].status === 'disconnected'
        );
        if (allConfirmed) {
          log('All secondaries confirmed — advancing turn', 'system');
          state.ti.secondary = null;
          state.ti.actionTurnIndex =
            (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
          this.activateActionTurn();
        }
      }
      return;
    }

    if (!secondary.pendingHwids.includes(hwid)) return;
    state.ti.players[hwid].confirmedSecondary = true;
    state.boxes[hwid].status = 'idle';

    if (state.ti.secondaryMode === 'standard') {
      this.activateNextSecondary();
    }

    const allConfirmed = secondary.pendingHwids.every(id =>
      state.ti.players[id].confirmedSecondary ||
      state.boxes[id].status === 'disconnected'
    );

    if (allConfirmed) {
      log('All secondaries confirmed — advancing turn', 'system');
      state.ti.secondary = null;

      if (secondary.activeTurnEnded) {
        state.ti.actionTurnIndex =
          (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
        this.activateActionTurn();
      } else {
        const wasStrategy = state.boxes[secondary.activeHwid].status === 'strategy';
        state.boxes[secondary.activeHwid].status = wasStrategy ? 'strategy' : 'active';
        disableAllRfid();
        state.activeBoxId = secondary.activeHwid;
        enableRfid(secondary.activeHwid);
      }
      this.updateBadges();
      render();
    }

    this.updateBadges();
  }

  // ---- Status Phase ----

  private startStatusPhase(isPostAgenda = false): void {
    state.ti.phase = isPostAgenda ? 'status2' : 'status';
    startPhase('status');
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      state.boxes[hwid].status = isPostAgenda ? 'status2' : 'status';
    });
    log('Status phase — long press hub to continue', 'system');
    this.updateBadges();
  }

  // ---- Agenda Phase ----

  private startAgendaPhase(): void {
    state.ti.phase = 'agenda_reveal';
    startPhase('agenda');
    state.ti.agendaCount = 0;
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      state.boxes[hwid].status = 'idle';
    });

    state.boxes[state.ti.speakerHwid!].status = 'agenda_speaker';
    disableAllRfid();
    state.activeBoxId = state.ti.speakerHwid;
    enableRfid(state.ti.speakerHwid!);
    log('Agenda phase — speaker reads agenda', 'system');
    this.updateBadges();
  }

  private advanceAgendaPhase(): void {
    switch (state.ti.phase) {
      case 'agenda_reveal':
        this.startAgendaWhen();
        break;
      case 'when_agenda_revealed':
        this.startAgendaAfter();
        break;
      case 'after_agenda_revealed':
        this.startAgendaVote();
        break;
      case 'agenda_vote':
        state.ti.agendaCount = (state.ti.agendaCount ?? 0) + 1;
        if (state.ti.agendaCount < 2) {
          state.ti.phase = 'agenda_reveal';
          state.boxes[state.ti.speakerHwid!].status = 'agenda_speaker';
          disableAllRfid();
          state.activeBoxId = state.ti.speakerHwid;
          enableRfid(state.ti.speakerHwid!);
          log('Second agenda — speaker reads', 'system');
        } else {
          this.startStatusPhase(true);
        }
        break;
    }
    this.updateBadges();
  }

  private startAgendaWhen(): void {
    state.ti.phase = 'when_agenda_revealed';
    const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid ?? '');
    state.ti.agendaTurnOrder = [
      ...state.boxOrder.slice(speakerIndex),
      ...state.boxOrder.slice(0, speakerIndex),
    ];
    state.ti.agendaTurnIndex = 0;
    if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
    this.activateAgendaTurn('when_agenda_revealed');
    log('Agenda — "when revealed" action cards', 'system');
  }

  private startAgendaAfter(): void {
    state.ti.phase = 'after_agenda_revealed';
    state.ti.agendaTurnIndex = 0;
    if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
    this.activateAgendaTurn('after_agenda_revealed');
    log('Agenda — "after revealed" action cards', 'system');
  }

  private startAgendaVote(): void {
    state.ti.phase = 'agenda_vote';
    const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid ?? '');
    const leftIndex = (speakerIndex + 1) % state.boxOrder.length;
    state.ti.agendaTurnOrder = [
      ...state.boxOrder.slice(leftIndex),
      ...state.boxOrder.slice(0, leftIndex),
    ];
    state.ti.agendaTurnIndex = 0;
    if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
    this.activateAgendaTurn('agenda_vote');
    log('Agenda — voting', 'system');
  }

  private activateAgendaTurn(phase: string): void {
    const order = state.ti.agendaTurnOrder;
    if (state.ti.agendaTurnIndex >= order.length) {
      state.activeBoxId = null;
      this.advanceAgendaPhase();
      return;
    }
    const hwid = order[state.ti.agendaTurnIndex];
    if (state.activeBoxId && state.activeBoxId !== hwid) {
      state.boxes[state.activeBoxId].status = 'idle';
    }
    disableAllRfid();
    state.activeBoxId = hwid;
    enableRfid(hwid);
    state.boxes[hwid].status = phase as typeof state.boxes[string]['status'];
  }

  private agendaEndTurn(hwid: string): void {
    if (hwid !== state.activeBoxId) return;
    state.boxes[hwid].status = 'idle';
    state.ti.agendaTurnIndex++;
    this.activateAgendaTurn(state.ti.phase!);
    this.updateBadges();
  }

  // ---- Round End ----

  private endRound(): void {
    log(`Round ${state.round} complete`, 'system');
    state.round++;

    state.boxOrder.forEach(hwid => {
      state.boxes[hwid].status = 'idle';
      state.ti.players[hwid].strategyCards = [];
      state.ti.players[hwid].passed = false;
    });
    state.activeBoxId = null;
    state.ti.secondary = null;

    this.startStrategyPhase();
  }

  // ---- Badges ----

  private updateBadges(): void {
    state.boxOrder.forEach(hwid => {
      const player = state.ti.players[hwid];
      if (!player) return;
      const badges: typeof state.boxes[string]['badges'] = [];
      if (hwid === state.ti.speakerHwid) {
        badges.push({ type: 'icon', value: '👑', label: 'Speaker' });
      }
      const faction = getFactionForBox(hwid);
      if (faction) {
        badges.push({ type: 'text', value: faction.name, color: faction.color });
      }
      player.strategyCards.forEach(card => {
        badges.push({ type: 'pill', value: card.label.substring(0, 4), color: card.color, faded: card.used });
      });
      setBoxBadges(hwid, badges);
    });
  }
}
