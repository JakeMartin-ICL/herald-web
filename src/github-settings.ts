import { loadGitHubConfig, saveGitHubConfig } from './github-config';
import { createGist, syncWithGist } from './gist';
import { sendSilent } from './websockets';
import type { GitHubConfig } from './types';

export function openGitHubSettingsDialog(): void {
  renderGitHubSettings();
  (document.getElementById('github-sync-overlay') as HTMLElement).style.display = 'flex';
}

export function closeGitHubSettingsDialog(): void {
  (document.getElementById('github-sync-overlay') as HTMLElement).style.display = 'none';
}

export function renderGitHubSettings(): void {
  const config = loadGitHubConfig();
  const el = document.getElementById('github-sync-content') as HTMLElement;

  el.innerHTML = `
    <div class="gh-field">
      <label class="gh-label">Personal Access Token</label>
      <input type="password" id="gh-pat-input"
        placeholder="${config ? 'Already configured (paste to replace)' : 'github_pat_…'}"
        autocomplete="off" spellcheck="false">
    </div>
    <div class="gh-field">
      <label class="gh-label">Gist ID</label>
      <div class="gh-gist-row">
        <input type="text" id="gh-gist-input"
          value="${config?.gist_id ?? ''}"
          placeholder="Paste Gist ID, or create new →"
          spellcheck="false">
        <button id="gh-create-btn">New</button>
      </div>
    </div>
    <div class="gh-action-row">
      <button id="gh-save-btn">Save</button>
      <span id="gh-save-status" class="gh-status"></span>
    </div>
    <hr class="gh-divider">
    <div class="gh-action-row">
      <button id="gh-sync-btn"${config ? '' : ' disabled'}>Sync Now</button>
      <span id="gh-sync-status" class="gh-status"></span>
    </div>
  `;

  document.getElementById('gh-create-btn')!.addEventListener('click', () => void handleCreate());
  document.getElementById('gh-save-btn')!.addEventListener('click', () => handleSave());
  document.getElementById('gh-sync-btn')!.addEventListener('click', () => void handleSync());
}

function patInput(): HTMLInputElement { return document.getElementById('gh-pat-input') as HTMLInputElement; }
function gistInput(): HTMLInputElement { return document.getElementById('gh-gist-input') as HTMLInputElement; }
function setSaveStatus(msg: string): void {
  const el = document.getElementById('gh-save-status'); if (el) el.textContent = msg;
}
function setSyncStatus(msg: string): void {
  const el = document.getElementById('gh-sync-status'); if (el) el.textContent = msg;
}

async function handleCreate(): Promise<void> {
  const pat = patInput().value.trim() || loadGitHubConfig()?.pat;
  if (!pat) { setSaveStatus('Enter a PAT first'); return; }
  const btn = document.getElementById('gh-create-btn') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = '…';
  try {
    const id = await createGist(pat);
    gistInput().value = id;
    setSaveStatus('Gist created — click Save');
  } catch (e) {
    setSaveStatus(`Error: ${(e as Error).message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'New';
  }
}

function handleSave(): void {
  const newPat = patInput().value.trim();
  const gistId = gistInput().value.trim();
  const existing = loadGitHubConfig();
  const pat = newPat || existing?.pat;
  if (!pat) { setSaveStatus('PAT required'); return; }
  if (!gistId) { setSaveStatus('Gist ID required'); return; }

  const config: GitHubConfig = { pat, gist_id: gistId, entered_at: Math.floor(Date.now() / 1000) };
  saveGitHubConfig(config);
  sendSilent({ type: 'github_config_set', ...config });
  patInput().value = '';
  setSaveStatus('Saved');
  const syncBtn = document.getElementById('gh-sync-btn') as HTMLButtonElement;
  if (syncBtn) syncBtn.disabled = false;
}

async function handleSync(): Promise<void> {
  const config = loadGitHubConfig();
  if (!config) { setSyncStatus('No credentials configured'); return; }
  const btn = document.getElementById('gh-sync-btn') as HTMLButtonElement;
  btn.disabled = true;
  setSyncStatus('Syncing…');
  try {
    const result = await syncWithGist(config, setSyncStatus);
    setSyncStatus(`Done — ${result.uploaded} up, ${result.downloaded} down`);
  } catch (e) {
    setSyncStatus(`Error: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}
