import { extractPersistableState, restoreState } from './persist';
import { log } from './logger';
import { stopCurrentTimerInterval, needsTimerInterval, startCurrentTimerInterval } from './timers';

const UNDO_MAX = 32;
type Snapshot = ReturnType<typeof extractPersistableState>;
const undoStack: Snapshot[] = [];

export function snapshotForUndo(): void {
  undoStack.push(extractPersistableState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

export function undo(): void {
  if (undoStack.length === 0) { log('Nothing to undo', 'system'); return; }
  const snapshot = undoStack.pop()!;
  restoreState(snapshot, true);
  stopCurrentTimerInterval();
  if (needsTimerInterval()) startCurrentTimerInterval();
  log('Undo', 'system');
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function clearUndoHistory(): void {
  undoStack.length = 0;
}
