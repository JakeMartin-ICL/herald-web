// ---- TI mode ----

// ---- Relevant tags for sim ----

function tiRelevantTags(hwid) {
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

const TI_STRATEGY_COLORS = {
  leadership:   '#cc0000',
  diplomacy:    '#ff8800',
  politics:     '#dddd00',
  construction: '#00aa00',
  trade:        '#00aaaa',
  warfare:      '#0055ff',
  technology:   '#000066',
  imperial:     '#660088',
};

const TI_STRATEGY_INITIATIVES = {
  leadership: 1, diplomacy: 2, politics: 3, construction: 4,
  trade: 5, warfare: 6, technology: 7, imperial: 8,
};

const TI_STRATEGY_LABELS = {
  leadership: 'Leadership', diplomacy: 'Diplomacy', politics: 'Politics',
  construction: 'Construction', trade: 'Trade', warfare: 'Warfare',
  technology: 'Technology', imperial: 'Imperial',
};

function tiStart() {
  const speakerHwid = document.getElementById('ti-speaker').value;
  state.ti.speakerHwid = speakerHwid;
  state.round = 1;
  state.ti.phase = null;
  state.ti.players = {};

  // Initialise per-player state
  state.boxOrder.forEach(hwid => {
    state.ti.players[hwid] = {
      hwid,
      strategyCards: [],
      passed: false,
      confirmedSecondary: false,
    };
  });

  log(`TI started — Round 1, Speaker: ${getDisplayName(speakerHwid)}`, 'system');
  tiStartStrategyPhase();
}

// ---- TI Status Phase ----

function tiStartStatusPhase(isPostAgenda = false) {
  state.ti.phase = isPostAgenda ? 'status2' : 'status';
  startPhase('status');
  state.activeBoxId = null;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = isPostAgenda ? 'status2' : 'status';
  });
  log(`Status phase — long press hub to continue`, 'system');
  updateTiBadges();
}

function tiLongPress(hwid) {
  if (hwid !== state.hubHwid) return;
  switch (state.ti.phase) {
    case 'status':
      if (state.ti.mecatolControlled) {
        tiStartAgendaPhase();
      } else {
        tiEndRound();
      }
      break;
    case 'status2':
      tiEndRound();
      break;
    case 'agenda_reveal':
    case 'when_agenda_revealed':
    case 'after_agenda_revealed':
    case 'agenda_vote':
      tiAdvanceAgendaPhase();
      break;
  }
}

// ---- TI Strategy Phase ----

function tiStartStrategyPhase() {
  state.ti.phase = 'strategy';
  startPhase('strategy');
  state.activeBoxId = null;

  // Reset all strategy cards
  state.boxOrder.forEach(hwid => {
    state.ti.players[hwid].strategyCards = [];
    state.ti.players[hwid].passed = false;
    state.boxes[hwid].status = 'idle';
  });

  // Build clockwise order from speaker
  const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid);
  state.ti.turnOrder = [
    ...state.boxOrder.slice(speakerIndex),
    ...state.boxOrder.slice(0, speakerIndex),
  ];

  // For 4 or fewer players, go around twice
  if (state.boxOrder.length <= 4) {
    state.ti.turnOrder = [...state.ti.turnOrder, ...state.ti.turnOrder];
  }

  state.ti.strategyTurnIndex = 0;
  tiActivateStrategyTurn();
  log('Strategy phase', 'system');
}

function tiActivateStrategyTurn() {
  // Skip players who already have 2 cards (4-player case)
  while (state.ti.strategyTurnIndex < state.ti.turnOrder.length) {
    const hwid = state.ti.turnOrder[state.ti.strategyTurnIndex];
    const player = state.ti.players[hwid];
    if (player.strategyCards.length < 2) break;
    state.ti.strategyTurnIndex++;
  }

  if (state.ti.strategyTurnIndex >= state.ti.turnOrder.length) {
    // All players have their cards
    tiEndStrategyPhase();
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
  state.boxes[hwid].choosingLeds = ledSectors(LED_COUNT, [
    '#cc0000', '#ff8800', '#dddd00', '#00aa00',
    '#00aaaa', '#0055ff', '#000066', '#660088',
  ]);
  log(`${getDisplayName(hwid)} picks a strategy card`, 'system');
  updateTiBadges();
}

function tiUndoStrategyPick() {
  // Find previous player who has a card and remove their last pick
  let idx = state.ti.strategyTurnIndex - 1;
  while (idx >= 0) {
    const hwid = state.ti.turnOrder[idx];
    const player = state.ti.players[hwid];
    if (player.strategyCards.length > 0) {
      const removed = player.strategyCards.pop();
      log(`Undid ${getDisplayName(hwid)}'s pick: ${removed.label}`, 'system');
      state.ti.strategyTurnIndex = idx;
      // Reactivate that player
      if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
      disableAllRfid();
      state.activeBoxId = hwid;
      enableRfid(hwid);
      state.boxes[hwid].status = 'choosing';
      state.boxes[hwid].choosingLeds = ledSectors(LED_COUNT, [
        '#cc0000', '#ff8800', '#dddd00', '#00aa00',
        '#00aaaa', '#0055ff', '#000066', '#660088',
      ]);
      updateTiBadges();
      return;
    }
    idx--;
  }
  log('Nothing to undo', 'system');
}

function tiEndStrategyPhase() {
  log('Strategy phase complete', 'system');
  if (state.activeBoxId) {
    state.boxes[state.activeBoxId].status = 'idle';
    state.activeBoxId = null;
  }
  tiStartActionPhase();
}

// ---- TI Action Phase ----

function tiStartActionPhase() {
  state.ti.phase = 'action';
  state.ti.secondary = null;
  startPhase('action');

  // Reset passed state
  state.boxOrder.forEach(hwid => {
    state.ti.players[hwid].passed = false;
    state.ti.players[hwid].confirmedSecondary = false;
    state.boxes[hwid].status = 'idle';
  });

  // Build turn order by lowest initiative
  state.ti.turnOrder = [...state.boxOrder].sort((a, b) => {
    const aInit = tiLowestInitiative(a);
    const bInit = tiLowestInitiative(b);
    return aInit - bInit;
  });

  state.ti.actionTurnIndex = 0;
  tiActivateActionTurn();
  log('Action phase', 'system');
}

function tiLowestInitiative(hwid) {
  const cards = state.ti.players[hwid].strategyCards;
  if (cards.length === 0) return 999;
  return Math.min(...cards.map(c => c.initiative));
}

function tiActivateActionTurn() {
  // Find next non-passed player
  const order = state.ti.turnOrder;
  let found = false;

  for (let i = 0; i < order.length; i++) {
    const idx = (state.ti.actionTurnIndex + i) % order.length;
    const hwid = order[idx];
    const player = state.ti.players[hwid];
    if (!player.passed && state.boxes[hwid].status !== 'disconnected') {
      if (state.activeBoxId && state.activeBoxId !== hwid) {
        state.boxes[state.activeBoxId].status = 'idle';
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
    tiEndActionPhase();
  }
  updateTiBadges();
}

function tiEndTurn(hwid) {
  switch (state.ti.phase) {
    case 'strategy':
      // End turn without picking — shouldn't normally happen
      // but allow advancing if hub presses
      if (hwid === state.hubHwid) {
        state.ti.strategyTurnIndex++;
        tiActivateStrategyTurn();
      }
      break;

    case 'action':
      if (state.ti.secondary) {
        tiConfirmSecondary(hwid);
      } else {
        if (hwid !== state.activeBoxId) return;
        // Regular action end turn
        state.ti.actionTurnIndex =
          (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
        tiActivateActionTurn();
      }
      break;

    case 'agenda_reveal':
      if (hwid === state.activeBoxId) tiAdvanceAgendaPhase();
      break;
    case 'when_agenda_revealed':
    case 'after_agenda_revealed':
    case 'agenda_vote':
      tiAgendaEndTurn(hwid);
      break;
  }
}

function tiPass(hwid) {
  switch (state.ti.phase) {
    case 'strategy':
      // Pass on hub undoes previous pick
      if (hwid === state.hubHwid) {
        tiUndoStrategyPick();
      }
      break;

    case 'action':
      if (state.ti.secondary) {
        if (hwid === state.ti.secondary.activeHwid) {
          // Active player cancels their strategy card use
          const secondary = state.ti.secondary;
          const card = state.ti.players[hwid].strategyCards.find(c => c.id === secondary.cardId);
          if (card) card.used = false;
          // Reset all secondary boxes to idle
          secondary.pendingHwids.forEach(id => {
            if (state.boxes[id].status === 'secondary') {
              state.boxes[id].status = 'idle';
            }
          });
          state.ti.secondary = null;
          state.boxes[hwid].status = 'active';
          log(`${getDisplayName(hwid)} cancels ${secondary.cardId} use`, 'system');
          updateTiBadges();
        } else {
          // Other player skips secondary
          tiConfirmSecondary(hwid);
        }
      } else {
        if (hwid !== state.activeBoxId) return;
        // Can only pass if all strategy cards used
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
          tiEndActionPhase();
        } else {
          state.ti.actionTurnIndex =
            (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
          tiActivateActionTurn();
        }
      }
      break;
  }
}

// ---- TI Strategy Card Use ----

function tiUseStrategyCard(hwid, card) {
  if (hwid !== state.activeBoxId) return;
  if (state.ti.phase !== 'action') return;
  if (card.used) {
    // Cancel strategy card use — return to normal active state
    state.boxes[hwid].status = 'active';
    state.ti.secondary = null;
    log(`${getDisplayName(hwid)} cancels ${card.label} use`, 'system');
    updateTiBadges();
    return;
  }

  // Mark card as being used — light box in card colour alternating white
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
  };

  // Reset all confirmed secondary flags
  state.boxOrder.forEach(id => {
    state.ti.players[id].confirmedSecondary = false;
  });

  log(`${getDisplayName(hwid)} uses ${card.label} — secondaries pending`, 'system');

  const mode = state.ti.secondaryMode;
  if (mode === 'fastest') {
    // Light up all other players immediately
    otherPlayers.forEach(id => {
      state.boxes[id].status = 'secondary';
      state.boxes[id].strategyColor = card.color;
    });
  } else if (mode === 'fast') {
    // Will light up when active player presses end turn
    // Nothing to do yet
  } else if (mode === 'standard') {
    // Light up first player clockwise from active
    tiActivateNextSecondary();
  }

  updateTiBadges();
}

function tiActivateNextSecondary() {
  const secondary = state.ti.secondary;
  if (!secondary) return;

  // Find next unconfirmed player clockwise from active
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

function tiConfirmSecondary(hwid) {
  const secondary = state.ti.secondary;
  if (!secondary) return;

  if (hwid === secondary.activeHwid) {
    if (state.ti.secondaryMode === 'fast') {
      // Active player ends their turn — light up all others for secondary
      secondary.pendingHwids.forEach(id => {
        if (state.boxes[id].status !== 'disconnected') {
          state.boxes[id].status = 'secondary';
          state.boxes[id].strategyColor = secondary.cardColor;
        }
      });
      secondary.activeTurnEnded = true;
      state.boxes[hwid].status = 'idle';
      state.activeBoxId = null;
    } else if (state.ti.secondaryMode === 'fastest') {
      // Active player finished primary — secondaries already running
      secondary.activeTurnEnded = true;
      state.boxes[hwid].status = 'idle';
      state.activeBoxId = null;
      // Secondaries may have all confirmed already — check and advance if so
      const allConfirmed = secondary.pendingHwids.every(id =>
        state.ti.players[id].confirmedSecondary ||
        state.boxes[id].status === 'disconnected'
      );
      if (allConfirmed) {
        log('All secondaries confirmed — advancing turn', 'system');
        state.ti.secondary = null;
        state.ti.actionTurnIndex =
          (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
        tiActivateActionTurn();
      }
    }
    // In standard mode the active player doesn't end turn while secondaries run
    return;
  }

  // Other players confirming secondary
  if (!secondary.pendingHwids.includes(hwid)) return;
  state.ti.players[hwid].confirmedSecondary = true;
  state.boxes[hwid].status = 'idle';

  if (state.ti.secondaryMode === 'standard') {
    tiActivateNextSecondary();
  }

  // Check if all confirmed
  const allConfirmed = secondary.pendingHwids.every(id =>
    state.ti.players[id].confirmedSecondary ||
    state.boxes[id].status === 'disconnected'
  );

  if (allConfirmed) {
    log('All secondaries confirmed — advancing turn', 'system');
    state.ti.secondary = null;

    if (secondary.activeTurnEnded) {
      // Active player already ended their turn (fast mode) — advance now
      state.ti.actionTurnIndex =
        (state.ti.actionTurnIndex + 1) % state.ti.turnOrder.length;
      tiActivateActionTurn();
    } else {
      // Fastest/standard — active player still needs to end their turn
      // In fastest mode they're still executing their primary (strategy status);
      // in standard mode secondaries go sequentially so active is done with primary.
      const wasStrategy = state.boxes[secondary.activeHwid].status === 'strategy';
      state.boxes[secondary.activeHwid].status = wasStrategy ? 'strategy' : 'active';
      disableAllRfid();
      state.activeBoxId = secondary.activeHwid;
      enableRfid(secondary.activeHwid);
    }
    updateTiBadges();
    render();
  }

  updateTiBadges();
}

function tiEndActionPhase() {
  log('Action phase over', 'system');
  state.activeBoxId = null;
  tiStartStatusPhase();
}

// ---- TI Agenda Phase ----

function tiStartAgendaPhase() {
  state.ti.phase = 'agenda_reveal';
  startPhase('agenda');
  state.ti.agendaCount = 0; // 0 or 1 (two agendas per round)
  state.activeBoxId = null;
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
  });

  // Speaker lights up blue+white
  state.boxes[state.ti.speakerHwid].status = 'agenda_speaker';
  disableAllRfid();
  state.activeBoxId = state.ti.speakerHwid;
  enableRfid(state.ti.speakerHwid);
  log('Agenda phase — speaker reads agenda', 'system');
  updateTiBadges();
}

function tiAdvanceAgendaPhase() {
  switch (state.ti.phase) {
    case 'agenda_reveal':
      // Move to "when revealed" action cards
      tiStartAgendaWhen();
      break;
    case 'when_agenda_revealed':
      tiStartAgendaAfter();
      break;
    case 'after_agenda_revealed':
      tiStartAgendaVote();
      break;
    case 'agenda_vote':
      state.ti.agendaCount++;
      if (state.ti.agendaCount < 2) {
        // Second agenda
        state.ti.phase = 'agenda_reveal';
        state.boxes[state.ti.speakerHwid].status = 'agenda_speaker';
        disableAllRfid();
        state.activeBoxId = state.ti.speakerHwid;
        enableRfid(state.ti.speakerHwid);
        log('Second agenda — speaker reads', 'system');
      } else {
        // Agenda phase complete
        tiStartStatusPhase(true);
      }
      break;
  }
  updateTiBadges();
}

function tiStartAgendaWhen() {
  state.ti.phase = 'when_agenda_revealed';
  // Build clockwise order from speaker
  const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid);
  state.ti.agendaTurnOrder = [
    ...state.boxOrder.slice(speakerIndex),
    ...state.boxOrder.slice(0, speakerIndex),
  ];
  state.ti.agendaTurnIndex = 0;
  if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
  tiActivateAgendaTurn('when_agenda_revealed');
  log('Agenda — "when revealed" action cards', 'system');
}

function tiStartAgendaAfter() {
  state.ti.phase = 'after_agenda_revealed';
  state.ti.agendaTurnIndex = 0;
  if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
  tiActivateAgendaTurn('after_agenda_revealed');
  log('Agenda — "after revealed" action cards', 'system');
}

function tiStartAgendaVote() {
  state.ti.phase = 'agenda_vote';
  // Voting starts with player left of speaker
  const speakerIndex = state.boxOrder.indexOf(state.ti.speakerHwid);
  const leftIndex = (speakerIndex + 1) % state.boxOrder.length;
  state.ti.agendaTurnOrder = [
    ...state.boxOrder.slice(leftIndex),
    ...state.boxOrder.slice(0, leftIndex),
  ];
  state.ti.agendaTurnIndex = 0;
  if (state.activeBoxId) state.boxes[state.activeBoxId].status = 'idle';
  tiActivateAgendaTurn('agenda_vote');
  log('Agenda — voting', 'system');
}

function tiActivateAgendaTurn(phase) {
  const order = state.ti.agendaTurnOrder;
  if (state.ti.agendaTurnIndex >= order.length) {
    state.activeBoxId = null;
    tiAdvanceAgendaPhase();
    return;
  }
  const hwid = order[state.ti.agendaTurnIndex];
  if (state.activeBoxId && state.activeBoxId !== hwid) {
    state.boxes[state.activeBoxId].status = 'idle';
  }
  disableAllRfid();
  state.activeBoxId = hwid;
  enableRfid(hwid);
  state.boxes[hwid].status = phase;
}

function tiAgendaEndTurn(hwid) {
  if (hwid !== state.activeBoxId) return;
  state.boxes[hwid].status = 'idle';
  state.ti.agendaTurnIndex++;
  tiActivateAgendaTurn(state.ti.phase);
  updateTiBadges();
}

// ---- TI Round end ----

function tiEndRound() {
  log(`Round ${state.round} complete`, 'system');
  state.round++;

  // Advance speaker if politics was played
  // (handled via RFID tap on speaker token during action phase)
  // Reset all boxes
  state.boxOrder.forEach(hwid => {
    state.boxes[hwid].status = 'idle';
    state.ti.players[hwid].strategyCards = [];
    state.ti.players[hwid].passed = false;
  });
  state.activeBoxId = null;
  state.ti.secondary = null;

  tiStartStrategyPhase();
}

function tiMecatolChanged() {
  state.ti.mecatolControlled = document.getElementById('ti-mecatol').checked;
  log(`Mecatol Rex ${state.ti.mecatolControlled ? 'controlled' : 'not controlled'}`, 'system');
}

// ---- TI Badges ----

function updateTiBadges() {
  if (state.gameMode !== 'ti') return;
  state.boxOrder.forEach(hwid => {
    const player = state.ti.players[hwid];
    if (!player) return;
    const badges = [];
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
