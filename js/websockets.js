// ---- WebSocket ----

let ws = null;
let reconnectTimer = null;

function toggleConnect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    disconnect();
  } else {
    connect();
  }
}

function connect() {
  const address = document.getElementById('hub-address').value.trim();
  setStatus('connecting');
  log(`Connecting to ${address}...`, 'system');

  ws = new WebSocket(`ws://${address}`);

  ws.onopen = () => {
    send({ type: 'hello', client: 'app' });
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onerror = () => {
    setStatus('disconnected');
    log('Connection error', 'error');
  };

  ws.onclose = () => {
    setStatus('disconnected');
    log('Disconnected from hub', 'system');
    document.getElementById('connect-btn').textContent = 'Connect';
    ws = null;
    render();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Attempting reconnect...', 'system');
      connect();
    }
  }, RECONNECT_INTERVAL_MS);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) ws.close();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    log(`→ ${JSON.stringify(msg)}`, 'sent');
  }
}

function sendSilent(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendToBox(hwid, msg) {
  if (hwid.startsWith(VIRTUAL_BOX_ID_OFFSET)) {
    handleBoxCommand(hwid, msg);
    return;
  }
  send({ ...msg, hwid });
}

// ---- RFID enable/disable ----

function enableRfid(hwid) {
  sendToBox(hwid, { type: 'rfid_enable', hwid });
}

function disableRfid(hwid) {
  sendToBox(hwid, { type: 'rfid_disable', hwid });
}

function disableAllRfid() {
  state.boxOrder.forEach(hwid => {
    const box = state.boxes[hwid];
    if (!box || box.isVirtual || box.status === 'disconnected') return;
    disableRfid(hwid);
  });
}

// ---- Message handling ----

function handleMessage(msg) {
  if (msg.type !== 'hello_ack') {
    log(`← ${JSON.stringify(msg)}`, 'received');
  }

  switch (msg.type) {
    case 'hello_ack':
      setStatus('connected');
      log('Connected to hub', 'system');
      document.getElementById('connect-btn').textContent = 'Disconnect';
      if (state.gameActive) syncLeds();
      break;
    case 'connected':
      addBox(msg.hwid, false);
      if (state.boxes[msg.hwid]) state.boxes[msg.hwid].version = msg.version || 'unknown';
      break;
    case 'disconnected':
      handleBoxDisconnect(msg.hwid);
      break;
    case 'endturn':
      handleEndTurn(msg.hwid);
      break;
    case 'pass':
      handlePass(msg.hwid);
      break;
    case 'longpress':
      handleLongPress(msg.hwid);
      break;
    case 'rfid':
      handleRfid(msg.hwid, msg.tagId);
      break;
    case 'rfid_write_result':
      handleRfidWriteResult(msg);
      break;
    case 'ota_progress':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].otaProgress = msg.percent;
        state.boxes[msg.hwid].otaUpdating = true;
      }
      renderOtaDialog();
      break;
    case 'ota_complete':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].version = msg.version;
        state.boxes[msg.hwid].otaProgress = 100;
        state.boxes[msg.hwid].otaUpdating = false;
        state.boxes[msg.hwid].otaError = null;
      }
      log(`${getDisplayName(msg.hwid)} firmware updated to ${msg.version}`, 'system');
      renderOtaDialog();
      break;
    case 'ota_error':
      if (state.boxes[msg.hwid]) {
        state.boxes[msg.hwid].otaError = msg.message;
        state.boxes[msg.hwid].otaUpdating = false;
        state.boxes[msg.hwid].otaProgress = null;
      }
      log(`${getDisplayName(msg.hwid)} OTA failed: ${msg.message}`, 'error');
      renderOtaDialog();
      break;
    case 'debug':
      log(`[${getDisplayName(msg.hwid)}] ${msg.msg}`, 'debug');
      return; // skip render — no game state changed
    case 'wifi_credentials':
      _wifiCredentials = (msg.credentials || []).map(c => ({ ssid: c.ssid || '', password: c.password || '' }));
      clearTimeout(_wifiCredentialsTimeout);
      renderWifiDialog();
      return;
    case 'state_backup':
      applyHubBackup(msg.payload, msg.compressed);
      return; // async, no sync render needed
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

  render();
}

// ---- Box command handler (virtual boxes) ----

function handleBoxCommand(hwid, msg) {
  // Virtual boxes derive appearance from status, nothing to do here
}
