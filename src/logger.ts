// ---- Log ----

export function log(message: string, type = 'system'): void {
  const logEl = document.getElementById('log')!;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

export function clearLog(): void {
  document.getElementById('log')!.innerHTML = '';
}

// ---- Status ----

import { state } from './state';

export function setStatus(status: string): void {
  state.connected = status === 'connected';
  const el = document.getElementById('connection-status')!;
  el.className = `status ${status}`;
  el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}
