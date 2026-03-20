// ---- Constants ----

const VIRTUAL_BOX_ID_OFFSET = 'virtual-';
const RECONNECT_INTERVAL_MS = 5000;

// ---- State ----

const state = {
  connected: false,
  gameActive: false,
  gameMode: 'clockwise',
  boxes: {},        // keyed by hwid
  boxOrder: [],     // hwiDs in seat order
  activeBoxId: null,
  nextVirtualIndex: 0,
  hubHwid: null,

  // Box display names — persisted in localStorage
  // hwid -> { name }
  boxNames: {},

  // Faction data loaded from factions.json
  factions: null,

  // Whether faction scan mode is active
  factionScanActive: false,

  // Latest firmware info from GitHub releases
  latestFirmware: null, // { version, binUrl, releaseNotes, publishedAt }

  // Current round (all game modes); totalRounds set for games with a fixed length (e.g. Eclipse = 8)
  round: 0,
  totalRounds: null,

  // Game timer
  gameStartTime: null,

  // Phase timing log — [{ phase: string, duration: ms, round: N }]
  phaseLog: [],
  currentPhaseStart: null, // { name: string, startTime: number }

  // Eclipse state
  eclipse: {
    phase: null,
    passOrder: [],
    turnOrder: [],
    firstPlayerId: null,
  },

  ti: {
    phase: null,        // 'strategy', 'action', 'status', 'agenda', 'status2'
    speakerHwid: null,
    turnOrder: [],      // sorted by initiative during action phase
    secondaryMode: 'standard', // 'fastest', 'fast', 'standard'
    mecatolControlled: false,

    // Per-player TI state, keyed by hwid
    players: {},
    // {
    //   hwid,
    //   strategyCards: [],  // [{ id, name, color, initiative, used }]
    //   passed: false,
    //   confirmedSecondary: false,
    // }

    // Active secondary state
    secondary: null,
    // {
    //   activeHwid,     // who played the strategy card
    //   cardId,         // which card
    //   cardColor,      // for lighting
    //   pendingHwids,   // who still needs to confirm
    // }
  },
};
