import {
  canvas,
  centeredText,
  hline,
  inlineRow,
  inlineText,
  textWidth,
  triangleSymbol,
  wrapText,
  type CanvasElement,
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
  politics:     { title: 'POLITICS',     costParts: 'token',          result: 'Draw 2 ACs' },
  construction: { title: 'CONSTRUCT',    costParts: 'token',          result: 'Place 1 structure' },
  trade:        { title: 'TRADE',        costParts: 'token',          result: 'Replenish commods' },
  warfare:      { title: 'WARFARE',      costParts: 'token',          result: 'Produce at home' },
  technology:   { title: 'TECHNOLOGY',   costParts: 'token-plus-res', result: 'Research 1 tech' },
  imperial:     { title: 'IMPERIAL',     costParts: 'token',          result: 'Draw 1 secret obj' },
};

export function buildTiSecondaryDisplay(cardId: string): CanvasDisplay | null {
  const prompt = TI_SECONDARY_PROMPTS[cardId];
  if (!prompt) return null;

  const costParts = prompt.costParts === 'token'
    ? [inlineText('Spend'), triangleSymbol(), inlineText('token')]
    : prompt.costParts === 'token-plus-res'
      ? [inlineText('Spend'), triangleSymbol(), inlineText('+ 4 res')]
      : [inlineText('Spend influence 3:1')];
  const title = `${prompt.title} secondary`;
  const result = prompt.result;
  const resultLines = textWidth(result, 2) <= 128 ? [result] : wrapText(result, 128, 2, 2);
  const resultY = resultLines.length === 1 ? 42 : 32;
  const resultElements: CanvasElement[] = cardId === 'leadership'
    ? [
        ...inlineRow(32, [inlineText('Gain', 2), triangleSymbol(1.25)], 'center', 64, 5),
        centeredText(48, 2, 'Tokens'),
      ]
    : resultLines.map((line, index) => centeredText(resultY + index * 16, 2, line));

  return canvas([
    centeredText(0, 1, title),
    hline(11),
    ...inlineRow(16, costParts),
    ...resultElements,
  ]);
}
