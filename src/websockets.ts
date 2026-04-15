import { state, VIRTUAL_BOX_ID_OFFSET, RECONNECT_INTERVAL_MS } from './state';
import { loadGitHubConfig, saveGitHubConfig } from './github-config';
import { log, setStatus } from './logger';
import { syncLeds, sendBrightnessToBox, receiveBoxBrightness } from './leds';
import { renderBoxes, scheduleRender } from './render';
import { renderOtaDialog } from './ota';
import { renderWifiDialog } from './settings';
import { applyHubBackup } from './persist';
import { addBox, handleBoxDisconnect, getDisplayName } from './boxes';
import { handleEndTurn, handlePass, handleLongPress } from './game';
import { handleRfid, handleRfidWriteResult } from './rfid';
import { handleHwTestEvent, handleHwTestRfid } from './hwtest';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function toggleConnect(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    disconnect();
  } else {
    connect();
  }
}

export function connect(): void {
  const address = (document.getElementById('hub-address') as HTMLInputElement).value.trim();
  setStatus('connecting');
  log(`Connecting to ${address}...`, 'system');

  ws = new WebSocket(`ws://${address}`);

  ws.onopen = () => {
    const ghConfig = loadGitHubConfig();
    send({ type: 'hello', client: 'app', github_config_entered_at: ghConfig?.entered_at ?? 0 });
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    handleMessage(msg);
  };

  ws.onerror = () => {
    setStatus('disconnected');
    log('Connection error', 'error');
  };

  ws.onclose = () => {
    setStatus('disconnected');
    log('Disconnected from hub', 'system');
    (document.getElementById('connect-btn') as HTMLButtonElement).textContent = 'Connect';
    ws = null;
    scheduleRender();
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (ws?.readyState !== WebSocket.OPEN) {
      log('Attempting reconnect...', 'system');
      connect();
    }
  }, RECONNECT_INTERVAL_MS);
}

export function disconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) ws.close();
}

export function send(msg: object): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    log(`→ ${JSON.stringify(msg)}`, 'sent');
  }
}

export function sendSilent(msg: object): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function sendToBox(hwid: string, msg: object): void {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) return; // virtual boxes: no-op
  send({ ...msg, hwid });
}

// ---- RFID enable/disable ----

export function enableRfid(hwid: string): void {
  sendToBox(hwid, { type: 'rfid_enable', hwid });
}

export function disableRfid(hwid: string): void {
  sendToBox(hwid, { type: 'rfid_disable', hwid });
}

export function sendRfidPrompt(hwid: string, show: boolean): void {
  sendToBox(hwid, { type: 'rfid_prompt', show });
}

export function disableAllRfid(): void {
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    disableRfid(hwid);
  });
}

// ---- Message handling ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleMessage(msg: any): void {
  if (msg.type !== 'hello_ack') {
    log(`← ${JSON.stringify(msg)}`, 'received');
  }

  switch (msg.type) {
    case 'hello_ack':
      setStatus('connected');
      log('Connected to hub', 'system');
      (document.getElementById('connect-btn') as HTMLButtonElement).textContent = 'Disconnect';
      if (state.gameActive) syncLeds();
      // Sync GitHub credentials with hub (hello_ack is not logged, PAT stays out of event log)
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hubConfig = msg.github_config as any;
        const localConfig = loadGitHubConfig();
        if (hubConfig?.entered_at && (!localConfig || hubConfig.entered_at > localConfig.entered_at)) {
          saveGitHubConfig(hubConfig);
        } else if (localConfig && (!hubConfig?.entered_at || localConfig.entered_at > hubConfig.entered_at)) {
          sendSilent({ type: 'github_config_set', ...localConfig });
        }
      }
      break;
    case 'connected': {
      const wasOtaUpdating = state.boxes[msg.hwid as string]?.otaUpdating;
      addBox(msg.hwid as string, false);
      if (state.boxes[msg.hwid]) state.boxes[msg.hwid].version = (msg.version as string) || 'unknown';
      sendBrightnessToBox(msg.hwid as string);
      if (wasOtaUpdating) renderOtaDialog();
      break;
    }
    case 'disconnected':
      handleBoxDisconnect(msg.hwid as string);
      break;
    case 'endturn':
      if (!handleHwTestEvent(msg.hwid as string, 'endturn')) handleEndTurn(msg.hwid as string);
      return;
    case 'pass':
      if (!handleHwTestEvent(msg.hwid as string, 'pass')) handlePass(msg.hwid as string);
      return;
    case 'longpress':
      handleLongPress(msg.hwid as string);
      return;
    case 'rfid':
      if (handleHwTestRfid(msg.hwid as string, msg.tagId as string)) break;
      handleRfid(msg.hwid as string, msg.tagId as string);
      return;
    case 'rfid_write_result':
      handleRfidWriteResult(msg);
      return;
    case 'ota_complete':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].version = msg.version as string;
        state.boxes[msg.hwid].otaUpdating = false;
        state.boxes[msg.hwid].otaError = null;
      }
      log(`${getDisplayName(msg.hwid as string)} firmware updated to ${msg.version as string}`, 'system');
      renderOtaDialog();
      return;
    case 'ota_error':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].otaError = msg.message as string;
        state.boxes[msg.hwid].otaUpdating = false;
      }
      log(`${getDisplayName(msg.hwid as string)} OTA failed: ${msg.message as string}`, 'error');
      renderOtaDialog();
      return;
    case 'battery':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].batteryVoltage = msg.voltage as number;
      }
      renderBoxes();
      return;
    case 'debug':
      log(`[${getDisplayName(msg.hwid as string)}] ${msg.msg as string}`, 'debug');
      return;
    case 'wifi_credentials':
      // handled by settings module directly; re-export for websockets to call
      handleWifiCredentials(msg);
      return;
    case 'state_backup':
      void applyHubBackup(msg.payload as string, msg.compressed as boolean);
      return;
    case 'box_brightness':
      receiveBoxBrightness(msg.hwid as string, msg.value as number);
      return;
    case 'state_backup_none':
      return;
    case 'wifi_credentials_ack': {
      const statusEl = document.getElementById('wifi-save-status');
      if (statusEl) {
        statusEl.textContent = 'Saved!';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
      return;
    }
  }

  scheduleRender();
}

// Forward wifi_credentials message to settings module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleWifiCredentials(msg: any): void {
  // Import lazily to avoid circular; settings imports nothing from websockets at module level
  void import('./settings').then(({ receiveWifiCredentials }) => {
    receiveWifiCredentials(msg.credentials);
    renderWifiDialog();
  });
}
