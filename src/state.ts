import type { AppState } from './types';

export const VIRTUAL_BOX_ID_OFFSET = 'virtual-';
export const RECONNECT_INTERVAL_MS = 5000;

export const state: AppState = {
  connected: false,
  gameActive: false,
  gameMode: 'clockwise',
  boxes: {},
  boxOrder: [],
  activeBoxId: null,
  nextVirtualIndex: 0,
  hubHwid: null,

  // Box display names — session only
  boxNames: {},

  // Faction data loaded from factions.json
  factions: null,

  // Expanded tag definitions loaded from tags.json
  allTags: null,

  // Whether faction scan mode is active
  factionScanActive: false,

  // Latest firmware info from GitHub releases
  latestFirmware: null,

  // Current round (all game modes); totalRounds set for games with a fixed length (e.g. Eclipse = 8)
  round: 0,
  totalRounds: null,

  gameStartTime: null,

  // Phase timing log
  phaseLog: [],
  currentPhaseStart: null,

  eclipse: {
    phase: null,
    passOrder: [],
    turnOrder: [],
    firstPlayerId: null,
    tapToPass: true,
    advancedOrder: false,
    upkeepReady: [],
  },

  showBatteryVoltage: false,
  displaySettings: {},
  boxBrightness: (() => {
    try { return JSON.parse(localStorage.getItem('herald-box-brightness') ?? '{}') as Record<string, number>; }
    catch { return {}; }
  })(),
  activePlayerStyle: { mode: 'solid', hue: null, rainbow: false, speed: 0.5 },
  autoCountdownSecs: 0,
  paused: false,
  pauseStartTime: null,

  ti: {
    phase: null,
    speakerHwid: null,
    turnOrder: [],
    strategyTurnIndex: 0,
    actionTurnIndex: 0,
    agendaTurnOrder: [],
    agendaTurnIndex: 0,
    secondaryMode: 'standard',
    mecatolControlled: false,
    players: {},
    secondary: null,
    agendaCount: 0,
  },
};
