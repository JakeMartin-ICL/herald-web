import { state } from './state';
import { init } from './init';
import { toggleConnect } from './websockets';
import { onGameModeChange, addVirtualBox, confirmSubstitution, cancelSubstitution } from './boxes';
import { startGame, toggleDebug, debugSkipPhase } from './game';
import { confirmResume, discardResume } from './persist';
import { openGraphOverlay, closeGraphOverlay, cycleGraphSort, onGraphTypeChange } from './graphs';
import { startFactionScan, stopFactionScan, closeRfidDialog, cancelTagWriting, simulateTagTap, startTagWriting, buildTagQueue } from './rfid';
import { openOtaDialog, closeOtaDialog, forceCloseOtaDialog } from './ota';
import { openDebugDialog, closeDebugDialog, openWifiDialog, closeWifiDialog, saveWifiCredentials } from './settings';
import { openActiveStyleDialog, initActiveStyleDialog, loadActiveStyle } from './activeStyle';
import { clearLog } from './logger';
import { cancelEndGame, endGame, render } from './render';
import { dismissBatteryTip } from './init';

function on(id: string, event: string, fn: EventListener): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, fn);
}

// ---- Wire event listeners ----

on('connect-btn', 'click', () => toggleConnect());
on('game-mode', 'change', () => onGameModeChange());
on('start-btn', 'click', () => startGame());
on('resume-btn', 'click', () => confirmResume());
on('discard-resume-btn', 'click', () => discardResume());
on('add-virtual-btn', 'click', () => addVirtualBox());
on('add-virtual-debug-btn', 'click', () => addVirtualBox());
on('prev-stats-btn', 'click', () => openGraphOverlay('prev'));

// Faction scan
on('stop-faction-scan-btn', 'click', () => stopFactionScan());
on('set-factions-btn', 'click', () => startFactionScan());

// Tag writing
on('ti-learn-tags-btn', 'click', () => startTagWriting(buildTagQueue('ti'), 'Write TI Tags'));
on('eclipse-learn-faction-tags-btn', 'click', () => startTagWriting(buildTagQueue('eclipse'), 'Write Eclipse Tags'));
on('simulate-tag-tap-btn', 'click', () => simulateTagTap());
on('cancel-tag-writing-btn', 'click', () => cancelTagWriting());

// RFID dialog
on('rfid-dialog-overlay', 'click', () => closeRfidDialog());
on('rfid-dialog-cancel-btn', 'click', () => closeRfidDialog());

// OTA
on('ota-open-btn', 'click', () => openOtaDialog());
on('ota-overlay', 'click', () => closeOtaDialog());
on('ota-close-btn', 'click', () => closeOtaDialog());
on('ota-force-close-btn', 'click', () => forceCloseOtaDialog());

// Debug dialog
on('debug-open-btn', 'click', () => openDebugDialog());
on('debug-log-overlay', 'click', () => closeDebugDialog());
on('debug-close-btn', 'click', () => closeDebugDialog());

// Show battery toggle
on('show-battery-cb', 'change', (e) => {
  state.showBatteryVoltage = (e.target as HTMLInputElement).checked;
  render();
});

// WiFi
on('wifi-open-btn', 'click', () => openWifiDialog());

// Active player style
on('active-style-open-btn', 'click', () => openActiveStyleDialog());
on('wifi-overlay', 'click', () => closeWifiDialog());
on('wifi-close-btn', 'click', () => closeWifiDialog());
on('wifi-save-btn', 'click', () => saveWifiCredentials());

// Sub dialog
on('sub-overlay', 'click', () => cancelSubstitution());
on('confirm-sub-btn', 'click', () => confirmSubstitution());
on('cancel-sub-btn', 'click', () => cancelSubstitution());

// End game dialog
on('end-game-overlay', 'click', () => cancelEndGame());
on('confirm-end-game-btn', 'click', () => endGame());
on('cancel-end-game-btn', 'click', () => cancelEndGame());

// Graph overlay
on('graph-overlay', 'click', () => closeGraphOverlay());
on('graph-dialog', 'click', (e) => e.stopPropagation());
on('close-graph-btn', 'click', () => closeGraphOverlay());
on('graph-sort-btn', 'click', () => cycleGraphSort());
on('graph-type-select', 'change', (e) => onGraphTypeChange((e.target as HTMLSelectElement).value));

// Log
on('clear-log-btn', 'click', () => clearLog());

// Debug bar
on('debug-toggle-btn', 'click', () => toggleDebug());
on('debug-skip-btn', 'click', () => debugSkipPhase());

// Battery tip
on('battery-tip-dismiss-btn', 'click', () => dismissBatteryTip());

// ---- Start app ----

loadActiveStyle();
initActiveStyleDialog();
init().catch(console.error);
