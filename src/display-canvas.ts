export const CANVAS_WIDTH = 128;
export const CANVAS_HEIGHT = 64;
export const CANVAS_MAX_BYTES = 250;
export const CANVAS_WARN_BYTES = 230;

export type CanvasElement =
  | ['t', number, number, number, string]
  | ['l', number, number, number, number]
  | ['r', number, number, number, number, 0 | 1]
  | ['g', number, number, number, number, number, number, 0 | 1]
  | ['c', number, number, number, 0 | 1];

export interface CanvasDisplay extends Record<string, unknown> {
  m: 'c';
  e: CanvasElement[];
}

type InlinePart =
  | { type: 'text'; text: string; size?: number }
  | { type: 'ct'; size?: number };

function px(n: number): number {
  return Math.round(n);
}

export function sanitizeCanvasText(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?');
}

export function textWidth(text: string, size = 1): number {
  return sanitizeCanvasText(text).length * 6 * size;
}

export function textHeight(size = 1): number {
  return 8 * size;
}

export function text(x: number, y: number, size: number, value: string): CanvasElement {
  return ['t', px(x), px(y), size, sanitizeCanvasText(value)];
}

export function centeredText(y: number, size: number, value: string): CanvasElement {
  const clean = sanitizeCanvasText(value);
  return text(Math.max(0, (CANVAS_WIDTH - textWidth(clean, size)) / 2), y, size, clean);
}

export function centeredTextFit(y: number, maxSize: number, value: string): CanvasElement {
  let size = maxSize;
  while (size > 1 && textWidth(value, size) > CANVAS_WIDTH) size--;
  return centeredText(y, size, value);
}

export function line(x1: number, y1: number, x2: number, y2: number): CanvasElement {
  return ['l', px(x1), px(y1), px(x2), px(y2)];
}

export function hline(y: number): CanvasElement {
  return line(0, y, CANVAS_WIDTH - 1, y);
}

export function rect(x: number, y: number, w: number, h: number, fill: 0 | 1 = 0): CanvasElement {
  return ['r', px(x), px(y), px(w), px(h), fill];
}

export function triangle(
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  fill: 0 | 1 = 0,
): CanvasElement {
  return ['g', px(x1), px(y1), px(x2), px(y2), px(x3), px(y3), fill];
}

export function circle(x: number, y: number, radius: number, fill: 0 | 1 = 0): CanvasElement {
  return ['c', px(x), px(y), px(radius), fill];
}

export function inlineText(value: string, size = 1): InlinePart {
  return { type: 'text', text: value, size };
}

export function commandToken(size = 1): InlinePart {
  return { type: 'ct', size };
}

function partSize(part: InlinePart): { w: number; h: number } {
  const size = part.size ?? 1;
  if (part.type === 'text') return { w: textWidth(part.text, size), h: textHeight(size) };
  return { w: 10 * size, h: 9 * size };
}

function commandTokenElements(x: number, y: number, size: number): CanvasElement[] {
  const w = 10 * size;
  const h = 9 * size;
  return [triangle(x, y + h, x + w, y + h, x + w / 2, y, 0)];
}

export function inlineRow(y: number, parts: InlinePart[], align: 'left' | 'center' | 'right' = 'center', x = CANVAS_WIDTH / 2): CanvasElement[] {
  const gap = 3;
  const sizes = parts.map(partSize);
  const width = sizes.reduce((sum, size) => sum + size.w, 0) + Math.max(0, parts.length - 1) * gap;
  const height = sizes.reduce((max, size) => Math.max(max, size.h), 0);
  let cursor = align === 'left' ? x : align === 'right' ? x - width : x - width / 2;
  const elements: CanvasElement[] = [];

  parts.forEach((part, index) => {
    const size = part.size ?? 1;
    const dims = sizes[index];
    const partY = y + (height - dims.h) / 2;
    if (part.type === 'text') {
      elements.push(text(cursor, partY, size, part.text));
    } else {
      elements.push(...commandTokenElements(cursor, partY, size));
    }
    cursor += dims.w + gap;
  });

  return elements;
}

export function canvas(elements: CanvasElement[]): CanvasDisplay {
  return { m: 'c', e: elements };
}

export function displayMessageBytes(body: Record<string, unknown>, hwid = ''): number {
  return JSON.stringify({ type: 'display', hwid, ...body }).length;
}

export function renderCanvasSvg(display: CanvasDisplay, scale = 3): string {
  const body = display.e.map(el => {
    switch (el[0]) {
      case 't': {
        const [, x, y, size, value] = el;
        return `<text x="${x}" y="${y + 8 * size - 1}" textLength="${textWidth(value, size)}" lengthAdjust="spacingAndGlyphs" font-size="${8 * size}" font-family="monospace" fill="white">${escapeHtml(value)}</text>`;
      }
      case 'l': {
        const [, x1, y1, x2, y2] = el;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="white" stroke-width="1"/>`;
      }
      case 'r': {
        const [, x, y, w, h, fill] = el;
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${fill ? 'fill="white"' : 'fill="none" stroke="white" stroke-width="1"'}/>`;
      }
      case 'g': {
        const [, x1, y1, x2, y2, x3, y3, fill] = el;
        return `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" ${fill ? 'fill="white"' : 'fill="none" stroke="white" stroke-width="1"'}/>`;
      }
      case 'c': {
        const [, x, y, radius, fill] = el;
        return `<circle cx="${x}" cy="${y}" r="${radius}" ${fill ? 'fill="white"' : 'fill="none" stroke="white" stroke-width="1"'}/>`;
      }
    }
  }).join('');

  return `<svg class="canvas-preview" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" width="${CANVAS_WIDTH * scale}" height="${CANVAS_HEIGHT * scale}" role="img" aria-label="OLED preview">
    <rect x="0" y="0" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="black"/>
    ${body}
  </svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]!));
}
