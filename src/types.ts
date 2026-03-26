// ---- Core types ----

export type BoxStatus =
  | 'idle' | 'active' | 'can-react' | 'reacting' | 'passed'
  | 'combat' | 'upkeep' | 'disconnected' | 'choosing'
  | 'status' | 'status2'
  | 'strategy' | 'secondary'
  | 'agenda_speaker' | 'agenda_reveal' | 'when_agenda_revealed' | 'after_agenda_revealed' | 'agenda_vote';

export interface Badge {
  type: 'text' | 'icon' | 'pill';
  value: string;
  label?: string;
  color?: string;
  faded?: boolean;
}

export interface TurnRecord {
  duration: number;
  round: number | null;
}

// Named LED command sent to a box. The firmware generates the actual LED pattern
// from these parameters — no raw LED arrays are sent over the wire.
export type LedCommand =
  | { type: 'led_off' }
  | { type: 'led_solid'; color: string }
  | { type: 'led_alternate'; color: string }
  | { type: 'led_alternate_pair'; a: string; b: string }
  | { type: 'led_half'; color: string; first: boolean }
  | { type: 'led_rainbow' }
  | { type: 'led_thirds'; c1: string; c2: string; c3: string }
  | { type: 'led_sectors'; sectors: { color: string; count: number }[] }
  | { type: 'led_anim_breathe'; color: string; rainbow: boolean; halfPeriodMs: number }
  | { type: 'led_anim_spinner'; color: string; rainbow: boolean; stepMs: number; fadeMs: number }
  | { type: 'led_anim_choosing'; colors: string[]; activeMs: number; fadeMs: number }
  | { type: 'led_anim_upkeep' }
  | { type: 'led_anim_stop' }
  | { type: 'led_raw'; leds: string[] }; // virtual-box-only: raw array for JS-driven animations

export interface Box {
  hwid: string;
  isVirtual: boolean;
  status: BoxStatus;
  factionId: string | null;
  leds?: LedCommand | null;
  ledOverrideUntil?: number | null;
  badges?: Badge[];
  version?: string | null;
  otaProgress?: number | null;
  otaUpdating?: boolean;
  otaError?: string | null;
  turnStartTime?: number | null;
  totalTurnTime?: number;
  turnHistory?: TurnRecord[];
  strategyColor?: string | null;
  choosingLeds?: LedCommand | null;
  debugEnabled?: boolean;
  batteryVoltage?: number | null;
  rfidPromptOn?: boolean;
  countdownActive?: boolean;
  countdownEndMs?: number;
}

export interface FirmwareInfo {
  version: string;
  binUrl: string | null;
  releaseNotes: string;
  publishedAt: string;
}

export interface Tag {
  display: string;
  id: string;
}

// { html, id, event, fn } — event defaults to 'click'
export interface ActionDef {
  html: string;
  id?: string;
  event?: string;
  fn?: ((e: Event) => void) | (() => void);
}

export interface PhaseLogEntry {
  phase: string;
  duration: number;
  round: number;
}

export interface StrategyCard {
  id: string;
  label: string;
  color: string;
  initiative: number;
  used: boolean;
}

export interface TiPlayer {
  hwid: string;
  strategyCards: StrategyCard[];
  passed: boolean;
  confirmedSecondary: boolean;
}

export interface TiSecondary {
  activeHwid: string;
  cardId: string;
  cardColor: string;
  pendingHwids: string[];
  activeTurnEnded: boolean;
}

export interface EclipseState {
  phase: string | null;
  passOrder: string[];
  turnOrder: string[];
  firstPlayerId: string | null;
  tapToPass: boolean;
  advancedOrder: boolean;
  upkeepReady: string[];
}

export interface TiState {
  phase: string | null;
  speakerHwid: string | null;
  turnOrder: string[];
  strategyTurnIndex: number;
  actionTurnIndex: number;
  agendaTurnOrder: string[];
  agendaTurnIndex: number;
  secondaryMode: 'fastest' | 'fast' | 'standard';
  mecatolControlled: boolean;
  players: Record<string, TiPlayer>;
  secondary: TiSecondary | null;
  agendaCount: number;
}

export interface Faction {
  id: string;
  name: string;
  nickname?: string;
  color: string;
}

export interface Factions {
  twilight_imperium: Faction[];
  eclipse: Faction[];
}

export type AllTags = Record<string, Tag[]>;

export interface ActivePlayerStyle {
  mode: 'solid' | 'breathe' | 'spinner';
  hue: number | null; // null = white; number = hsl(hue, 100%, 50%)
  rainbow: boolean;   // overrides hue; not used for breathe
  speed: number;      // 0–1 (slow→fast)
}

export interface DisplayBoxSettings {
  showRound: boolean;
  showTimer: boolean;
}

export interface AppState {
  connected: boolean;
  gameActive: boolean;
  gameMode: string;
  boxes: Record<string, Box>;
  boxOrder: string[];
  activeBoxId: string | null;
  nextVirtualIndex: number;
  hubHwid: string | null;
  boxNames: Record<string, { name?: string; manual?: boolean }>;
  factions: Factions | null;
  allTags: AllTags | null;
  factionScanActive: boolean;
  latestFirmware: FirmwareInfo | null;
  round: number;
  totalRounds: number | null;
  gameStartTime: number | null;
  phaseLog: PhaseLogEntry[];
  currentPhaseStart: { name: string; startTime: number } | null;
  eclipse: EclipseState;
  ti: TiState;
  showBatteryVoltage: boolean;
  activePlayerStyle: ActivePlayerStyle;
  displaySettings: Record<string, DisplayBoxSettings>;
  autoCountdownSecs: number;
}

// ---- GameMode interface ----

export interface GameMode {
  readonly id: string;
  start(): void;
  onEndTurn(hwid: string): void;
  onPass(hwid: string): void;
  onLongPress(hwid: string): void;
  advancePhase?(): void;
  onRfid?(hwid: string, game: string, category: string, id: string): void;
  getRelevantTags(hwid: string): Tag[];
  renderControls(statusLines: string[], actionDefs: ActionDef[]): void;
  debugSkip?(): void;
  onFactionChanged?(): void;
  onResume?(): void;
}
