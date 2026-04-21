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
  | { type: 'led_anim_spinner'; color: string; rainbow: boolean; stepMs: number; fadeMs: number; reverse?: boolean }
  | { type: 'led_anim_choosing'; colors: string[]; activeMs: number; fadeMs: number }
  | { type: 'led_anim_upkeep' }
  | { type: 'led_anim_stop' }
  | { type: 'led_brightness'; value: number } // 0.0–1.0 scalar; firmware applies to all LEDs
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
  guidedStatusPhase: boolean;
  secondaryHints: boolean;
  players: Record<string, TiPlayer>;
  secondary: TiSecondary | null;
  agendaCount: number;
}

export interface KemetState {
  phase: 'action' | 'night' | null;
  turnOrder: string[];
  turnCounts: Record<string, number>; // hwid → turns taken this action phase
  turnsPerRound: number;              // default 5
  guidedNightPhase: boolean;
}

export interface InisState {
  phase: 'assembly' | 'season' | null;
  assemblyStep: 'brenn' | 'victory' | 'advantage' | 'flock' | 'deal' | 'draft' | null;
  brennHwid: string | null;
  turnDirection: 'clockwise' | 'anticlockwise';
  turnOrder: string[];
  consecutivePasses: number;
}

export interface ArcsState {
  phase: 'tap_leader' | 'action' | 'status' | null;
  leaderHwid: string | null;
  /** Set when a player taps the initiative token during their action-phase turn. Causes
   *  the next tap_leader phase to be skipped — the cycle restarts with them as leader. */
  initiativeSeized: boolean;
  /** Base clockwise turn order, persists across cycles; passed/disconnected filtered out per-cycle. */
  turnOrder: string[];
  /** Players still to take a turn in the current cycle; shrinks as players act or pass. */
  cycleRemaining: string[];
}

export interface CocState {
  phase: 'action' | 'status' | 'first_player' | null;
  turnOrder: string[];
  turnCounts: Record<string, number>;
  advancedOrder: boolean;
  disableObjectives: boolean;
}

export interface Faction {
  id: string;
  name: string;
  nickname?: string;
  color: string;
  expansion?: string;
}

export interface Expansion {
  id: string;
  name: string;
}

export interface Factions {
  twilight_imperium: Faction[];
  eclipse: Faction[];
  coc: Faction[];
}

export type AllTags = Record<string, Tag[]>;

export type SelectedExpansions = Record<string, string[]>;

export interface ActivePlayerStyle {
  mode: 'solid' | 'breathe' | 'spinner';
  hue: number | null; // null = white; number = hsl(hue, 100%, 50%)
  rainbow: boolean;   // overrides hue; not used for breathe
  speed: number;      // 0–1 (slow→fast)
}

export interface DisplayBoxSettings {
  showRound: boolean;
  showTimer: boolean;
  message: string;
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
  kemet: KemetState;
  inis: InisState;
  arcs: ArcsState;
  coc: CocState;
  showBatteryVoltage: boolean;
  activePlayerStyle: ActivePlayerStyle;
  displaySettings: Record<string, DisplayBoxSettings>;
  boxBrightness: Record<string, number>; // hwid → 20 | 40 | 60 | 80 | 100
  autoCountdownSecs: number;
  paused: boolean;
  pauseStartTime: number | null;
  expansions: Record<string, Expansion[]>;
  /** game → enabled expansion IDs; absent key = all enabled */
  selectedExpansions: SelectedExpansions;
  /** Guided phase: instruction steps and current position (cleared when not active) */
  guidedPhaseSteps: string[];
  guidedPhaseIndex: number;
}

// ---- Game log ----

export interface GameLogStats {
  turns: number;
  total_turn_time_ms: number;
  longest_turn_ms: number;
}

export interface GameLogTurnRecord {
  hwid: string;
  round: number | null;
  duration_ms: number;
}

export interface ScoreBreakdown {
  categories: string[];
  /** hwid → category → value */
  values: Record<string, Record<string, number | null>>;
}

export interface GameLog {
  version: 1;
  filename: string;
  started_at: number;          // Unix seconds
  ended_at: number;            // Unix seconds
  game_mode: string;
  rounds: number;
  total_game_time_ms: number | null;
  players: Record<string, string>;           // hwid → display name
  factions: Record<string, string | null>;   // hwid → factionId
  scores: Record<string, number | null>;     // hwid → score
  stats: Record<string, GameLogStats>;
  turn_history: GameLogTurnRecord[];
  phase_log: { phase: string; duration: number; round: number }[];
  score_breakdown?: ScoreBreakdown;
}

export interface GameLogIndexEntry {
  filename: string;
  started_at: number;
  ended_at: number;
  game_mode: string;
  player_names: string[];
}

export interface GitHubConfig {
  pat: string;
  gist_id: string;
  entered_at: number;          // Unix seconds, set client-side at save time
}

// ---- GameMode interface ----

export interface GameMode {
  readonly id: string;
  getTableLabel?(): string;
  getLedForStatus?(status: string, box: Box | null, hwid: string | null): LedCommand | null;
  /** Current phase turn order; the reorder dialog reads and writes this. */
  turnOrder: string[];
  /** Optional ordered list of score categories for the end-of-game scoresheet. */
  scoreBreakdownCategories?: readonly string[];
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
  /** Called just before the player is removed from boxOrder. box.status is already
   *  'disconnected'. Implementations should advance any in-progress turn and clean
   *  up game-specific order arrays. */
  onPlayerRemoved?(hwid: string): void;
  /** Immediately make hwid the active player, carrying on through turnOrder from their
   *  position. Called AFTER cancelCurrentTurn() has discarded the previous player's stats. */
  activatePlayer?(hwid: string): void;
  /** Re-sync RFID enable/disable to match restored game state (called after undo). */
  syncRfid?(): void;
  /** Per-box OLED display override. Return a partial display-message object (name, status,
   *  arrow, layout, etc.) or null to use the default player-name/status display. */
  getBoxDisplay?(hwid: string): Record<string, unknown> | null;
}
