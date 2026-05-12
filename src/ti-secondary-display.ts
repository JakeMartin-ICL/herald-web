import {
  canvas,
  centeredText,
  centeredTextFit,
  commandToken,
  hline,
  inlineRow,
  inlineText,
  type CanvasDisplay,
} from './display-canvas';

export interface TiSecondaryPrompt {
  title: string;
  result: string;
  costParts: 'token' | 'token-plus-res' | 'influence';
}

export const TI_SECONDARY_PROMPTS: Record<string, TiSecondaryPrompt> = {
  leadership:   { title: 'LEADERSHIP',   costParts: 'influence',      result: 'Gain command tokens' },
  diplomacy:    { title: 'DIPLOMACY',    costParts: 'token',          result: 'Ready 2 planets' },
  politics:     { title: 'POLITICS',     costParts: 'token',          result: 'Draw 2 action cards' },
  construction: { title: 'CONSTRUCT',    costParts: 'token',          result: 'Place 1 structure' },
  trade:        { title: 'TRADE',        costParts: 'token',          result: 'Replenish Commods' },
  warfare:      { title: 'WARFARE',      costParts: 'token',          result: 'Produce at home' },
  technology:   { title: 'TECHNOLOGY',   costParts: 'token-plus-res', result: 'Research 1 tech' },
  imperial:     { title: 'IMPERIAL',     costParts: 'token',          result: 'Draw 1 secret obj' },
};

export function buildTiSecondaryDisplay(cardId: string): CanvasDisplay | null {
  const prompt = TI_SECONDARY_PROMPTS[cardId];
  if (!prompt) return null;

  const costParts = prompt.costParts === 'token'
    ? [inlineText('Spend'), commandToken(), inlineText('token')]
    : prompt.costParts === 'token-plus-res'
      ? [inlineText('Spend'), commandToken(), inlineText('+ 4 res')]
      : [inlineText('Spend influence 3:1')];

  return canvas([
    centeredTextFit(0, 2, prompt.title),
    centeredText(18, 1, 'SECONDARY'),
    hline(29),
    ...inlineRow(35, costParts),
    centeredTextFit(52, 1, prompt.result),
  ]);
}
