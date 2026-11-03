import { state } from '../state';
import { log } from '../logger';
import { disableAllRfid, enableRfid, sendToBox } from '../websockets';
import { startGuidedPhase, advanceGuidedPhase, clearGuidedPhase, isGuidedPhaseActive, currentGuidedStep, guidedPhaseProgress } from '../guided-phase';
import { getDisplayName, buildPlayerSelectOptions, getFactionForBox, setBoxBadges, setAutoName } from '../boxes';
import { render, renderBoxes, isManuallyRenamed } from '../render';
import { startPhase, updateTurnTimers } from '../timers';
import { persistState } from '../persist';
import { snapshotForUndo } from '../undo';
import { LED_COUNT, resetActiveAnim, syncLeds, supportsRepeatingLedSectors } from '../leds';
import { filterTags } from '../tags';
import { isHubOrSim } from './helpers';
import { buildTiSecondaryDisplay } from '../ti-secondary-display';
import type { GameMode, Tag, ActionDef, StrategyCard, Box, LedCommand, SetupField } from '../types';

const TI_SPEAKER_FLASH_MS = 500;
const TI_SPEAKER_FLASH_WHITE = '#ffffff';
const TI_SPEAKER_FLASH_RED = '#ff0000';
const TI_AGENDA_SPEAKER_BLUE = '#4444ff';
const TI_AGENDA_PHASES = [
  'agenda_reveal', 'when_agenda_revealed', 'after_agenda_revealed', 'agenda_vote',
  'agenda_argent', 'agenda_ballot', 'agenda_resolve',
];

const TI_STATUS_STEPS = [
  'Score objectives',
  'Reveal public objective',
  'Draw action cards',
  'Remove command tokens',
  'Gain & redist. tokens',
  'Ready cards',
  'Repair units',
  'Return strategy cards',
];

const TI_STRATEGY_COLORS: Record<string, string> = {
  leadership: '#cc0000',
  diplomacy: '#ff8800',
  politics: '#dddd00',
  construction: '#00aa00',
  trade: '#00aaaa',
  warfare: '#0055ff',
  technology: '#000066',
  imperial: '#660088',
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

  getLedForStatus(status: string, box: Box | null, _hwid: string | null): LedCommand | null {
    switch (status) {
      case 'strategy': return { type: 'led_solid', color: box?.strategyColor ?? '#ffffff' };
      case 'secondary': return { type: 'led_alternate', color: box?.strategyColor ?? '#ffffff' };
      case 'status2': return { type: 'led_solid', color: '#8a0000' };
      case 'choosing': return box?.choosingLeds ?? { type: 'led_rainbow' };
      case 'agenda_speaker': return this.speakerLedPattern(TI_AGENDA_SPEAKER_BLUE, box);
      case 'agenda_reveal': return { type: 'led_off' };
      case 'when_agenda_revealed': return { type: 'led_half', color: '#ff6600', first: false };
      case 'after_agenda_revealed': return { type: 'led_half', color: '#ff6600', first: true };
      case 'agenda_vote': return { type: 'led_solid', color: '#0000ff' };
      default: return null;
    }
  }

  getTableLabel(): string {
    const phase = state.ti.phase ?? '';
    if (phase === 'action_end') return 'TI — ALL PLAYERS PASSED';
    const labels: Record<string, string> = {
      agenda_argent: 'ARGENT PUBLIC VOTE',
      agenda_ballot: 'SECRET BALLOTS',
      agenda_resolve: 'RESOLVE AGENDA',
    };
    const label = labels[phase] ?? phase.replace(/_/g, ' ').toUpperCase();
    if (state.ti.executiveOrderHwid) return `TI — EXECUTIVE ORDER — ${label}`;
    return `TI${label ? ` — ${label}` : ''}`;
  }

  getSetupFields(): SetupField[] {
    return [{
      type: 'select',
      id: 'ti-speaker',
      label: 'Speaker',
      options: buildPlayerSelectOptions(true),
    }, {
      type: 'checkbox',
      id: 'ti-hidden-agenda',
      label: 'Hidden Agenda',
      checked: state.ti.hiddenAgenda,
      hint: 'Galactic event: simultaneous secret voting',
    }];
  }

  getStartValidation(): { valid: boolean; reason?: string } {
    if (state.boxOrder.some(hwid => getFactionForBox(hwid)?.id === 'obsidian')) {
      return { valid: false, reason: 'Choose The Firmament during setup; it becomes The Obsidian during play.' };
    }
    return { valid: true };
  }

  get turnOrder(): string[] { return state.ti.turnOrder; }
  set turnOrder(order: string[]) {
    // Keep the phase turn index pointing at the current active player in the new order
    if (state.activeBoxId) {
      const newIdx = order.indexOf(state.activeBoxId);
      if (newIdx !== -1) {
        if (state.ti.phase === 'strategy') state.ti.strategyTurnIndex = newIdx;
        else if (state.ti.phase === 'action') state.ti.actionTurnIndex = newIdx;
      }
    }
    state.ti.turnOrder = order;
  }

  start(): void {
    const speakerHwid = (document.getElementById('ti-speaker') as HTMLSelectElement).value;
    state.ti.speakerHwid = speakerHwid;
    state.ti.hiddenAgenda = (document.getElementById('ti-hidden-agenda') as HTMLInputElement).checked;
    state.ti.agendaReadyHwids = [];
    state.ti.executiveOrderHwid = null;
    state.ti.ralNelHero = 'locked';
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
        if (isHubOrSim(hwid)) {
          state.ti.strategyTurnIndex++;
          this.activateStrategyTurn();
        }
        break;

      case 'action':
        if (state.ti.secondary) {
          this.confirmSecondary(hwid);
        } else {
          if (hwid !== state.activeBoxId) return;
          // A player can take consecutive turns after everyone else has passed.
          // Close this turn even when the next active box will be the same one.
          state.boxes[hwid].status = 'idle';
          state.activeBoxId = null;
          updateTurnTimers();
          state.ti.actionTurnIndex =
            (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
          this.activateActionTurn();
        }
        break;

      case 'action_end':
        if (hwid === this.factionPlayer('ralnelconsortium')) this.useRalNelHero();
        else if (isHubOrSim(hwid)) this.startStatusPhase();
        break;

      case 'status':
      case 'status2':
        if (!isHubOrSim(hwid)) return;
        if (isGuidedPhaseActive() && !advanceGuidedPhase()) {
          this.advancePhase();
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
      case 'agenda_argent':
        if (hwid === state.activeBoxId) this.startSecretBallot();
        break;
      case 'agenda_ballot':
        this.confirmBallot(hwid);
        break;
      case 'agenda_resolve':
        if (hwid === state.activeBoxId) this.completeAgenda();
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

  onBoxSubstituted(oldHwid: string, newHwid: string): void {
    const replaceBoxId = (boxId: string) => (boxId === oldHwid ? newHwid : boxId);

    state.ti.turnOrder = state.ti.turnOrder.map(replaceBoxId);
    state.ti.agendaTurnOrder = state.ti.agendaTurnOrder.map(replaceBoxId);
    state.ti.agendaReadyHwids = state.ti.agendaReadyHwids.map(replaceBoxId);
    if (state.ti.executiveOrderHwid === oldHwid) state.ti.executiveOrderHwid = newHwid;
    if (state.ti.speakerHwid === oldHwid) state.ti.speakerHwid = newHwid;

    if (state.ti.players[oldHwid]) {
      state.ti.players[newHwid] = {
        ...state.ti.players[oldHwid],
        hwid: newHwid,
      };
      delete state.ti.players[oldHwid];
    }

    if (state.ti.secondary) {
      if (state.ti.secondary.activeHwid === oldHwid) state.ti.secondary.activeHwid = newHwid;
      state.ti.secondary.pendingHwids = state.ti.secondary.pendingHwids.map(replaceBoxId);
    }
  }

  onLongPress(hwid: string): void {
    if (!isHubOrSim(hwid)) return;
    switch (state.ti.phase) {
      case 'action_end':
        this.startStatusPhase();
        break;
      case 'status':
        clearGuidedPhase();
        if (state.ti.mecatolControlled) {
          this.startAgendaPhase();
        } else {
          this.endRound();
        }
        break;
      case 'status2':
        clearGuidedPhase();
        this.endRound();
        break;
      case 'agenda_reveal':
      case 'when_agenda_revealed':
      case 'after_agenda_revealed':
      case 'agenda_vote':
      case 'agenda_argent':
      case 'agenda_ballot':
      case 'agenda_resolve':
        this.advanceAgendaPhase();
        break;
    }
    persistState();
  }

  onRfid(hwid: string, game: string, category: string, id: string): void {
    if (game !== 'ti') { log(`Tag game mismatch: expected ti, got ${game}`, 'error'); return; }

    if (category === 'token' && id === 'speaker') {
      if (hwid === state.activeBoxId) {
        state.ti.speakerHwid = hwid;
        log(`${getDisplayName(hwid)} takes the speaker token`, 'system');
        this.flashSpeakerToken(hwid);
        this.updateBadges();
      }
      return;
    }

    if (category === 'strategy') {
      const label = TI_STRATEGY_LABELS[id];
      const color = TI_STRATEGY_COLORS[id];
      const initiative = TI_STRATEGY_INITIATIVES[id];
      if (!label || !color || initiative === undefined) {
        log(`Unknown strategy card: ${id}`, 'error');
        return;
      }

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
      case 'action_end':
        this.startStatusPhase();
        break;
      case 'status':
        clearGuidedPhase();
        if (state.ti.mecatolControlled) {
          this.startAgendaPhase();
        } else {
          this.endRound();
        }
        break;
      case 'status2':
        clearGuidedPhase();
        this.endRound();
        break;
      case 'agenda_reveal':
      case 'when_agenda_revealed':
      case 'after_agenda_revealed':
      case 'agenda_vote':
      case 'agenda_argent':
      case 'agenda_ballot':
      case 'agenda_resolve':
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

  getBoxDisplay(hwid: string): Record<string, unknown> | null {
    if (state.ti.phase === 'action_end') {
      return { name: 'All players passed', status: hwid === this.factionPlayer('ralnelconsortium') ? 'End: use hero' : 'Hub: begin status' };
    }
    if (state.ti.phase === 'agenda_ballot') {
      if (getFactionForBox(hwid)?.id === 'argent') return { name: 'Public vote complete', status: 'Wait for speaker' };
      return { name: 'Secret ballot', status: state.ti.agendaReadyHwids.includes(hwid) ? 'Ballot submitted' : 'End: ballot ready' };
    }
    if (state.ti.phase === 'agenda_argent') {
      return { name: 'Argent votes first', status: hwid === state.activeBoxId ? 'End: vote complete' : 'Wait for Argent' };
    }
    if (state.ti.phase === 'agenda_resolve') {
      return { name: 'Resolve agenda', status: hwid === state.activeBoxId ? 'End: resolved' : 'Wait for speaker' };
    }
    if (!state.ti.secondaryHints) return null;
    if (state.ti.phase !== 'action') return null;
    if (state.boxes[hwid]?.status !== 'secondary') return null;
    const cardId = state.ti.secondary?.cardId;
    if (!cardId) return null;
    return buildTiSecondaryDisplay(cardId);
  }

  renderControls(statusLines: string[], actionDefs: ActionDef[]): void {
    const phase = state.ti.phase ?? '';
    if (state.ti.speakerHwid) statusLines.push(`Speaker: ${getDisplayName(state.ti.speakerHwid)}`);
    if (TI_AGENDA_PHASES.includes(phase)) {
      statusLines.push(state.ti.executiveOrderHwid
        ? `Executive Order — acting speaker: ${getDisplayName(state.ti.executiveOrderHwid)}`
        : `Agenda ${(state.ti.agendaCount ?? 0) + 1} of 2`);
    }
    this.renderExpansionControls(statusLines, actionDefs);
    if (isGuidedPhaseActive()) {
      statusLines.push(`Step ${guidedPhaseProgress()}: ${currentGuidedStep()}`);
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
        <span>Speaker:</span>
        <select id="gc-speaker">
          ${state.boxOrder.map(hwid =>
        `<option value="${hwid}"${state.ti.speakerHwid === hwid ? ' selected' : ''}>${getDisplayName(hwid)}</option>`
      ).join('')}
        </select>
      </div>`,
      id: 'gc-speaker',
      event: 'change',
      fn: (e: Event) => {
        const hwid = (e.target as HTMLSelectElement).value;
        state.ti.speakerHwid = hwid;
        log(`Speaker: ${getDisplayName(hwid)}`, 'system');
        this.updateBadges();
      },
    });
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
        snapshotForUndo();
        state.ti.secondaryMode = (e.target as HTMLSelectElement).value as 'fastest' | 'fast' | 'standard';
        log(`Secondary mode: ${state.ti.secondaryMode}`, 'system');
        this.reconcileSecondaries();
        render();
        persistState();
      },
    });
    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-mecatol"${state.ti.mecatolControlled ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Mecatol Rex controlled</span>
      </label>`,
      id: 'gc-mecatol',
      event: 'change',
      fn: (e: Event) => {
        state.ti.mecatolControlled = (e.target as HTMLInputElement).checked;
        log(`Mecatol ${state.ti.mecatolControlled ? 'controlled' : 'not controlled'}`, 'system');
      },
    });
    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-guided-status"${state.ti.guidedStatusPhase ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Guided status phase</span>
      </label>`,
      id: 'gc-guided-status',
      event: 'change',
      fn: (e: Event) => {
        state.ti.guidedStatusPhase = (e.target as HTMLInputElement).checked;
        log(`Guided status phase ${state.ti.guidedStatusPhase ? 'enabled' : 'disabled'}`, 'system');
      },
    });
    actionDefs.push({
      html: `<label class="gc-check-row toggle-wrap">
        <input type="checkbox" id="gc-secondary-hints"${state.ti.secondaryHints ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Secondary action hints</span>
      </label>`,
      id: 'gc-secondary-hints',
      event: 'change',
      fn: (e: Event) => {
        state.ti.secondaryHints = (e.target as HTMLInputElement).checked;
        log(`Secondary hints ${state.ti.secondaryHints ? 'enabled' : 'disabled'}`, 'system');
      },
    });
  }

  private factionPlayer(factionId: string): string | undefined {
    return state.boxOrder.find(hwid => state.boxes[hwid]?.status !== 'disconnected' && getFactionForBox(hwid)?.id === factionId);
  }

  private connectedPlayers(): string[] {
    return state.boxOrder.filter(hwid => state.boxes[hwid]?.status !== 'disconnected');
  }

  private get agendaSpeaker(): string | null {
    return state.ti.executiveOrderHwid ?? state.ti.speakerHwid;
  }

  private get secretVoting(): boolean {
    // Executive Order is an action, not an agenda phase.
    return state.ti.hiddenAgenda && !state.ti.executiveOrderHwid;
  }

  private renderExpansionControls(statusLines: string[], actions: ActionDef[]): void {
    const phase = state.ti.phase;
    const button = (id: string, label: string, fn: () => void): void => {
      actions.push({ html: `<button id="${id}">${label}</button>`, id, fn: () => {
        if (state.paused) return;
        snapshotForUndo();
        fn();
        render();
        persistState();
      } });
    };
    const ralNel = this.factionPlayer('ralnelconsortium');
    if (phase === 'action_end') {
      statusLines.push('All players passed — decide whether to use Signal Intrusion before starting status.');
      button('gc-ralnel-use', 'Use Ral Nel hero', () => this.useRalNelHero());
      button('gc-begin-status', 'Begin status', () => this.startStatusPhase());
    } else if (ralNel && state.ti.ralNelHero !== 'used') {
      actions.push({
        html: `<label class="gc-check-row toggle-wrap">
          <input type="checkbox" id="gc-ralnel-available"${state.ti.ralNelHero === 'available' ? ' checked' : ''}>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">Ral Nel hero available</span>
        </label>`,
        id: 'gc-ralnel-available', event: 'change', fn: (e: Event) => {
          if (state.paused) { render(); return; }
          snapshotForUndo();
          state.ti.ralNelHero = (e.target as HTMLInputElement).checked ? 'available' : 'locked';
          log(`Ral Nel hero ${state.ti.ralNelHero} — enable when unlocked`, 'system');
          persistState();
        },
      });
    }

    if (phase === 'action' && !state.ti.secondary && state.activeBoxId) {
      const hwid = state.activeBoxId;
      const faction = getFactionForBox(hwid)?.id;
      if (faction === 'keleres') {
        button('gc-executive-order', 'Executive Order', () => this.startExecutiveOrder());
      }
      if (faction === 'firmament') {
        button('gc-become-obsidian', 'Become Obsidian', () => {
          state.boxes[hwid].factionId = 'obsidian';
          const obsidian = getFactionForBox(hwid);
          if (obsidian && !isManuallyRenamed(hwid)) setAutoName(hwid, obsidian.nickname ?? obsidian.name);
          this.updateBadges();
          log(`${getDisplayName(hwid)} becomes The Obsidian — resolve Puppets of the Blade at the table`, 'system');
        });
      }
    }

    if (phase === 'agenda_argent') statusLines.push('Argent casts public votes before secret ballots.');
    if (phase === 'agenda_ballot') {
      const pending = this.connectedPlayers().filter(id => !state.ti.agendaReadyHwids.includes(id));
      statusLines.push(`Secret ballots — waiting for ${pending.map(getDisplayName).join(', ') || 'speaker'}. End confirms a submitted ballot or abstention.`);
    }
    if (phase === 'agenda_resolve') {
      statusLines.push('Speaker: tally votes, resolve post-vote effects and the outcome, then confirm.');
      button('gc-agenda-resolved', state.ti.executiveOrderHwid ? 'Agenda resolved — return to turn' : 'Agenda resolved', () => this.completeAgenda());
    }
  }

  private startExecutiveOrder(): void {
    const hwid = state.activeBoxId;
    if (state.ti.phase !== 'action' || state.ti.secondary || !hwid || getFactionForBox(hwid)?.id !== 'keleres') return;
    state.ti.executiveOrderHwid = hwid;
    startPhase('executive_order');
    this.revealAgenda();
    log('Executive Order — exhaust the technology and resolve one agenda; planets are not readied afterwards', 'system');
  }

  private useRalNelHero(): void {
    const hwid = this.factionPlayer('ralnelconsortium');
    if (state.ti.phase !== 'action_end' || state.ti.ralNelHero !== 'available' || !hwid) return;
    state.ti.ralNelHero = 'used';
    state.ti.players[hwid].passed = false;
    state.ti.phase = 'action';
    state.ti.actionTurnIndex = state.ti.turnOrder.indexOf(hwid);
    this.activateActionTurn();
    log('Signal Intrusion — Ral Nel resumes taking turns; gain 2 command tokens, draw 1 action card, and purge the hero', 'system');
  }

  onPlayerRemoved(hwid: string): void {
    // Speaker: reassign to next player in box order
    if (state.ti.speakerHwid === hwid) {
      const remaining = state.boxOrder.filter(id => id !== hwid);
      const idx = state.boxOrder.indexOf(hwid);
      state.ti.speakerHwid = remaining[idx % Math.max(1, remaining.length)] ?? null;
      if (state.ti.speakerHwid) {
        log(`Speaker reassigned to ${getDisplayName(state.ti.speakerHwid)}`, 'system');
      }
    }

    state.ti.agendaReadyHwids = state.ti.agendaReadyHwids.filter(id => id !== hwid);
    if (state.ti.executiveOrderHwid === hwid) {
      state.ti.turnOrder = state.ti.turnOrder.filter(id => id !== hwid);
      this.finishExecutiveOrder();
      return;
    }
    if (state.ti.phase === 'action_end' && !this.factionPlayer('ralnelconsortium')) {
      this.startStatusPhase();
      return;
    }
    if (state.ti.phase === 'agenda_ballot') {
      this.finishBallotsIfReady();
      return;
    }
    if (['agenda_argent', 'agenda_resolve'].includes(state.ti.phase ?? '')) {
      if (state.activeBoxId === hwid) {
        if (state.ti.phase === 'agenda_argent') this.startSecretBallot();
        else this.startAgendaResolution();
      }
      return;
    }

    // Secondary: cancel if removed player was the card user; otherwise drop from pending
    if (state.ti.secondary) {
      if (state.ti.secondary.activeHwid === hwid) {
        const secondary = state.ti.secondary;
        const card = state.ti.players[hwid]?.strategyCards.find(c => c.id === secondary.cardId);
        if (card) card.used = false;
        secondary.pendingHwids.forEach(id => {
          if (state.boxes[id]?.status === 'secondary') state.boxes[id].status = 'idle';
        });
        state.ti.secondary = null;
      } else {
        state.ti.secondary.pendingHwids = state.ti.secondary.pendingHwids.filter(id => id !== hwid);
      }
    }

    const wasActive = state.activeBoxId === hwid;

    switch (state.ti.phase) {
      case 'strategy': {
        // Count occurrences of hwid before strategyTurnIndex (handles doubled array for ≤4 players)
        let removedBefore = 0;
        for (let i = 0; i < state.ti.strategyTurnIndex; i++) {
          if (state.ti.turnOrder[i] === hwid) removedBefore++;
        }
        state.ti.strategyTurnIndex -= removedBefore;
        state.ti.turnOrder = state.ti.turnOrder.filter(id => id !== hwid);
        if (wasActive || state.ti.strategyTurnIndex >= state.ti.turnOrder.length) {
          state.activeBoxId = null;
          this.activateStrategyTurn();
        }
        break;
      }

      case 'action': {
        const actionIdx = state.ti.turnOrder.indexOf(hwid);
        if (actionIdx !== -1 && actionIdx < state.ti.actionTurnIndex) {
          state.ti.actionTurnIndex--;
        }
        state.ti.turnOrder = state.ti.turnOrder.filter(id => id !== hwid);

        if (wasActive) {
          state.activeBoxId = null;
          state.ti.actionTurnIndex = state.ti.actionTurnIndex % Math.max(1, state.ti.turnOrder.length);
          this.activateActionTurn();
        } else if (state.ti.secondary) {
          // Check if secondary is now complete after removing a pending player
          const allConfirmed = state.ti.secondary.pendingHwids.every(id =>
            state.ti.players[id]?.confirmedSecondary || state.boxes[id]?.status === 'disconnected'
          );
          if (allConfirmed && state.ti.secondary.activeTurnEnded) {
            state.ti.secondary = null;
            state.ti.actionTurnIndex = (state.ti.actionTurnIndex + 1) % Math.max(1, state.ti.turnOrder.length);
            this.activateActionTurn();
          }
        } else {
          const allPassed = state.boxOrder
            .filter(id => id !== hwid)
            .every(id => state.ti.players[id]?.passed || state.boxes[id]?.status === 'disconnected');
          if (allPassed) this.endActionPhase();
        }
        break;
      }

      case 'agenda_reveal': {
        if (wasActive) this.revealAgenda();
        break;
      }

      case 'when_agenda_revealed':
      case 'after_agenda_revealed':
      case 'agenda_vote': {
        const agendaIdx = state.ti.agendaTurnOrder.indexOf(hwid);
        if (agendaIdx !== -1 && agendaIdx < state.ti.agendaTurnIndex) {
          state.ti.agendaTurnIndex--;
        }
        state.ti.agendaTurnOrder = state.ti.agendaTurnOrder.filter(id => id !== hwid);
        if (wasActive) {
          state.activeBoxId = null;
          this.activateAgendaTurn(state.ti.phase!);
        }
        break;
      }
    }

    this.updateBadges();
  }

  activatePlayer(hwid: string): void {
    const phase = state.ti.phase;

    if (phase === 'strategy') {
      if (state.activeBoxId && state.activeBoxId !== hwid) {
        state.boxes[state.activeBoxId].status = 'idle';
        state.boxes[state.activeBoxId].choosingLeds = null;
      }
      const idx = state.ti.turnOrder.indexOf(hwid);
      if (idx !== -1) state.ti.strategyTurnIndex = idx;
      state.activeBoxId = null;
      this.activateStrategyTurn();

    } else if (phase === 'action') {
      if (state.activeBoxId && state.activeBoxId !== hwid) {
        const curr = state.boxes[state.activeBoxId];
        if (curr?.status !== 'passed') curr.status = 'idle';
      }
      // Cancel any in-progress secondary
      if (state.ti.secondary) {
        state.ti.secondary.pendingHwids.forEach(id => {
          if (state.boxes[id]?.status === 'secondary') state.boxes[id].status = 'idle';
        });
        state.ti.secondary = null;
      }
      const idx = state.ti.turnOrder.indexOf(hwid);
      if (idx !== -1) state.ti.actionTurnIndex = idx;
      disableAllRfid();
      state.activeBoxId = hwid;
      enableRfid(hwid);
      state.boxes[hwid].status = 'active';
      log(`${getDisplayName(hwid)}'s turn`, 'system');
      this.updateBadges();
    }
  }

  syncRfid(): void {
    disableAllRfid();
    const phase = state.ti.phase;
    if ((phase === 'strategy' || phase === 'action' || TI_AGENDA_PHASES.includes(phase ?? '')) && state.activeBoxId) {
      enableRfid(state.activeBoxId);
    }
  }

  onResume(): void {
    this.syncRfid();
    this.updateBadges();
    render();
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
      case 'action': this.startStatusPhase(); break;
      case 'status':
        clearGuidedPhase();
        if (state.ti.mecatolControlled) this.startAgendaPhase();
        else this.endRound();
        break;
      case 'agenda_reveal': this.startAgendaWhen(); break;
      case 'when_agenda_revealed': this.startAgendaAfter(); break;
      case 'after_agenda_revealed': this.startAgendaVote(); break;
      case 'agenda_vote': this.advanceAgendaPhase(); break;
      case 'agenda_argent': this.startSecretBallot(); break;
      case 'agenda_ballot': this.startAgendaResolution(); break;
      case 'agenda_resolve': this.completeAgenda(); break;
      case 'action_end': this.startStatusPhase(); break;
      case 'status2': this.endRound(); break;
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
    // Naalu Collective: faction ability grants effective initiative 0 (always acts first)
    if (getFactionForBox(hwid)?.id === 'naalu') return 0;
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
    state.activeBoxId = null;
    disableAllRfid();
    if (state.ti.ralNelHero === 'available' && this.factionPlayer('ralnelconsortium')) {
      state.ti.phase = 'action_end';
      log('All players passed — Ral Nel may use Signal Intrusion before status begins', 'system');
      this.updateBadges();
    } else {
      log('Action phase over', 'system');
      this.startStatusPhase();
    }
  }

  // ---- Strategy Card Use ----

  private useStrategyCard(hwid: string, card: StrategyCard): void {
    if (hwid !== state.activeBoxId) return;
    if (state.ti.phase !== 'action') return;
    if (card.used) {
      const secondary = state.ti.secondary;
      if (!(secondary?.activeHwid === hwid && secondary.cardId === card.id)) {
        log(`${getDisplayName(hwid)} already used ${card.label}`, 'error');
      }
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

    this.reconcileSecondaries();
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
      if (secondary.activeTurnEnded) return;
      secondary.activeTurnEnded = true;
      state.boxes[hwid].status = 'idle';
      state.activeBoxId = null;
    } else {
      // Waiting or already-finished players cannot confirm a secondary.
      if (!secondary.pendingHwids.includes(hwid) || state.boxes[hwid]?.status !== 'secondary' ||
          state.ti.players[hwid].confirmedSecondary) return;
      state.ti.players[hwid].confirmedSecondary = true;
      state.boxes[hwid].status = 'idle';
    }

    this.reconcileSecondaries();
    this.updateBadges();
  }

  private reconcileSecondaries(): void {
    const secondary = state.ti.secondary;
    if (!secondary) return;

    const outstanding = secondary.pendingHwids.filter(id =>
      !state.ti.players[id].confirmedSecondary && state.boxes[id].status !== 'disconnected'
    );

    if (outstanding.length === 0) {
      log('All secondaries confirmed', 'system');
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
      return;
    }

    const mode = state.ti.secondaryMode;
    if (mode === 'fastest' || (mode === 'fast' && secondary.activeTurnEnded)) {
      outstanding.forEach(id => {
        state.boxes[id].status = 'secondary';
        state.boxes[id].strategyColor = secondary.cardColor;
      });
    } else if (mode === 'standard' && secondary.activeTurnEnded &&
               !outstanding.some(id => state.boxes[id].status === 'secondary')) {
      // Slowing down never interrupts secondaries that have already started.
      this.activateNextSecondary();
    }
  }

  // ---- Status Phase ----

  private startStatusPhase(isPostAgenda = false): void {
    state.ti.phase = isPostAgenda ? 'status2' : 'status';
    startPhase('status');
    state.activeBoxId = null;
    state.boxOrder.forEach(hwid => {
      state.boxes[hwid].status = isPostAgenda ? 'status2' : 'status';
    });
    if (state.ti.guidedStatusPhase && !isPostAgenda) {
      startGuidedPhase(TI_STATUS_STEPS);
      log('Status phase — hub end turn to advance steps, long press to skip', 'system');
    } else if (state.ti.guidedStatusPhase && isPostAgenda) {
      startGuidedPhase(['Ready cards']);
      log('Status phase (post-agenda) — hub end turn to advance, long press to skip', 'system');
    } else {
      log('Status phase — long press hub to continue', 'system');
    }
    this.updateBadges();
  }

  // ---- Agenda Phase ----

  private startAgendaPhase(): void {
    state.ti.executiveOrderHwid = null;
    state.ti.agendaCount = 0;
    startPhase('agenda');
    this.revealAgenda();
    log('Agenda phase — speaker reads agenda', 'system');
  }

  private clearAgendaBoxes(): void {
    disableAllRfid();
    this.connectedPlayers().forEach(hwid => { state.boxes[hwid].status = 'idle'; });
    state.activeBoxId = null;
  }

  private revealAgenda(): void {
    this.clearAgendaBoxes();
    state.ti.phase = 'agenda_reveal';
    state.ti.agendaReadyHwids = [];
    state.ti.agendaTurnOrder = [];
    state.ti.agendaTurnIndex = 0;
    const speaker = this.agendaSpeaker;
    if (speaker && state.boxes[speaker]?.status !== 'disconnected') {
      state.activeBoxId = speaker;
      state.boxes[speaker].status = 'agenda_speaker';
      enableRfid(speaker);
    }
    this.updateBadges();
  }

  private advanceAgendaPhase(): void {
    switch (state.ti.phase) {
      case 'agenda_reveal': this.startAgendaWhen(); break;
      case 'when_agenda_revealed': this.startAgendaAfter(); break;
      case 'after_agenda_revealed': this.startAgendaVote(); break;
      case 'agenda_vote':
        if (state.ti.executiveOrderHwid) this.startAgendaResolution();
        else this.completeAgenda();
        break;
      case 'agenda_argent': this.startSecretBallot(); break;
      case 'agenda_ballot': this.finishBallotsIfReady(); break;
      case 'agenda_resolve': this.completeAgenda(); break;
    }
    this.updateBadges();
  }

  private completeAgenda(): void {
    if (!TI_AGENDA_PHASES.includes(state.ti.phase ?? '')) return;
    if (state.ti.executiveOrderHwid) {
      this.finishExecutiveOrder();
      return;
    }
    this.clearAgendaBoxes();
    state.ti.agendaCount++;
    if (state.ti.agendaCount < 2) {
      this.revealAgenda();
      log('Second agenda — speaker reads', 'system');
    } else {
      this.startStatusPhase(true);
    }
  }

  private finishExecutiveOrder(): void {
    const hwid = state.ti.executiveOrderHwid;
    this.clearAgendaBoxes();
    state.ti.executiveOrderHwid = null;
    state.ti.agendaReadyHwids = [];
    state.ti.agendaTurnOrder = [];
    state.ti.phase = 'action';
    this.connectedPlayers().forEach(id => {
      state.boxes[id].status = state.ti.players[id]?.passed ? 'passed' : 'idle';
    });
    startPhase('action');
    if (hwid && state.boxes[hwid]?.status !== 'disconnected' && state.ti.turnOrder.includes(hwid)) {
      state.ti.actionTurnIndex = state.ti.turnOrder.indexOf(hwid);
    }
    this.activateActionTurn();
    log('Executive Order resolved — continue the action turn; do not ready planets', 'system');
  }

  private startAgendaWhen(): void {
    state.ti.phase = 'when_agenda_revealed';
    // Outside the agenda phase, ordinary action-phase ability timing still applies.
    const order = state.ti.executiveOrderHwid ? state.ti.turnOrder : state.boxOrder;
    const connected = order.filter(id => state.boxes[id]?.status !== 'disconnected');
    const speakerIndex = Math.max(0, connected.indexOf(this.agendaSpeaker ?? ''));
    state.ti.agendaTurnOrder = [
      ...connected.slice(speakerIndex), ...connected.slice(0, speakerIndex),
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
    this.clearAgendaBoxes();
    state.ti.agendaReadyHwids = [];
    const order = this.connectedPlayers();
    const speakerIndex = order.indexOf(this.agendaSpeaker ?? '');
    const leftIndex = (speakerIndex + 1) % Math.max(1, order.length);
    const normalVoteOrder = [...order.slice(leftIndex), ...order.slice(0, leftIndex)];
    state.ti.agendaTurnOrder = this.withArgentVotingFirst(normalVoteOrder);
    state.ti.agendaTurnIndex = 0;
    if (this.secretVoting) {
      const argent = this.factionPlayer('argent');
      if (argent) {
        state.ti.phase = 'agenda_argent';
        state.activeBoxId = argent;
        state.boxes[argent].status = 'agenda_vote';
        log('Hidden Agenda — Argent votes publicly first', 'system');
      } else {
        this.startSecretBallot();
      }
    } else {
      state.ti.phase = 'agenda_vote';
      this.activateAgendaTurn('agenda_vote');
      log('Agenda — voting', 'system');
    }
    this.updateBadges();
  }

  private startSecretBallot(): void {
    const argent = state.ti.phase === 'agenda_argent' ? this.factionPlayer('argent') : undefined;
    this.clearAgendaBoxes();
    state.ti.phase = 'agenda_ballot';
    state.ti.agendaReadyHwids = argent ? [argent] : [];
    this.connectedPlayers().forEach(id => {
      state.boxes[id].status = state.ti.agendaReadyHwids.includes(id) ? 'idle' : 'agenda_vote';
    });
    log('Hidden Agenda — submit ballots privately; press End when your ballot or abstention is submitted', 'system');
    this.finishBallotsIfReady();
    this.updateBadges();
  }

  private confirmBallot(hwid: string): void {
    if (state.ti.phase !== 'agenda_ballot' || !this.connectedPlayers().includes(hwid) || state.ti.agendaReadyHwids.includes(hwid)) return;
    state.ti.agendaReadyHwids.push(hwid);
    state.boxes[hwid].status = 'idle';
    log(`${getDisplayName(hwid)} confirms ballot submitted`, 'system');
    this.finishBallotsIfReady();
    this.updateBadges();
  }

  private finishBallotsIfReady(): void {
    if (this.connectedPlayers().every(id => state.ti.agendaReadyHwids.includes(id))) this.startAgendaResolution();
  }

  private startAgendaResolution(): void {
    this.clearAgendaBoxes();
    state.ti.phase = 'agenda_resolve';
    const speaker = this.agendaSpeaker;
    if (speaker && state.boxes[speaker]?.status !== 'disconnected') {
      state.activeBoxId = speaker;
      state.boxes[speaker].status = 'agenda_speaker';
    }
    log('Speaker tallies and resolves the agenda — confirm when complete', 'system');
    this.updateBadges();
  }

  private withArgentVotingFirst(order: string[]): string[] {
    const argentHwid = order.find(hwid => getFactionForBox(hwid)?.id === 'argent');
    if (!argentHwid) return order;
    return [argentHwid, ...order.filter(hwid => hwid !== argentHwid)];
  }

  private activateAgendaTurn(phase: string): void {
    const order = state.ti.agendaTurnOrder;
    if (state.ti.agendaTurnIndex >= order.length) {
      state.activeBoxId = null;
      this.advanceAgendaPhase();
      return;
    }
    const hwid = order[state.ti.agendaTurnIndex];
    if (state.boxes[hwid]?.status === 'disconnected') {
      state.ti.agendaTurnIndex++;
      this.activateAgendaTurn(phase);
      return;
    }
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
      if (hwid === state.ti.executiveOrderHwid) {
        badges.push({ type: 'text', value: 'Acting speaker', color: TI_AGENDA_SPEAKER_BLUE });
      }
      if (state.ti.phase === 'agenda_ballot') {
        badges.push({ type: 'text', value: getFactionForBox(hwid)?.id === 'argent' ? 'Public vote complete' : state.ti.agendaReadyHwids.includes(hwid) ? 'Ballot submitted' : 'Submit secret ballot', color: '#8888ff' });
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

  private flashSpeakerToken(hwid: string): void {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    resetActiveAnim();
    box.ledOverrideUntil = Date.now() + TI_SPEAKER_FLASH_MS;
    sendToBox(hwid, this.speakerLedPattern(TI_SPEAKER_FLASH_RED, box));
    setTimeout(() => { resetActiveAnim(); syncLeds(); }, TI_SPEAKER_FLASH_MS + 100);
  }

  private speakerLedPattern(color: string, box: Box | null): LedCommand {
    if (box?.isVirtual || supportsRepeatingLedSectors(box?.version)) {
      return { type: 'led_sectors', repeat: true, sectors: [
        { color: TI_SPEAKER_FLASH_WHITE, count: 1 },
        { color, count: 3 },
      ] };
    }
    // Expanding 3:1 into explicit sectors exceeds the 250-byte ESP-NOW limit.
    // Older firmware gets the existing compact 2:2 pattern until it is updated.
    return { type: 'led_alternate_pair', a: color, b: TI_SPEAKER_FLASH_WHITE };
  }
}
