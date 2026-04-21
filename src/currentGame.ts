import type { GameMode } from './types';

// Held separately from game.ts so tags.ts and render.ts can read it
// without creating a circular import through game.ts → modes → render/tags → game.ts.

export let currentGame: GameMode | null = null;
export let setupGame: GameMode | null = null;

export function setCurrentGame(g: GameMode | null): void {
  currentGame = g;
}

export function setSetupGame(g: GameMode | null): void {
  setupGame = g;
}
