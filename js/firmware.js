// ---- Firmware version helpers ----

function versionLessThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

function isVersionOutOfDate(boxVersion) {
  if (!state.latestFirmware) return false;
  if (boxVersion === 'unknown' || !boxVersion) return true;
  return versionLessThan(boxVersion, state.latestFirmware.version);
}

async function fetchLatestFirmware() {
  try {
    const resp = await fetch('https://api.github.com/repos/jakemartin-icl/herald-firmware/releases/latest');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const binAsset = data.assets?.find(a => a.name.endsWith('.bin'));
    state.latestFirmware = {
      version: (data.tag_name || data.name || '').replace(/^v/, ''),
      binUrl: binAsset?.browser_download_url || null,
      releaseNotes: data.body || '',
      publishedAt: data.published_at || '',
    };
    render();
  } catch (e) {
    console.warn('Failed to fetch latest firmware:', e);
    state.latestFirmware = null;
  }
}
