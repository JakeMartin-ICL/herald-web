import { state } from './state';
import { sendToBox } from './websockets';

export const LED_COUNT = 24;

export function ledSolid(n: number, color: string): string[] {
  return Array(n).fill(color);
}

export function ledOff(n: number): string[] {
  return Array(n).fill('#000000');
}

export function ledAlternate(n: number, color: string): string[] {
  return Array.from({ length: n }, (_, i) => i % 2 === 0 ? color : '#000000');
}

export function ledAlternatePair(n: number, a: string, b: string): string[] {
  return Array.from({ length: n }, (_, i) => i % 2 === 0 ? a : b);
}

export function ledHalf(n: number, color: string, first: boolean): string[] {
  return Array.from({ length: n }, (_, i) => (i < n / 2) === first ? color : '#000000');
}

export function ledEveryFourth(n: number, color: string): string[] {
  return Array.from({ length: n }, (_, i) => i % 4 === 0 ? color : '#000000');
}

export function ledRainbow(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const hue = Math.round((i / n) * 360);
    return `hsl(${hue}, 100%, 50%)`;
  });
}

export function ledThirds(n: number, c1: string, c2: string, c3: string): string[] {
  const t = Math.floor(n / 3);
  return Array.from({ length: n }, (_, i) => {
    if (i < t) return c1;
    if (i < t * 2) return c2;
    return c3;
  });
}

export function ledSectors(n: number, sectors: { color: string; count: number }[]): string[] {
  const leds = ledOff(n);
  let pos = 0;
  for (const { color, count } of sectors) {
    for (let i = 0; i < count && pos < n; i++, pos++) {
      leds[pos] = color;
    }
  }
  return leds;
}

export function ledStateForStatus(status: string, box: { strategyColor?: string | null; choosingLeds?: string[] | null } | null = null, hwid: string | null = null): string[] {
  switch (status) {
    case 'active':       return ledSolid(LED_COUNT, '#c9a84c');
    case 'can-react':
      if (hwid && state.gameMode === 'eclipse' && hwid === state.eclipse.passOrder[0]) {
        return ledEveryFourth(LED_COUNT, '#d4a017');
      }
      return ledOff(LED_COUNT);
    case 'reacting':     return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':       return ledSolid(LED_COUNT, '#1a1a3a');
    case 'combat':       return ledSolid(LED_COUNT, '#8a0000');
    case 'upkeep':       return ledThirds(LED_COUNT, '#d4a017', '#e64da0', '#cc7700');
    case 'choosing':     return box?.choosingLeds ?? ledRainbow(LED_COUNT);
    case 'strategy':     return ledSolid(LED_COUNT, box?.strategyColor ?? '#ffffff');
    case 'secondary':    return ledAlternate(LED_COUNT, box?.strategyColor ?? '#ffffff');
    case 'status':
    case 'status2':      return ledSolid(LED_COUNT, '#8a0000');
    case 'agenda_speaker':        return ledAlternatePair(LED_COUNT, '#4444ff', '#ffffff');
    case 'when_agenda_revealed':  return ledHalf(LED_COUNT, '#ff6600', false);
    case 'after_agenda_revealed': return ledHalf(LED_COUNT, '#ff6600', true);
    case 'agenda_vote':           return ledSolid(LED_COUNT, '#0000ff');
    case 'idle':
    default:             return state.gameActive ? ledOff(LED_COUNT) : ledRainbow(LED_COUNT);
  }
}

export function syncLeds(): void {
  if (state.factionScanActive) return; // faction scan manages its own LEDs
  const now = Date.now();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
    if (box.status === 'upkeep') return; // upkeep animation manages its own LEDs

    let leds: string[];
    if (box.leds) {
      leds = box.leds;
    } else {
      leds = ledStateForStatus(box.status, box, hwid);
    }

    if (!box.isVirtual) sendToBox(hwid, { type: 'led', leds });
  });
}
