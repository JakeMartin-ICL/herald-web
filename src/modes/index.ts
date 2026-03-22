import { ClockwiseMode, ClockwisePassMode } from './clockwise';
import { EclipseMode } from './eclipse';
import { TwilightImperiumMode } from './ti';
import type { GameMode } from '../types';

export function createGameMode(id: string): GameMode | null {
  switch (id) {
    case 'clockwise':      return new ClockwiseMode();
    case 'clockwise_pass': return new ClockwisePassMode();
    case 'eclipse':        return new EclipseMode();
    case 'ti':             return new TwilightImperiumMode();
    default:               return null;
  }
}
