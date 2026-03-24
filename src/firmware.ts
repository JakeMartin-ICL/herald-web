import { state } from './state';
import { render } from './render';

function versionLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (isNaN(va) || isNaN(vb)) return true; // non-numeric (e.g. 'dev') is always out of date
    if (va < vb) return true;
    if (va > vb) return false;
  }
  return false;
}

export function isVersionOutOfDate(boxVersion: string | null | undefined): boolean {
  if (!state.latestFirmware) return false;
  if (boxVersion === 'unknown' || !boxVersion) return true;
  return versionLessThan(boxVersion, state.latestFirmware.version);
}

export async function fetchLatestFirmware(): Promise<void> {
  try {
    const resp = await fetch('https://api.github.com/repos/jakemartin-icl/herald-firmware/releases/latest');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await resp.json() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binAsset = data.assets?.find((a: any) => a.name.endsWith('.bin'));
    state.latestFirmware = {
      version: (data.tag_name ?? data.name ?? '').replace(/^v/, ''),
      binUrl: binAsset?.browser_download_url ?? null,
      releaseNotes: data.body ?? '',
      publishedAt: data.published_at ?? '',
    };
    render();
  } catch (e) {
    console.warn('Failed to fetch latest firmware:', e);
    state.latestFirmware = null;
  }
}
