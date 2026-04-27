import { state } from './state';
import { sendToBox } from './websockets';
import { getDisplayName } from './boxes';
import { currentGuidedStep, guidedPhaseProgress } from './guided-phase';
import { currentGame } from './currentGame';
import type { BoxStatus, DisplayBoxSettings } from './types';

const STATUS_LABELS: Partial<Record<BoxStatus, string>> = {
  active:                 'Active',
  'can-react':            'Can React',
  reacting:               'Reacting',
  passed:                 'Passed',
  combat:                 'Combat',
  makers:                 'Makers',
  recall:                 'Recall',
  upkeep:                 'Upkeep',
  choosing:               'Choosing',
  strategy:               'Strategy',
  secondary:              'Secondary',
  status:                 'Status Phase',
  status2:                'Status Phase',
  agenda_speaker:         'Speaker',
  when_agenda_revealed:   'When Revealed',
  after_agenda_revealed:  'After Revealed',
  agenda_vote:            'Voting',
};

export function syncDisplay(): void {
  const guidedStep = currentGuidedStep();
  const guidedProgress = guidedPhaseProgress();

  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;

    // Guided phase overrides name/status on all boxes
    if (guidedStep !== null) {
      sendToBox(hwid, { type: 'display', name: guidedStep, status: guidedProgress });
      return;
    }

    // Mode-level per-box override (e.g. Inis assembly steps)
    const boxDisplay = currentGame?.getBoxDisplay?.(hwid);
    if (boxDisplay !== null && boxDisplay !== undefined) {
      sendToBox(hwid, { type: 'display', name: '', status: '', ...boxDisplay });
      return;
    }

    const name   = getDisplayName(hwid);
    const status = STATUS_LABELS[box.status] ?? '';
    const settings: DisplayBoxSettings = state.displaySettings[hwid] ?? { showRound: false, showTimer: false, message: '' };

    const msg: Record<string, unknown> = { type: 'display', name, status };

    if (settings.showRound) {
      msg.round = state.round;
    }
    if (settings.showTimer) {
      const running = !!box.turnStartTime;
      msg.timerRunning = running;
      msg.timerSecs = running ? Math.floor((Date.now() - box.turnStartTime!) / 1000) : 0;
    }
    if (settings.message) {
      msg.message = settings.message.slice(0, 21);
    }

    sendToBox(hwid, msg);
  });
}
