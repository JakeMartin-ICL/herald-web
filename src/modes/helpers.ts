import { state } from '../state';

export function isHubOrSim(hwid: string): boolean {
  return hwid === state.hubHwid || state.boxes[hwid]?.isVirtual;
}
