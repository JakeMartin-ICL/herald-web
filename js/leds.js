// ---- LED helpers ----

const LED_COUNT = 24;

function ledSolid(n, color) {
  return Array(n).fill(color);
}

function ledAlternate(n, color) {
  return Array.from({ length: n }, (_, i) => i % 2 === 0 ? color : '#000000');
}

function ledThirds(n, a, b, c) {
  return Array.from({ length: n }, (_, i) => {
    const third = Math.floor(i / (n / 3));
    return [a, b, c][third];
  });
}

function ledOff(n) {
  return Array(n).fill('#000000');
}

function ledEveryFourth(n, color) {
  return Array.from({ length: n }, (_, i) => i % 4 === 0 ? color : '#000000');
}

function ledRainbow(n) {
  return Array.from({ length: n }, (_, i) => {
    const hue = Math.round((i / n) * 360);
    return `hsl(${hue}, 100%, 50%)`;
  });
}

function ledAlternatePair(n, a, b) {
  return Array.from({ length: n }, (_, i) => i % 2 === 0 ? a : b);
}

function ledHalf(n, color, first) {
  return Array.from({ length: n }, (_, i) => (i < n / 2) === first ? color : '#000000');
}

function ledSectors(n, colors) {
  const count = colors.length;
  return Array.from({ length: n }, (_, i) => {
    const sector = Math.floor(i / (n / count));
    return colors[Math.min(sector, count - 1)];
  });
}

function ledStateForStatus(status, box = null, hwid = null) {
  switch (status) {
    case 'active':       return ledSolid(LED_COUNT, '#c9a84c');
    case 'can-react':
      if (hwid && state.gameMode === 'eclipse' && hwid === state.eclipse.passOrder[0]) {
        return ledEveryFourth(LED_COUNT, '#d4a017'); // gold — first to pass, gains 2 money
      }
      return ledOff(LED_COUNT);
    case 'reacting':     return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':       return ledSolid(LED_COUNT, '#1a1a3a');
    case 'combat':       return ledSolid(LED_COUNT, '#8a0000');
    case 'upkeep':       return ledThirds(LED_COUNT, '#d4a017', '#e64da0', '#cc7700');
    case 'disconnected': return ledOff(LED_COUNT);
    case 'choosing':     return box?.choosingLeds || ledRainbow(LED_COUNT);
    case 'strategy':     return ledSolid(LED_COUNT, box?.strategyColor || '#ffffff');
    case 'secondary':    return ledAlternate(LED_COUNT, box?.strategyColor || '#ffffff');
    case 'status':       return ledSolid(LED_COUNT, '#8a0000');
    case 'status2':      return ledSolid(LED_COUNT, '#8a0000');
    case 'agenda_speaker': return ledAlternatePair(LED_COUNT, '#4444ff', '#ffffff');
    case 'when_agenda_revealed':  return ledHalf(LED_COUNT, '#ff6600', false);
    case 'after_agenda_revealed': return ledHalf(LED_COUNT, '#ff6600', true);
    case 'agenda_vote':  return ledSolid(LED_COUNT, '#0000ff');
    default:             return state.gameActive ? ledOff(LED_COUNT) : ledRainbow(LED_COUNT);
  }
}

function syncLeds() {
  if (state.factionScanActive) return; // faction scan manages its own LEDs
  const now = Date.now();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
    if (box.status === 'upkeep') return; // upkeep animation manages its own LEDs
    const leds = ledStateForStatus(box.status, box, hwid);
    box.leds = leds;
    if (!box.isVirtual) {
      sendToBox(hwid, { type: 'led', leds });
    }
  });
}
