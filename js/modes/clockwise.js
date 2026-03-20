// ---- Clockwise mode ----

function clockwiseStart() {
  state.round++;
  const firstId = state.boxOrder[0];
  state.activeBoxId = firstId;
  state.boxes[firstId].status = 'active';
  log(`Round ${state.round} — ${getDisplayName(firstId)} goes first`, 'system');
}

function clockwiseNextPlayer() {
  const currentIndex = state.boxOrder.indexOf(state.activeBoxId);
  for (let i = 1; i <= state.boxOrder.length; i++) {
    const nextIndex = (currentIndex + i) % state.boxOrder.length;
    const nextId = state.boxOrder[nextIndex];
    const status = state.boxes[nextId].status;
    if (status !== 'passed' && status !== 'disconnected') {
      if (state.boxes[state.activeBoxId].status !== 'passed') {
        state.boxes[state.activeBoxId].status = 'idle';
      }
      state.activeBoxId = nextId;
      state.boxes[nextId].status = 'active';
      // In non-passing clockwise, wrapping to the first player starts a new round
      if (state.gameMode === 'clockwise' && nextIndex === 0) {
        state.round++;
        log(`Round ${state.round} — ${getDisplayName(nextId)}'s turn`, 'system');
      } else {
        log(`${getDisplayName(nextId)}'s turn`, 'system');
      }
      return;
    }
  }
  clockwiseEndRound();
}

function clockwiseEndTurn(hwid) {
  if (hwid !== state.activeBoxId) return;
  clockwiseNextPlayer();
}

function clockwisePass(hwid) {
  if (hwid !== state.activeBoxId) return;
  state.boxes[hwid].status = 'passed';
  log(`${getDisplayName(hwid)} passed`, 'system');

  const allDone = state.boxOrder.every(id =>
    state.boxes[id].status === 'passed' ||
    state.boxes[id].status === 'disconnected'
  );

  if (allDone) {
    clockwiseEndRound();
  } else {
    clockwiseNextPlayer();
  }
}

function clockwiseEndRound() {
  log('Round over — all players passed', 'system');
  state.boxOrder.forEach(id => {
    if (state.boxes[id].status !== 'disconnected') {
      state.boxes[id].status = 'idle';
    }
  });
  state.activeBoxId = null;
}
