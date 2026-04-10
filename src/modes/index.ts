import { ClockwiseMode, ClockwisePassMode } from './clockwise';
import { EclipseMode } from './eclipse';
import { TwilightImperiumMode } from './ti';
import { KemetMode } from './kemet';
import { InisMode } from './inis';
import type { GameMode } from '../types';

export const MODE_NAMES: Record<string, string> = {
  clockwise:      'Clockwise',
  clockwise_pass: 'Clockwise with Passing',
  eclipse:        'Eclipse',
  ti:             'Twilight Imperium',
  kemet:          'Kemet',
  inis:           'Inis',
};

export function createGameMode(id: string): GameMode | null {
  switch (id) {
    case 'clockwise':      return new ClockwiseMode();
    case 'clockwise_pass': return new ClockwisePassMode();
    case 'eclipse':        return new EclipseMode();
    case 'ti':             return new TwilightImperiumMode();
    case 'kemet':          return new KemetMode();
    case 'inis':           return new InisMode();
    default:               return null;
  }
}
