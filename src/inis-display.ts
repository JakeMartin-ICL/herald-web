import { canvas, centeredText, hline, rect, triangle, type CanvasDisplay } from './display-canvas';

export function buildInisBrennDisplay(): CanvasDisplay {
  return canvas([
    triangle(50, 15, 78, 15, 64, 2, 1),
    centeredText(38, 1, "Press if you're Brenn"),
  ]);
}

export function buildInisFlockHubDisplay(): CanvasDisplay {
  return canvas([
    triangle(54, 12, 74, 12, 64, 2, 1),
    centeredText(15, 1, 'Clockwise'),
    hline(31),
    centeredText(34, 1, 'Anti-clockwise'),
    triangle(54, 51, 74, 51, 64, 61, 1),
  ]);
}

export function buildInisDraftArrowDisplay(left: boolean): CanvasDisplay {
  return left
    ? canvas([
        triangle(4, 32, 44, 8, 44, 56, 1),
        rect(44, 22, 80, 20, 1),
      ])
    : canvas([
        triangle(124, 32, 84, 8, 84, 56, 1),
        rect(4, 22, 80, 20, 1),
      ]);
}
