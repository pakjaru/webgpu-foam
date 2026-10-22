import { STRIDE } from '../lib/dom_compiler';
import { breakLines, prepareText, type PreparedText } from '../lib/pretext';

export const TEXT_STRIDE = 13; // + atlas uv rect [u0, v0, u1, v1] + line bottom (doc px)
// Split-text stagger, in seconds, per unit of the element's `data-split`
// ("lines" | "words" | "chars", default "lines"). Glyphs in one unit rise together.
const DELAY = { lines: 0.1, words: 0.04, chars: 0.012 } as const;
type Split = keyof typeof DELAY;
const ATLAS_WIDTH = 2048;
const PAD = 1; // px of ink padding so antialiased edges aren't clipped

// prepare() is the expensive pass (segmenting + canvas measuring); run it once
// per element/font/text and only re-run the cheap layout() on resize.
const cache = new WeakMap<Element, { key: string; prepared: PreparedText }>();
const segmenter = new Intl.Segmenter();

/** Font shorthand and pretext's prepared text for `el`, cached until either changes. */
function prepare(el: Element, style: CSSStyleDeclaration) {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const text = el.textContent ?? '';
  const key = `${font}|${text}`;
  let entry = cache.get(el);
  if (entry?.key !== key) {
    entry = { key, prepared: prepareText(text, font) };
    cache.set(el, entry);
  }
  return { font, text, prepared: entry.prepared };
}

const scratch = document.createElement('canvas').getContext('2d')!;
/** Fills the caches layoutText needs for `el`, so a first layout can be spread over several tasks. */
export function warmText(el: Element) {
  const { font, text } = prepare(el, getComputedStyle(el));
  scratch.font = font;
  for (const { segment: g } of segmenter.segment(text)) measure(scratch, `${font}|${g}`, g);
}

/** Pen advance plus the glyph's ink box relative to pen/baseline, in CSS px. */
interface Metrics {
  advance: number;
  left: number;
  right: number;
  ascent: number;
  descent: number;
  fontAscent: number;
  fontDescent: number;
}
const metrics = new Map<string, Metrics>(); // `${font}|${grapheme}`

function measure(ctx: CanvasRenderingContext2D, key: string, g: string): Metrics {
  let m = metrics.get(key);
  if (!m) {
    const t = ctx.measureText(g);
    m = {
      advance: t.width,
      left: t.actualBoundingBoxLeft + PAD,
      right: t.actualBoundingBoxRight + PAD,
      ascent: t.actualBoundingBoxAscent + PAD,
      descent: t.actualBoundingBoxDescent + PAD,
      fontAscent: t.fontBoundingBoxAscent,
      fontDescent: t.fontBoundingBoxDescent,
    };
    metrics.set(key, m);
  }
  return m;
}

interface Glyph {
  key: string;
  base: Float32Array;
  x: number;
  y: number;
  m: Metrics;
  block: number;
  delay: number;
  lineBottom: number;
}

/** Per-glyph instance data plus what the split-text reveal needs per glyph. */
export interface TextLayout {
  data: Float32Array<ArrayBuffer>;
  block: Uint16Array; // index into the `elements` passed in
  delay: Float32Array; // stagger offset in seconds
}

/**
 * Turns Rust-compiled text-block rects into one instance per glyph, sized to
 * the glyph's ink box. Line breaks come from pretext (no DOM measuring); each
 * unique glyph is painted once into `atlas`.
 * ponytail: advances ignore kerning, so lines can drift a few px from the DOM; use per-line prefix widths if that shows.
 */
export function layoutText(elements: Element[], rects: Float32Array, atlas: HTMLCanvasElement): TextLayout {
  const dpr = devicePixelRatio;
  const ctx = atlas.getContext('2d')!;
  ctx.textBaseline = 'alphabetic';
  const glyphs: Glyph[] = [];
  const cells = new Map<string, { g: string; font: string; m: Metrics; px: number; py: number }>();

  elements.forEach((el, i) => {
    const style = getComputedStyle(el);
    const split = ((el as HTMLElement).dataset.split ?? 'lines') as Split;
    const step = DELAY[split] ?? DELAY.lines;
    let word = 0; // advances at each word end, including line ends
    let inWord = false;
    let char = 0;
    const { font, prepared } = prepare(el, style);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;

    const base = rects.subarray(i * STRIDE, (i + 1) * STRIDE);
    ctx.font = font;
    const fm = measure(ctx, `${font}|M`, 'M');
    // CSS centres the font's ascent+descent box inside the line box.
    const baseline = (lineHeight - (fm.fontAscent + fm.fontDescent)) / 2 + fm.fontAscent;
    // Single-line (nowrap) text never wraps, and its canvas advances are scaled
    // to the DOM width: canvas advances skip kerning, so unscaled they overrun
    // the box (a fitted headline would spill a letter or misplace what follows).
    const nowrap = style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre';
    breakLines(prepared, nowrap ? Infinity : base[2], lineHeight).forEach((line, j) => {
      let x = base[0];
      let fit = 1;
      if (nowrap) {
        let sum = 0;
        for (const { segment: g } of segmenter.segment(line)) sum += measure(ctx, `${font}|${g}`, g).advance;
        if (sum > 0) fit = base[2] / sum;
      }
      const y = base[1] + j * lineHeight + baseline;
      // Mask edge: the line box, or lower if a descender (g, y, p) hangs past it.
      let lineBottom = base[1] + (j + 1) * lineHeight;
      for (const { segment: g } of segmenter.segment(line))
        lineBottom = Math.max(lineBottom, y + measure(ctx, `${font}|${g}`, g).descent);
      for (const { segment: g } of segmenter.segment(line)) {
        const gk = `${font}|${g}`;
        const m = measure(ctx, gk, g);
        if (g.trim()) {
          const unit = split === 'chars' ? char++ : split === 'words' ? word : j;
          glyphs.push({ key: gk, base, x, y, m, block: i, delay: unit * step, lineBottom });
          if (!cells.has(gk)) cells.set(gk, { g, font, m, px: 0, py: 0 });
          inWord = true;
        } else if (inWord) {
          word++;
          inWord = false;
        }
        x += m.advance * fit;
      }
      if (inWord) word++;
      inWord = false;
    });
  });

  // Shelf-pack unique glyph ink boxes into the atlas in device pixels.
  let cx = 0;
  let cy = 0;
  let rowHeight = 0;
  for (const c of cells.values()) {
    const w = Math.ceil((c.m.left + c.m.right) * dpr) + 1;
    const h = Math.ceil((c.m.ascent + c.m.descent) * dpr) + 1;
    if (cx + w > ATLAS_WIDTH) {
      cx = 0;
      cy += rowHeight;
      rowHeight = 0;
    }
    c.px = cx;
    c.py = cy;
    cx += w;
    rowHeight = Math.max(rowHeight, h);
  }
  atlas.width = ATLAS_WIDTH; // resets ctx state
  atlas.height = Math.max(1, cy + rowHeight);

  // Glyphs are painted white; the shader tints them with the DOM colour.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  for (const c of cells.values()) {
    ctx.font = c.font;
    ctx.fillText(c.g, c.px / dpr + c.m.left, c.py / dpr + c.m.ascent);
  }

  const out = new Float32Array(glyphs.length * TEXT_STRIDE);
  const block = new Uint16Array(glyphs.length);
  const delay = new Float32Array(glyphs.length);
  glyphs.forEach((g, i) => {
    const { m } = g;
    const c = cells.get(g.key)!;
    const w = m.left + m.right;
    const h = m.ascent + m.descent;
    const o = i * TEXT_STRIDE;
    out.set(g.base, o);
    out.set([g.x - m.left, g.y - m.ascent, w, h], o);
    out.set([
      c.px / atlas.width,
      c.py / atlas.height,
      (c.px + w * dpr) / atlas.width,
      (c.py + h * dpr) / atlas.height,
    ], o + STRIDE);
    out[o + 12] = g.lineBottom;
    block[i] = g.block;
    delay[i] = g.delay;
  });
  return { data: out, block, delay };
}
