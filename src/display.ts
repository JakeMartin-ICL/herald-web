import { state } from './state';
import { sendToBox } from './websockets';
import { getDisplayName } from './boxes';
import type { BoxStatus, DisplayBoxSettings } from './types';

const STATUS_LABELS: Partial<Record<BoxStatus, string>> = {
  active:                 'Active',
  'can-react':            'Can React',
  reacting:               'Reacting',
  passed:                 'Passed',
  combat:                 'Combat',
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
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    const name   = getDisplayName(hwid);
    const status = STATUS_LABELS[box.status] ?? '';
    const settings: DisplayBoxSettings = state.displaySettings[hwid] ?? { showRound: false, showTimer: false };

    const msg: Record<string, unknown> = { type: 'display', name, status };

    if (settings.showRound) {
      msg.round = state.round;
    }
    if (settings.showTimer) {
      const running = !!box.turnStartTime;
      msg.timerRunning = running;
      msg.timerSecs = running ? Math.floor((Date.now() - box.turnStartTime!) / 1000) : 0;
    }

    sendToBox(hwid, msg);
  });
}
