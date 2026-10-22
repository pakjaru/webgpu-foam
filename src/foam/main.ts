import { compileRects, initDomCompiler, STRIDE } from './lib/dom_compiler';
import { gsap } from './lib/gsap';
import { createSmoothScroll } from './lib/lenis';
import { createPipelines, SAMPLES } from './renderer/pipelines';
import { applyMeta, routeIndex } from './router/routes';
import { FAN_CARDS, fanCards, fanPhotos } from './scene/fan';
import { gridMesh } from './scene/grid_mesh';
import { loadPhotos, PHOTOS } from './scene/photos';
import { fitTitle } from './text/fit_title';
import { layoutText, TEXT_STRIDE, warmText } from './text/text_layout';
import { lookAt, multiply, perspective } from '../math/mat4';
import { requiredElement } from '../utils/dom';
import { createBufferWithData, initializeWebGPU, resizeCanvasToDisplaySize } from '../webgpu/utils';

// The renderer: Rust (wasm) compiles the DOM into instance buffers, pretext
// lays out the text, and this file owns the GPU, the routes and the input.
// Each route is its own scene rendered to its own texture; a composite pass
// reveals one through the other with a growing circle.
// Reduced motion: the circle reveal is near-instant and text appears whole.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const REVEAL_SECONDS = REDUCED ? 0.15 : 1.6;
const REVEAL_AT = 0.9; // droplet progress at which the new route's text starts rising
const GLYPH_SECONDS = 1.4; // split-text: how long each glyph takes to rise
const glyphEase = gsap.parseEase('power3.out');

type Mode = 'solid' | 'wire' | 'both';

const canvas = requiredElement<HTMLCanvasElement>('#webgpu-canvas');
const message = requiredElement<HTMLDivElement>('#message');
const routes = [...document.querySelectorAll<HTMLElement>('[data-route]')].map((root) => ({
  root,
  path: root.dataset.route!,
}));
const ABOUT = routes.findIndex((r) => r.path === '/about');
const WORK = routes.findIndex((r) => r.path === '/work');
const SLIDES = 13;
const SLIDE_SECONDS = 1.1;
const LIST_SECONDS = 1.1; // work: slideshow <-> list view
const SLIDE_PHOTOS = [2, 6, 9, 11, 0, 4, 7, 12, 1, 3, 5, 8, 10]; // every photo, in slide order

async function main(): Promise<void> {
  await Promise.all([initDomCompiler(), document.fonts.ready]);
  // Size the hero title before anything reads layout; refit before every
  // resize-driven recompile (resize handlers run before ResizeObserver).
  fitTitle();
  addEventListener('resize', fitTitle);
  const { device, context, format } = await initializeWebGPU(canvas);
  context.configure({ device, format, alphaMode: 'opaque' });

  const mesh = gridMesh();
  const uvBuf = createBufferWithData(device, 'uv', mesh.uvs, GPUBufferUsage.VERTEX);
  const triBuf = createBufferWithData(device, 'tris', mesh.tris, GPUBufferUsage.INDEX);
  const lineBuf = createBufferWithData(device, 'lines', mesh.lines, GPUBufferUsage.INDEX);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const fan = createBufferWithData(device, 'fan', fanCards(), GPUBufferUsage.VERTEX);

  const photos = await loadPhotos(device);
  const slideUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const photoEntries: GPUBindGroupEntry[] = [
    { binding: 2, resource: sampler },
    { binding: 3, resource: photos.texture.createView({ dimension: '2d-array' }) },
    { binding: 4, resource: { buffer: slideUniform } },
    { binding: 5, resource: { buffer: photos.aspects } },
  ];

  const { boxLayout, textLayout, pipelines, composite } = createPipelines(device, format);
  const compositeUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  interface Draw {
    pipeline: GPURenderPipeline;
    bindGroup: GPUBindGroup;
    uniform: GPUBuffer;
    index: GPUBuffer;
    n: number;
    instances: GPUBuffer;
    count: number;
    wire: number;
    ring: number;
    scene: number;
    slot2: GPUBuffer; // reveal progress (text) or photo layers (boxes)
    lift?: number; // 1 = swells under the cursor
    list?: number; // 1 = fades with the work list view
    copy?: number; // work list repeat: drawn one list period (k * H) further down
  }

  // Split-text state. `time` per text element survives recompiles (resize);
  // gsap tweens it, and each frame turns it into per-glyph progress.
  const blockTime = new WeakMap<Element, { time: number }>();
  const timeOf = (el: Element) => {
    let t = blockTime.get(el);
    if (!t) blockTime.set(el, (t = { time: 0 }));
    return t;
  };
  interface Reveal {
    buffer: GPUBuffer;
    elements: Element[];
    block: Uint16Array;
    delay: Float32Array;
    progress: Float32Array<ArrayBuffer>;
  }
  const reveals: (Reveal | null)[] = routes.map(() => null);
  let draws: Draw[] = [];
  // Work hero image: its layout rect, the per-frame buffer, and the list thumbnails it can shrink into.
  let heroRect = new Float32Array(4);
  let heroBuffer: GPUBuffer | null = null;
  let listThumbs = new Float32Array(0);
  // Work list rows (doc px, x/y/w/h per row) and the repeat period: the list is
  // drawn three times, one period apart, and scrolled modulo the period.
  let listRows = new Float32Array(0);
  let listPeriod = 1;
  let thumbBuffer: GPUBuffer | null = null;
  const COPIES = [-1, 0, 1];
  let owned: { destroy(): void }[] = [];
  const atlases = routes.map(() => document.createElement('canvas'));

  // One uniform buffer per draw: queue writes land before the passes run, so
  // draws can't share one buffer with different per-draw values.
  const addDraw = (
    d: Omit<Draw, 'uniform' | 'bindGroup' | 'instances' | 'count'>,
    instances: GPUBuffer,
    count: number,
    extra: GPUBindGroupEntry[] = photoEntries,
    layout = extra === photoEntries ? boxLayout : textLayout,
  ) => {
    const uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(uniform);
    const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }, ...extra] });
    draws.push({ ...d, uniform, bindGroup, instances, count });
  };
  const vertexBuffer = (label: string, data: Float32Array<ArrayBuffer>) => {
    const b = createBufferWithData(device, label, data, GPUBufferUsage.VERTEX);
    owned.push(b);
    return b;
  };
  const boxDraws = (scene: number, inst: GPUBuffer, count: number, ring: number, slot2: GPUBuffer) => {
    addDraw({ pipeline: pipelines.boxSolid, index: triBuf, n: mesh.tris.length, wire: 0, ring, scene, slot2, lift: 1 }, inst, count);
    addDraw({ pipeline: pipelines.boxWire, index: lineBuf, n: mesh.lines.length, wire: 1, ring, scene, slot2, lift: 1 }, inst, count);
  };
  const noPhotos = (count: number) => vertexBuffer('no-photos', new Float32Array(count).fill(-1));
  // Fan panes cycle through every photo.
  const fanLayers = createBufferWithData(device, 'fan-photos', fanPhotos(), GPUBufferUsage.VERTEX);

  // Yields after each route so the first compile can be spread across tasks.
  const compileScenes = function* () {
    for (const r of owned) r.destroy();
    owned = [];
    draws = [];

    let photo = 0;
    for (const [scene, { root }] of routes.entries()) {
      if (scene === ABOUT) boxDraws(scene, fan, FAN_CARDS, 1, fanLayers);
      // Mesh-gradient backgrounds ([data-gl-bg]) go first, under everything else.
      const bgs = compileRects(root, '[data-gl-bg]', 'background-color');
      if (bgs.length)
        addDraw(
          { pipeline: pipelines.mesh, index: triBuf, n: mesh.tris.length, wire: 0, ring: 0, scene, slot2: noPhotos(bgs.length / STRIDE) },
          vertexBuffer('backgrounds', bgs),
          bgs.length / STRIDE,
        );
      const boxes = compileRects(root, '[data-gl]', 'background-color');
      if (boxes.length) {
        // Leaf panes get the next photo (or their data-photo); containers keep their colour.
        const layers = [...root.querySelectorAll<HTMLElement>('[data-gl]')].map((el) =>
          el.dataset.photo ? Number(el.dataset.photo) : el.querySelector('[data-gl]') ? -1 : photo++ % PHOTOS.length,
        );
        const inst = vertexBuffer('boxes', boxes);
        const slot2 = vertexBuffer('photos', Float32Array.from(layers));
        if (scene === WORK) {
          thumbBuffer = device.createBuffer({ size: boxes.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          owned.push(thumbBuffer);
          device.queue.writeBuffer(thumbBuffer, 0, boxes);
          // Work's only boxes are the list thumbnails: they fade with the list view.
          listThumbs = boxes;
          listRows = compileRects(root, '#work-list .row-btn', 'color');
          const n = listRows.length / STRIDE;
          const gap = n > 1 ? listRows[STRIDE + 1] - (listRows[1] + listRows[3]) : 0;
          listPeriod = Math.max(1, listRows[(n - 1) * STRIDE + 1] + listRows[(n - 1) * STRIDE + 3] + gap - listRows[1]);
          for (const copy of COPIES) {
            addDraw({ pipeline: pipelines.boxFade, index: triBuf, n: mesh.tris.length, wire: 0, ring: 0, scene, slot2, list: 1, copy }, thumbBuffer, boxes.length / STRIDE);
            addDraw({ pipeline: pipelines.boxWire, index: lineBuf, n: mesh.lines.length, wire: 1, ring: 0, scene, slot2, list: 1, copy }, thumbBuffer, boxes.length / STRIDE);
          }
        } else boxDraws(scene, inst, boxes.length / STRIDE, 0, slot2);
      }
      const imgs = compileRects(root, '[data-gl-image]', 'background-color');
      if (imgs.length) {
        // The work image is rewritten per frame so it can shrink into a list row.
        heroRect = imgs.slice(0, 4);
        heroBuffer = device.createBuffer({ size: STRIDE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        owned.push(heroBuffer);
        device.queue.writeBuffer(heroBuffer, 0, imgs.subarray(0, STRIDE));
        addDraw(
          { pipeline: pipelines.image, index: triBuf, n: mesh.tris.length, wire: 0, ring: 0, scene, slot2: noPhotos(1) }, // no cursor bulge on the work slideshow
          heroBuffer,
          1,
        );
      }

      yield;
      const atlas = atlases[scene];
      const textEls = [...root.querySelectorAll('[data-gl-text]')];
      const text = layoutText(textEls, compileRects(root, '[data-gl-text]', 'color'), atlas);
      const glyphCount = text.data.length / TEXT_STRIDE;
      reveals[scene] = null;
      if (glyphCount) {
        const inst = vertexBuffer('text', text.data);
        const progress = new Float32Array(glyphCount);
        const buffer = device.createBuffer({ size: progress.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        owned.push(buffer);
        reveals[scene] = { buffer, elements: textEls, block: text.block, delay: text.delay, progress };
        const texture = device.createTexture({
          size: [atlas.width, atlas.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture({ source: atlas }, { texture }, [atlas.width, atlas.height]);
        owned.push(texture);
        // Work text repeats with the list (slide titles in the extra copies sit a
        // whole period off screen).
        for (const copy of scene === WORK ? COPIES : [0]) {
          addDraw({ pipeline: pipelines.textSolid, index: triBuf, n: mesh.tris.length, wire: 0, ring: 0, scene, slot2: buffer, copy }, inst, glyphCount, [
            { binding: 1, resource: texture.createView() },
            { binding: 2, resource: sampler },
          ]);
          addDraw({ pipeline: pipelines.textWire, index: lineBuf, n: mesh.lines.length, wire: 1, ring: 0, scene, slot2: buffer, copy }, inst, glyphCount);
        }
      }

      // Frames: wire-only outlines around text wrappers and text blocks.
      const frames = compileRects(root, '[data-gl-frame], [data-gl-text]:not([data-slide]):not([data-list])', 'color');
      if (frames.length)
        addDraw(
          { pipeline: pipelines.boxWire, index: lineBuf, n: mesh.lines.length, wire: 1, ring: 0, scene, slot2: noPhotos(frames.length / STRIDE) },
          vertexBuffer('frames', frames),
          frames.length / STRIDE,
        );
      yield;
    }
  };
  const recompile = () => {
    for (const _ of compileScenes());
  };
  // Startup work is spread over tasks (one text block, then one route, per task).
  const nextTask = () => new Promise((r) => setTimeout(r));
  for (const el of document.querySelectorAll('[data-gl-text]')) {
    warmText(el);
    await nextTask();
  }
  for (const _ of compileScenes()) await nextTask();
  const observer = new ResizeObserver(recompile);
  for (const { root } of routes) observer.observe(root);

  let mode: Mode = 'solid';
  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
  for (const b of modeButtons)
    b.onclick = () => {
      mode = b.dataset.mode as Mode;
      for (const o of modeButtons) o.ariaPressed = String(o === b);
    };

  // Router: History API paths, no deps. A route change starts a droplet reveal
  // from the shown scene (`from`) to the new one (`to`).
  let from = routeIndex();
  let to = from;
  let p = 0;
  // Smooth scroll. Lenis moves the real window scroll; the renderer reads it.
  const lenis = createSmoothScroll();
  // Scroll each scene was left at: the outgoing scene keeps it while the
  // reveal plays, so it doesn't jump to the top under the circle.
  const sceneScroll = routes.map(() => 0);
  // Work list view: `v` runs 0 (slideshow) -> 1 (list).
  const list = { v: 0, on: false };
  // Split-text triggers: a text block reveals the first time it is in view
  // during a route visit (scrolled to, or its route entered).
  const inView = new Set<Element>();
  const sceneOf = (el: Element) => routes.findIndex((r) => r.root.contains(el));
  const played = new WeakSet<Element>(); // once per route visit; scrolling doesn't replay
  // Work slides: `cur` shows, `next` rises over it while `k` runs 0 -> 1.
  const slide = { cur: 0, next: 0, k: 0 };
  const isHiddenSlide = (el: Element) => {
    const { slide: s, list: inList } = (el as HTMLElement).dataset;
    if (inList !== undefined) return !list.on;
    return s !== undefined && (list.on || Number(s) !== slide.next);
  };
  // Text waits for the intro loader to clear, then everything in view plays.
  let introDone = !document.getElementById('loader');
  addEventListener('foam:intro-done', () => {
    introDone = true;
    for (const el of inView) if (sceneOf(el) === to) play(el);
  }, { once: true });
  const play = (el: Element) => {
    if (!introDone || played.has(el) || isHiddenSlide(el)) return;
    played.add(el);
    const reveal = reveals[sceneOf(el)];
    const i = reveal?.elements.indexOf(el) ?? -1;
    let last = 0;
    if (reveal) for (let g = 0; g < reveal.block.length; g++) if (reveal.block[g] === i) last = Math.max(last, reveal.delay[g]);
    const duration = last + GLYPH_SECONDS;
    // Mid route-change, wait until the droplet has mostly uncovered the page.
    const delay = from !== to ? Math.max(0, REVEAL_AT - p) * REVEAL_SECONDS : 0;
    if (REDUCED) timeOf(el).time = duration;
    else gsap.fromTo(timeOf(el), { time: 0 }, { time: duration, duration, delay, ease: 'none', overwrite: true });
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        inView.add(e.target);
        if (sceneOf(e.target) === to) play(e.target);
      } else {
        inView.delete(e.target);
      }
    }
  });
  for (const el of document.querySelectorAll('[data-gl-text]')) io.observe(el);

  const counter = requiredElement<HTMLSpanElement>('#counter');
  const pad = (n: number) => String(n).padStart(2, '0');
  // Thumbnails are static in foam.html (small files, painted before the GPU starts).
  const thumbs = [...document.querySelectorAll<HTMLButtonElement>('#minimap button')];
  // The minimap shows five thumbnails with the current one in the middle and
  // wraps around: CSS `order` rotates the row so slide i always sits third.
  const centerThumb = (i: number) => thumbs.forEach((b, j) => (b.style.order = String((j - i + 2 + SLIDES) % SLIDES)));
  // Like wheel and keys, a thumbnail click waits for a running slide change to finish.
  const sliding = () => slide.k > 0 && slide.k < 1;
  thumbs.forEach((b, i) => (b.onclick = () => !sliding() && goTo(i)));
  const slideText = (i: number) => routes[WORK].root.querySelectorAll(`[data-slide="${i}"]`);
  const replay = (el: Element, delay: number) => {
    played.delete(el);
    gsap.killTweensOf(timeOf(el));
    timeOf(el).time = 0;
    gsap.delayedCall(delay, () => play(el));
  };
  const sink = (el: Element) => gsap.to(timeOf(el), { time: 0, duration: 0.5, ease: 'power2.in', overwrite: true });
  const goTo = (i: number, instant = false) => {
    if (i === slide.next) return;
    // The outgoing title sinks back under its mask; the new one rises.
    for (const el of slideText(slide.next)) sink(el);
    slide.cur = slide.next;
    slide.next = i;
    thumbs.forEach((b, j) => b.toggleAttribute('aria-current', j === i));
    counter.textContent = `${pad(i + 1)} / ${pad(SLIDES)}`;
    centerThumb(i);
    if (instant) {
      // Jump straight to slide i (its title plays when the slideshow returns).
      gsap.killTweensOf(slide);
      slide.cur = i;
      slide.k = 1;
      return;
    }
    for (const el of slideText(i)) replay(el, SLIDE_SECONDS * 0.4);
    gsap.fromTo(slide, { k: 0 }, { k: 1, duration: REDUCED ? 0.01 : SLIDE_SECONDS, ease: 'none', overwrite: true });
  };

  // Work navigation: arrow keys and wheel step through slides. A wheel gesture
  // (including trackpad momentum) moves exactly one slide: the lock releases
  // only after the wheel has been quiet for a moment.
  const step = (dir: number) => {
    // A slide change plays out in full before the next one can start.
    if (to !== WORK || list.on || sliding()) return;
    goTo((slide.next + dir + SLIDES) % SLIDES);
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && list.on) setList(false);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
  });
  let wheelLock = false;
  let wheelTimer = 0;
  addEventListener(
    'wheel',
    (e) => {
      if (to !== WORK || list.on) return;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => (wheelLock = false), 220);
      if (wheelLock || Math.abs(e.deltaY) < 10) return;
      wheelLock = true;
      step(Math.sign(e.deltaY));
    },
    { passive: true },
  );

  // Work list view. The hero image shrinks into its row while the other rows
  // fade in; every part is a tween that a new toggle simply overwrites.
  const listToggle = requiredElement<HTMLButtonElement>('#list-toggle');
  const listText = () => routes[WORK].root.querySelectorAll('[data-list]');
  // Only home scrolls the document (with Lenis); the work list scrolls itself.
  const allowScroll = () => to === 0;
  // List scroll, unbounded: rows are drawn modulo `listPeriod`, so it never ends.
  const listScroll = { y: 0, target: 0 };
  const listBase = () => ((listScroll.y % listPeriod) + listPeriod) % listPeriod;
  const rowCenter = (i: number) => listRows[i * STRIDE + 1] + listRows[i * STRIDE + 3] / 2;
  const syncScroll = () => {
    document.documentElement.style.overflow = allowScroll() ? '' : 'hidden';
    if (allowScroll()) lenis.start();
    else lenis.stop();
  };
  const setList = (on: boolean, instant = false) => {
    if (on === list.on) return;
    list.on = on;
    document.body.classList.toggle('work-list', on);
    listToggle.ariaPressed = String(on);
    listToggle.textContent = on ? 'Slides' : 'Index';
    for (const id of ['#nav', '#view']) requiredElement(id).classList.toggle('on-dark', to === WORK && !on);
    gsap.to(list, {
      v: on ? 1 : 0,
      duration: instant || REDUCED ? 0.01 : LIST_SECONDS,
      ease: 'power3.inOut',
      overwrite: true,
      // Once the rows have faded out, return the list to its origin so the
      // slideshow's own text (which shares the list's scroll) sits unshifted.
      onComplete: () => void (!list.on && (listScroll.y = listScroll.target = 0)),
    });
    if (on) {
      // Open with the current slide's row in the middle of the screen, so the
      // image always shrinks to the centre whatever its index.
      const y = Math.round(listScroll.y / listPeriod) * listPeriod + rowCenter(slide.next) - innerHeight / 2;
      listScroll.y = listScroll.target = y;
      for (const el of slideText(slide.next)) sink(el);
      for (const el of listText()) {
        played.delete(el);
        gsap.killTweensOf(timeOf(el));
        timeOf(el).time = 0;
        gsap.delayedCall(LIST_SECONDS * 0.5, () => play(el));
      }
    } else {
      for (const el of listText()) {
        gsap.killTweensOf(timeOf(el));
        if (instant) timeOf(el).time = 0;
        else sink(el);
      }
      // Titles rise once the list has gone (and its scroll has reset).
      for (const el of slideText(slide.next)) replay(el, instant ? 0 : LIST_SECONDS);
      listScroll.target = listScroll.y; // stop any glide: no scrolling while it closes
      if (instant) listScroll.y = listScroll.target = 0;
    }
    syncScroll();
  };
  // List input: wheel and drag move the target; the frame loop eases toward it.
  const drag = { active: false, y: 0, moved: 0 };
  addEventListener('wheel', (e) => to === WORK && list.on && (listScroll.target += e.deltaY), { passive: true });
  addEventListener('pointerdown', (e) => {
    if (to !== WORK || !list.on || (e.target as Element).closest('a, button')) return;
    Object.assign(drag, { active: true, y: e.clientY, moved: 0 });
  });
  addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    listScroll.target -= e.clientY - drag.y;
    drag.moved += Math.abs(e.clientY - drag.y);
    drag.y = e.clientY;
  });
  /** The list row under a viewport point, in whichever drawn copy it lands, or -1. */
  const rowAt = (x: number, clientY: number) => {
    const y = clientY + listBase();
    for (const k of COPIES)
      for (let i = 0; i < listRows.length / STRIDE; i++) {
        const [rx, ry, rw, rh] = listRows.subarray(i * STRIDE, i * STRIDE + 4);
        const top = ry + k * listPeriod;
        if (x >= rx && x <= rx + rw && y >= top && y <= top + rh) return i;
      }
    return -1;
  };
  // Hovered row (-1 none) and each row's eased hover amount, for the image grow.
  let hoverRow = -1;
  let hoverX = 0;
  let hoverY = 0;
  const rowHover = new Float32Array(SLIDES);
  addEventListener('pointermove', (e) => ([hoverX, hoverY] = [e.clientX, e.clientY]));
  addEventListener('pointerup', (e) => {
    if (!drag.active) return;
    drag.active = false;
    if (drag.moved > 6) return;
    const i = rowAt(e.clientX, e.clientY);
    if (i >= 0) openRow(i);
  });
  addEventListener('keydown', (e) => {
    if (to !== WORK || !list.on) return;
    if (e.key === 'ArrowDown') listScroll.target += 200;
    if (e.key === 'ArrowUp') listScroll.target -= 200;
  });
  listToggle.onclick = () => setList(!list.on);
  const openRow = (i: number) => {
    goTo(i, true);
    setList(false);
  };
  // Keyboard / assistive-tech activation of the (invisible) row buttons.
  for (const b of document.querySelectorAll<HTMLButtonElement>('#work-list .row-btn'))
    b.onclick = (e) => e.detail === 0 && openRow(Number(b.dataset.index));
  thumbs[0].toggleAttribute('aria-current', true);
  centerThumb(0);

  const workUi = requiredElement<HTMLDivElement>('#work-ui');
  const onRoute = () => {
    const next = routeIndex();
    if (next !== to) {
      // The scene being left keeps the scroll it was at while it is revealed over.
      sceneScroll[to] = scrollY;
      // A click mid-reveal starts over from whichever scene covers more screen.
      if (p > 0.5) from = to;
      to = next;
      p = 0;
      // Entering a route is a new visit: its text hides and reveals again.
      for (const el of routes[to].root.querySelectorAll('[data-gl-text]')) {
        played.delete(el);
        gsap.killTweensOf(timeOf(el));
        timeOf(el).time = 0;
        if (inView.has(el)) play(el);
      }
    }
    lenis.scrollTo(0, { immediate: true, force: true });
    // Home scrolls; work only in its list view.
    syncScroll();
    // Only the current route's text is exposed to assistive tech (inert), and
    // each route gets its own title, description, canonical URL and chrome.
    applyMeta(next);
    // The work chrome (minimap, Index) waits until the reveal into work has finished.
    workUi.hidden = !(next === WORK && from === to);
    // Chrome sits on the full-bleed image on work, so it flips to light.
    for (const id of ['#nav', '#view']) requiredElement(id).classList.toggle('on-dark', next === WORK && !list.on);
  };
  addEventListener('popstate', onRoute);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('#nav a'))
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // new tab etc. stays native
      if (a.origin !== location.origin) return; // mailto: and external links stay native
      e.preventDefault();
      if (a.pathname !== location.pathname) history.pushState(null, '', a.pathname);
      onRoute();
    };
  onRoute();

  // Per-scene render targets, sized with the canvas.
  // Cursor for the photo bulge, in viewport px, eased toward the pointer.
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, hover: 0, active: 0 };
  addEventListener('pointermove', (e) => {
    mouse.tx = e.clientX;
    mouse.ty = e.clientY; // viewport px; scroll is added per frame
    if (!mouse.active) [mouse.x, mouse.y] = [mouse.tx, mouse.ty];
    mouse.active = 1;
  });
  document.documentElement.addEventListener('pointerleave', () => (mouse.active = 0));

  // About fan: still by default; drag or scroll to spin it, then it coasts
  // to a stop. Velocity feeds the shader's wave.
  const spin = { angle: 0, vel: 0, dragging: false, lastX: 0 };
  const onAbout = () => to === ABOUT && from === to;
  addEventListener('pointerdown', (e) => {
    if (!onAbout() || (e.target as Element).closest('a, button')) return;
    spin.dragging = true;
    spin.lastX = e.clientX;
    document.body.style.cursor = 'grabbing';
  });
  addEventListener('pointermove', (e) => {
    if (!spin.dragging) return;
    const da = (e.clientX - spin.lastX) * 0.006;
    spin.lastX = e.clientX;
    spin.angle += da;
    spin.vel = Math.max(-8, Math.min(8, spin.vel * 0.6 + (da / (1 / 60)) * 0.4)); // rad/s, smoothed, capped
  });
  addEventListener('pointerup', () => {
    spin.dragging = false;
    document.body.style.cursor = '';
  });
  addEventListener('wheel', (e) => onAbout() && (spin.vel += e.deltaY * 0.004), { passive: true });

  let depth: GPUTexture | null = null;
  let msaa: GPUTexture | null = null;
  let sceneTextures: GPUTexture[] = [];
  const compositeGroups = new Map<string, GPUBindGroup>();
  const compositeGroup = (a: number, b: number) => {
    const key = `${a}>${b}`;
    let g = compositeGroups.get(key);
    if (!g) {
      g = device.createBindGroup({
        layout: composite.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: compositeUniform } },
          { binding: 1, resource: sceneTextures[a].createView() },
          { binding: 2, resource: sceneTextures[b].createView() },
          { binding: 3, resource: sampler },
        ],
      });
      compositeGroups.set(key, g);
    }
    return g;
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    if (from !== to) {
      p = Math.min(1, p + dt / REVEAL_SECONDS);
      if (p >= 1) {
        from = to;
        workUi.hidden = to !== WORK;
        // Work was left from its list view: reset it now that it is off screen.
        if (to !== WORK && list.on) setList(false, true);
        p = 0;
      }
    }

    if (resizeCanvasToDisplaySize(canvas, device.limits.maxTextureDimension2D) || !depth) {
      depth?.destroy();
      msaa?.destroy();
      for (const t of sceneTextures) t.destroy();
      compositeGroups.clear();
      const size = [canvas.width, canvas.height];
      depth = device.createTexture({ size, format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      // One multisampled target, reused by each scene pass before it resolves.
      msaa = device.createTexture({ size, format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      sceneTextures = routes.map(() =>
        device.createTexture({ size, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }),
      );
    }

    // Camera distance where the z=0 plane maps 1 world unit to 1 CSS px.
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const fov = Math.PI / 4;
    const dist = h / 2 / Math.tan(fov / 2);
    const viewProj = multiply(perspective(fov, w / h, 1, dist * 4), lookAt([0, 0, dist], [0, 0, 0]));

    lenis.raf(now);
    listScroll.y += (listScroll.target - listScroll.y) * (1 - Math.exp(-dt * 8));
    const base = listBase();
    // List hover: pointer cursor over a row, and that row's image grows a little.
    const listLive = to === WORK && from === to && list.on && list.v > 0.99;
    const hovered = listLive && !drag.active ? rowAt(hoverX, hoverY) : -1;
    if (hovered !== hoverRow) {
      hoverRow = hovered;
      document.body.style.cursor = hovered >= 0 ? 'pointer' : '';
    }
    if (thumbBuffer && listThumbs.length) {
      const k = 1 - Math.exp(-dt * 10);
      const grown = listThumbs.slice();
      for (let i = 0; i < rowHover.length; i++) {
        rowHover[i] += ((i === hoverRow ? 1 : 0) - rowHover[i]) * k;
        const g = rowHover[i] * 0.06; // up to 6% larger, about its centre
        const o = i * STRIDE;
        grown[o] -= (grown[o + 2] * g) / 2;
        grown[o + 1] -= (grown[o + 3] * g) / 2;
        grown[o + 2] *= 1 + g;
        grown[o + 3] *= 1 + g;
        grown[o + 7] = rowHover[i]; // nudge the grown image above its neighbours
      }
      device.queue.writeBuffer(thumbBuffer, 0, grown);
    }
    // Work hero image: full screen, eased toward the on-screen copy of the
    // current slide's list row (screen px), then back into doc px for the draw.
    if (heroBuffer && listThumbs.length) {
      const e = list.v;
      const t = listThumbs.slice(slide.next * STRIDE, slide.next * STRIDE + 4);
      const ys = COPIES.map((k) => t[1] + k * listPeriod - base);
      t[1] = ys.reduce((a, b) => (Math.abs(b + t[3] / 2 - innerHeight / 2) < Math.abs(a + t[3] / 2 - innerHeight / 2) ? b : a));
      const rect = heroRect.map((v, i) => v + (t[i] - v) * e);
      rect[1] += base;
      device.queue.writeBuffer(heroBuffer, 0, new Float32Array([...rect, 0, 0, 0, 1]));
    }

    const ease = 1 - Math.exp(-dt * 10);
    mouse.x += (mouse.tx - mouse.x) * ease;
    mouse.y += (mouse.ty - mouse.y) * ease;
    mouse.hover += ((REDUCED ? 0 : mouse.active) - mouse.hover) * ease;

    if (!spin.dragging) {
      spin.angle += spin.vel * dt;
      spin.vel *= Math.exp(-dt * 1.8); // friction
      if (Math.abs(spin.vel) < 1e-3) spin.vel = 0;
    } else spin.vel *= Math.exp(-dt * 8); // a held, still pointer settles the wave

    const encoder = device.createCommandEncoder();
    // Only scenes on screen get rendered: one at rest, two mid-reveal.
    for (const scene of new Set([from, to])) {
      const reveal = reveals[scene];
      if (reveal) {
        const times = reveal.elements.map((el) => timeOf(el).time);
        for (let g = 0; g < reveal.progress.length; g++) {
          const local = (times[reveal.block[g]] - reveal.delay[g]) / GLYPH_SECONDS;
          reveal.progress[g] = glyphEase(Math.min(1, Math.max(0, local)));
        }
        device.queue.writeBuffer(reveal.buffer, 0, reveal.progress);
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: msaa!.createView(),
          resolveTarget: sceneTextures[scene].createView(),
          clearValue: scene === ABOUT ? [0.922, 0.902, 0.863, 1] : [0.965, 0.957, 0.937, 1], // --paper / about tint
          loadOp: 'clear',
          storeOp: 'discard', // only the resolved texture is kept
        }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setVertexBuffer(0, uvBuf);
      const sc0 = scene === to ? scrollY : sceneScroll[scene];
      for (const d of draws) {
        // Work draws scroll with the list; copies sit k periods further down.
        const sc = scene === WORK ? base - (d.copy ?? 0) * listPeriod : sc0;
        if (d.scene !== scene) continue;
        if ((d.wire && mode === 'solid') || (!d.wire && mode === 'wire')) continue;
        const u = new Float32Array(32);
        u.set(viewProj);
        u.set([w, h, sc, spin.angle, FAN_CARDS, d.wire, d.ring, spin.vel, mouse.x, mouse.y + sc, mouse.hover, d.lift ?? 0, d.list ? list.v : 1, now / 1000], 16);
        device.queue.writeBuffer(d.uniform, 0, u);
        pass.setPipeline(d.pipeline);
        pass.setBindGroup(0, d.bindGroup);
        pass.setVertexBuffer(1, d.instances);
        pass.setVertexBuffer(2, d.slot2);
        pass.setIndexBuffer(d.index, 'uint16');
        pass.drawIndexed(d.n, d.count);
      }
      pass.end();
    }

    device.queue.writeBuffer(slideUniform, 0, new Float32Array([SLIDE_PHOTOS[slide.cur], SLIDE_PHOTOS[slide.next], slide.k, list.v]));
    device.queue.writeBuffer(compositeUniform, 0, new Float32Array([p, w / h, now / 1000, 0]));
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(composite);
    pass.setBindGroup(0, compositeGroup(from, to));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
    // The first rendered frame tells the loader it can finish.
    if (!readySent) dispatchEvent(new Event('foam:ready'));
    readySent = true;
  };
  let readySent = false;
  requestAnimationFrame(frame);
}

main().catch((error) => {
  dispatchEvent(new Event('foam:ready')); // never leave the loader up over the error
  console.error(error);
  message.textContent = error instanceof Error ? error.message : String(error);
  message.classList.add('visible');
});
