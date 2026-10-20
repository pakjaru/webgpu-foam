// pretext: text measurement and line breaking without DOM reflow.
import { layoutWithLines, prepareWithSegments, type PreparedTextWithSegments } from '@chenglou/pretext';

export type PreparedText = PreparedTextWithSegments;

/** The expensive one-time pass: segment `text` and measure it in `font` (canvas font shorthand). */
export const prepareText = (text: string, font: string): PreparedText => prepareWithSegments(text, font);

/** The text of each line when `prepared` wraps at `maxWidth` (cheap; rerun on resize). */
export const breakLines = (prepared: PreparedText, maxWidth: number, lineHeight: number): string[] =>
  layoutWithLines(prepared, maxWidth, lineHeight).lines.map((line) => line.text);
