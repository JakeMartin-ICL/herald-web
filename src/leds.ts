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
  return Array.from({ length: n }, (_, i) => i % 4 < 2 ? color : '#000000');
}

export function ledAlternatePair(n: number, a: string, b: string): string[] {
  return Array.from({ length: n }, (_, i) => i % 4 < 2 ? a : b);
}

export function ledHalf(n: number, color: string, first: boolean): string[] {
  return Array.from({ length: n }, (_, i) => (i < n / 2) === first ? color : '#000000');
}

export function ledEveryFourth(n: number, color: string): string[] {
  return Array.from({ length: n }, (_, i) => i % 4 < 2 ? color : '#000000');
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
    case 'active':       return ledSolid(LED_COUNT, state.activePlayerStyle.rainbow ? '#ffffff' : activePlayerColor());
    case 'can-react':
      if (hwid && state.gameMode === 'eclipse' && hwid === state.eclipse.passOrder[0]) {
        return ledEveryFourth(LED_COUNT, '#d4a017');
      }
      return ledOff(LED_COUNT);
    case 'reacting':     return ledAlternate(LED_COUNT, '#3a3aff');
    case 'passed':
      if (hwid && state.gameMode === 'eclipse' && hwid === state.eclipse.passOrder[0]) {
        return ledEveryFourth(LED_COUNT, '#d4a017');
      }
      return ledOff(LED_COUNT);
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

interface LedAnimFrame { leds: string[]; ms: number; fade?: boolean }

function scaleHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const h = (v: number): string => Math.min(255, Math.round(v * factor)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function activePlayerColor(): string {
  const s = state.activePlayerStyle;
  if (s.rainbow || s.hue === null) return '#ffffff';
  return hslToHex(s.hue, 100, 50);
}

export function buildBreathFrames(): LedAnimFrame[] {
  const s = state.activePlayerStyle;
  const color = activePlayerColor();
  const halfPeriod = Math.round(4000 - s.speed * 3000);
  const dim = scaleHex(color, 0.05);
  return [
    { leds: ledSolid(LED_COUNT, color), ms: halfPeriod, fade: true },
    { leds: ledSolid(LED_COUNT, dim),   ms: halfPeriod, fade: true },
  ];
}

export function buildSpinnerFrames(): LedAnimFrame[] {
  const s = state.activePlayerStyle;
  const baseColor = activePlayerColor();
  const stepMs = Math.round(80 - s.speed * 60);
  const tail = [1.0, 0.7, 0.4, 0.15, 0.03];
  return Array.from({ length: LED_COUNT }, (_, headPos) => {
    const headColor = s.rainbow
      ? hslToHex(Math.round((headPos / LED_COUNT) * 360), 100, 50)
      : baseColor;
    const leds: string[] = Array(LED_COUNT).fill('#000000');
    for (let t = 0; t < tail.length; t++) {
      const pos = (headPos - t + LED_COUNT) % LED_COUNT;
      leds[pos] = scaleHex(headColor, tail[t]);
    }
    return { leds, ms: stepMs, fade: true };
  });
}

// Tracks which box is currently running a firmware active-player animation.
// Reset by resetActiveAnim() when style changes or to force a resend.
let activeAnimBox: string | null = null;
export function resetActiveAnim(): void { activeAnimBox = null; }

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)))
      .toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function normalizeColor(color: string): string {
  if (color.startsWith('#')) return color;
  const m = /hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/.exec(color);
  if (m) return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
  return '#000000';
}

export function syncLeds(): void {
  if (state.factionScanActive) return; // faction scan manages its own LEDs
  const now = Date.now();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
    if (box.status === 'upkeep') return; // upkeep animation manages its own LEDs
    if (box.status === 'choosing' && !box.isVirtual) return; // choosing animation manages its own LEDs

    if (box.status === 'active' && !box.isVirtual && state.activePlayerStyle.mode !== 'solid') {
      if (hwid !== activeAnimBox) {
        const frames = state.activePlayerStyle.mode === 'breathe'
          ? buildBreathFrames()
          : buildSpinnerFrames();
        sendToBox(hwid, { type: 'led_anim', loop: true, frames });
        activeAnimBox = hwid;
      }
      return;
    }
    if (box.status !== 'active' && hwid === activeAnimBox) activeAnimBox = null;

    const leds = (box.leds ?? ledStateForStatus(box.status, box, hwid)).map(normalizeColor);
    if (!box.isVirtual) sendToBox(hwid, { type: 'led', leds });
  });
}
