const GAP = 18; // px of air between the title's ink and the outer grid lines, both sides

const ctx = document.createElement('canvas').getContext('2d')!;

/**
 * Sizes and places the hero title (.mh-title) so its ink (not its text box,
 * whose side bearings differ per glyph) sits exactly GAP px inside the outer
 * grid lines on both sides, at any screen size. Needs the title's font loaded.
 */
export function fitTitle() {
  const title = document.querySelector<HTMLElement>('.mh-title');
  const parent = title?.offsetParent;
  if (!title || !parent) return;
  // --gutter is a max() expression, so read the outer line's resolved position.
  const left = parent.querySelector<HTMLElement>('.k0')?.offsetLeft ?? 0;
  const target = parent.clientWidth - 2 * left - 2 * GAP; // ink width wanted

  /** Left and right ink edges of the title as the browser lays it out (kerning included). */
  const ink = () => {
    const style = getComputedStyle(title);
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const first = title.firstElementChild as HTMLElement;
    const last = title.lastElementChild as HTMLElement;
    const a = ctx.measureText(first.textContent ?? '');
    const b = ctx.measureText(last.textContent ?? '');
    const box = parent.getBoundingClientRect();
    return [first.getBoundingClientRect().left - a.actualBoundingBoxLeft - box.left, last.getBoundingClientRect().left + b.actualBoundingBoxRight - box.left];
  };

  // Ink width isn't exactly proportional to font size (hinting, kerning), so
  // scale toward the target a few times, then shift so the left gap is GAP.
  let size = 100;
  title.style.left = `${left}px`;
  for (let i = 0; i < 4; i++) {
    title.style.fontSize = `${size}px`;
    const [l, r] = ink();
    if (r - l <= 0) return;
    size *= target / (r - l);
  }
  title.style.fontSize = `${size}px`;
  const [l] = ink();
  title.style.left = `${2 * left + GAP - l}px`;

  // Vertically: centre the ink (cap height to baseline, plus any descent) between
  // the top hairline and the middle hairline.
  const [topLine, midLine] = [...parent.querySelectorAll<HTMLElement>('.mh-line.h')].map((el) => el.offsetTop);
  if (midLine === undefined) return;
  const style = getComputedStyle(title);
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const m = ctx.measureText(title.textContent ?? '');
  const lineHeight = parseFloat(style.lineHeight);
  // CSS puts the baseline half-leading + font ascent below the line box top.
  const baseline = (lineHeight - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
  const inkMid = baseline + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2; // from the box top
  title.style.top = `${(topLine + midLine) / 2 - inkMid}px`;
}
