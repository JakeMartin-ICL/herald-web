import { state } from './state';
import { sendToBox } from './websockets';
import { getDisplayName } from './boxes';
import type { BoxStatus } from './types';

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
    sendToBox(hwid, { type: 'display', name, status });
  });
}
