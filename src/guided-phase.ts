import { state } from './state';
import { log } from './logger';

export function startGuidedPhase(steps: string[]): void {
  state.guidedPhaseSteps = steps;
  state.guidedPhaseIndex = 0;
  log(`Guided phase step 1/${steps.length}: ${steps[0]}`, 'system');
}

/** Advance to the next step. Returns true if more steps remain, false when all done (and clears). */
export function advanceGuidedPhase(): boolean {
  state.guidedPhaseIndex++;
  if (state.guidedPhaseIndex >= state.guidedPhaseSteps.length) {
    clearGuidedPhase();
    return false;
  }
  const step = state.guidedPhaseSteps[state.guidedPhaseIndex];
  log(`Guided phase step ${state.guidedPhaseIndex + 1}/${state.guidedPhaseSteps.length}: ${step}`, 'system');
  return true;
}

export function clearGuidedPhase(): void {
  state.guidedPhaseSteps = [];
  state.guidedPhaseIndex = 0;
}

export function isGuidedPhaseActive(): boolean {
  return state.guidedPhaseIndex < state.guidedPhaseSteps.length;
}

/** Current instruction text, or null if not active. */
export function currentGuidedStep(): string | null {
  if (!isGuidedPhaseActive()) return null;
  return state.guidedPhaseSteps[state.guidedPhaseIndex] ?? null;
}

/** "3/8" style progress string for UI display, or empty string if not active. */
export function guidedPhaseProgress(): string {
  if (!isGuidedPhaseActive()) return '';
  return `${state.guidedPhaseIndex + 1}/${state.guidedPhaseSteps.length}`;
}
