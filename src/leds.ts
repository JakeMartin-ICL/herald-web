import { state } from './state';
import { sendToBox } from './websockets';
import { currentGame } from './currentGame';
import { log } from './logger';
import type { Box, LedCommand } from './types';

// ---- Brightness helpers ----
// Brightness is stored as a raw FastLED value: 1–255 (integer).
// The firmware uses this directly with FastLED.setBrightness().

function saveBoxBrightness(): void {
  try { localStorage.setItem('herald-box-brightness', JSON.stringify(state.boxBrightness)); } catch { /* ignore */ }
}

export function sendBrightnessToBox(hwid: string): void {
  const brightness = state.boxBrightness[hwid] ?? 255;
  sendToBox(hwid, { type: 'led_brightness', value: brightness });
}

export function setBrightness(hwid: string, brightness: number): void {
  state.boxBrightness[hwid] = brightness;
  saveBoxBrightness();
  sendBrightnessToBox(hwid);
}

export function receiveBoxBrightness(hwid: string, value: number): void {
  state.boxBrightness[hwid] = Math.round(value); // already 1–255
  saveBoxBrightness();
}

export const LED_COUNT = 24;

// ---- Array helpers (used for virtual box display only) ----

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

// ---- LedCommand → array (for virtual box SVG display) ----

export function ledCommandToArray(cmd: LedCommand): string[] {
  switch (cmd.type) {
    case 'led_off': return ledOff(LED_COUNT);
    case 'led_solid': return ledSolid(LED_COUNT, cmd.color);
    case 'led_alternate': return ledAlternate(LED_COUNT, cmd.color);
    case 'led_alternate_pair': return ledAlternatePair(LED_COUNT, cmd.a, cmd.b);
    case 'led_half': return ledHalf(LED_COUNT, cmd.color, cmd.first);
    case 'led_rainbow': return ledRainbow(LED_COUNT);
    case 'led_thirds': return ledThirds(LED_COUNT, cmd.c1, cmd.c2, cmd.c3);
    case 'led_sectors': return ledSectors(LED_COUNT, cmd.sectors);
    case 'led_raw': return cmd.leds;
    // Animations: show a representative static frame
    case 'led_anim_breathe': return cmd.rainbow ? ledRainbow(LED_COUNT) : ledSolid(LED_COUNT, cmd.color);
    case 'led_anim_spinner': return cmd.rainbow ? ledRainbow(LED_COUNT) : ledSolid(LED_COUNT, cmd.color);
    case 'led_anim_choosing': return ledSectors(LED_COUNT,
      cmd.colors.map(color => ({ color, count: Math.floor(LED_COUNT / cmd.colors.length) })));
    case 'led_anim_upkeep': return ledThirds(LED_COUNT, '#d4a017', '#e64da0', '#cc7700');
    case 'led_anim_stop': return ledOff(LED_COUNT);
    case 'led_brightness': return ledOff(LED_COUNT); // send-only command, not a display state
  }
}

// ---- Status → LedCommand ----

export function ledStateForStatus(status: string, box: Box | null = null, hwid: string | null = null): LedCommand {
  const gameLed = currentGame?.getLedForStatus?.(status, box, hwid);
  if (gameLed !== null && gameLed !== undefined) return gameLed;

  switch (status) {
    case 'active':
      return state.activePlayerStyle.rainbow ? { type: 'led_rainbow' } : { type: 'led_solid', color: activePlayerColor() };
    case 'passed':
      return { type: 'led_off' };
    case 'status':
      return { type: 'led_solid', color: '#8a0000' };
    case 'idle':
      return state.gameActive ? { type: 'led_off' } : { type: 'led_rainbow' };
    default:
      if (state.gameActive) log(`Unhandled LED status "${status}" in mode "${state.gameMode}"`, 'error');
      return { type: 'led_off' };
  }
}

// ---- Active player colour / animation helpers ----

export function activePlayerColor(): string {
  const s = state.activePlayerStyle;
  if (s.rainbow || s.hue === null) return '#ffffff';
  return hslToHex(s.hue, 100, 50);
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

export function normaliseColor(color: string): string {
  if (color.startsWith('#')) return color;
  const m = /hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/.exec(color);
  if (m) return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
  return '#000000';
}

// ---- syncLeds ----

export function syncLedsForBox(hwid: string): void {
  if (state.factionScanActive) return;
  const box = state.boxes[hwid];
  if (!box || box.isVirtual || box.status === 'disconnected') return;
  const now = Date.now();
  if (state.paused) { sendToBox(hwid, { type: 'led_off' }); return; }
  if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
  if (box.status === 'upkeep' || box.status === 'choosing' || box.countdownActive) return;
  const cmd = box.leds ?? ledStateForStatus(box.status, box, hwid);
  sendToBox(hwid, cmd);
}

export function syncLeds(): void {
  if (state.factionScanActive) return;
  const now = Date.now();
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.status === 'disconnected') return;
    if (state.paused && !box.isVirtual) { sendToBox(hwid, { type: 'led_off' }); return; }
    if (box.ledOverrideUntil && now < box.ledOverrideUntil) return;
    if (box.status === 'upkeep') return; // upkeep animation manages its own LEDs
    if (box.status === 'choosing' && !box.isVirtual) return; // choosing animation manages its own LEDs
    if (box.countdownActive && !box.isVirtual) return; // countdown animation manages its own LEDs

    if (box.status === 'active' && !box.isVirtual && state.activePlayerStyle.mode !== 'solid') {
      if (hwid !== activeAnimBox) {
        const s = state.activePlayerStyle;
        const cmd: LedCommand = s.mode === 'breathe'
          ? { type: 'led_anim_breathe', color: activePlayerColor(), rainbow: s.rainbow, halfPeriodMs: Math.round(4000 - s.speed * 3000) }
          : (() => { const stepMs = Math.round(120 - s.speed * 100); return { type: 'led_anim_spinner' as const, color: activePlayerColor(), rainbow: s.rainbow, stepMs, fadeMs: Math.min(25, stepMs) }; })();
        sendToBox(hwid, cmd);
        activeAnimBox = hwid;
      }
      return;
    }
    if (box.status !== 'active' && hwid === activeAnimBox) activeAnimBox = null;

    if (box.isVirtual) return; // virtual boxes: render.ts reads box.leds / ledStateForStatus directly
    const cmd = box.leds ?? ledStateForStatus(box.status, box, hwid);
    sendToBox(hwid, cmd);
  });
}
