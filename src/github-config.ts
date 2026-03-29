import type { GitHubConfig } from './types';

const GITHUB_CONFIG_KEY = 'herald-github-config';

export function loadGitHubConfig(): GitHubConfig | null {
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_KEY);
    return raw ? JSON.parse(raw) as GitHubConfig : null;
  } catch { return null; }
}

export function saveGitHubConfig(config: GitHubConfig): void {
  localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(config));
}
