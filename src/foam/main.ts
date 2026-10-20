import init, { compile } from './pkg/dom_compiler.js';
import shaderCode from './shader.wgsl?raw';
import compositeCode from './composite.wgsl?raw';
import gsap from 'gsap';
import { layoutText, TEXT_STRIDE, warmText } from './text';
import { lookAt, multiply, perspective } from '../math/mat4';
import { requiredElement } from '../utils/dom';
import { applyMeta, routeIndex } from './boot';
import { createBufferWithData, initializeWebGPU, resizeCanvasToDisplaySize } from '../webgpu/utils';

// Rust (wasm) owns DOM -> instance-buffer compilation, pretext owns text line
// layout, this file owns the GPU. Each route is its own scene rendered to its
// own texture; a composite pass mixes them with a droplet reveal.
const N = 16; // grid subdivisions per element
const SAMPLES = 4; // MSAA for the scene passes; resolved into each scene texture
const STRIDE = 8; // floats per instance, must match dom-compiler/src/lib.rs
const FAN_CARDS = 13; // one fin per photo
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
const SLIDES = 4;
const SLIDE_SECONDS = 1.1;
// Photos (public/images, webp). Each goes into one square texture array
// layer; its real aspect is kept separately for cover-cropping.
const PHOTOS = Array.from({ length: 13 }, (_, i) => `/images/${String(i).padStart(2, '0')}.webp`);
const LAYER_SIZE = 1024;
const SLIDE_PHOTOS = [2, 6, 9, 11]; // which photos the work slides use

async function loadPhotos(device: GPUDevice) {
  const bitmaps = await Promise.all(PHOTOS.map(async (url) => createImageBitmap(await (await fetch(url)).blob())));
  const texture = device.createTexture({
    size: [LAYER_SIZE, LAYER_SIZE, PHOTOS.length],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  for (const [z, bitmap] of bitmaps.entries()) {
    const square = await createImageBitmap(bitmap, { resizeWidth: LAYER_SIZE, resizeHeight: LAYER_SIZE, resizeQuality: 'high' });
    device.queue.copyExternalImageToTexture({ source: square }, { texture, origin: [0, 0, z] }, [LAYER_SIZE, LAYER_SIZE]);
    await new Promise((r) => setTimeout(r)); // one upload per task keeps the main thread responsive
  }
  const aspects = createBufferWithData(device, 'aspects', new Float32Array(bitmaps.map((b) => b.width / b.height)), GPUBufferUsage.STORAGE);
  return { texture, aspects };
}

function gridMesh() {
  const uvs: number[] = [];
  for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) uvs.push(x / N, y / N);
  const id = (x: number, y: number) => y * (N + 1) + x;
  const tris: number[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      tris.push(id(x, y), id(x + 1, y), id(x, y + 1), id(x + 1, y), id(x + 1, y + 1), id(x, y + 1));
  // Wire = element outline only, along grid vertices.
  const lines: number[] = [];
  for (let i = 0; i < N; i++)
    lines.push(id(i, 0), id(i + 1, 0), id(i, N), id(i + 1, N), id(0, i), id(0, i + 1), id(N, i), id(N, i + 1));
  return { uvs: new Float32Array(uvs), tris: new Uint16Array(tris), lines: new Uint16Array(lines) };
}

/** Fan fins for the about scene: equal 180x240 cards (the shader sizes them; rect drives the photo crop). */
function fanCards(): Float32Array<ArrayBuffer> {
  const out = new Float32Array(FAN_CARDS * STRIDE);
  for (let i = 0; i < FAN_CARDS; i++) out.set([0, 0, 180, 240, 0.5, 0.5, 0.5, 0], i * STRIDE);
  return out;
}

async function main(): Promise<void> {
  await Promise.all([init(), document.fonts.ready]);
  const { device, context, format } = await initializeWebGPU(canvas);
  context.configure({ device, format, alphaMode: 'opaque' });

  const mesh = gridMesh();
  const uvBuf = createBufferWithData(device, 'uv', mesh.uvs, GPUBufferUsage.VERTEX);
  const triBuf = createBufferWithData(device, 'tris', mesh.tris, GPUBufferUsage.INDEX);
  const lineBuf = createBufferWithData(device, 'lines', mesh.lines, GPUBufferUsage.INDEX);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const fan = createBufferWithData(device, 'fan', fanCards(), GPUBufferUsage.VERTEX);

  const module = device.createShaderModule({ code: shaderCode });
  // Everything but solid text binds the photos too.
  const boxLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });
  const textLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const alpha: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };

  const pipeline = (
    topology: GPUPrimitiveTopology,
    vsEntry: string,
    fsEntry: string,
    stride: number,
    layout: GPUBindGroupLayout,
    blend?: GPUBlendState,
  ) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module,
        entryPoint: vsEntry,
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: stride * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              ...(stride === TEXT_STRIDE
                ? [
                    { shaderLocation: 3, offset: 32, format: 'float32x4' as const },
                    { shaderLocation: 4, offset: 48, format: 'float32' as const },
                  ]
                : []),
            ],
          },
          // Slot 2, one float per instance: per-glyph reveal progress for
          // text, photo layer (-1 = none) for boxes.
          {
            arrayStride: 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: stride === TEXT_STRIDE ? 5 : 6, offset: 0, format: 'float32' }],
          },
        ],
      },
      fragment: { module, entryPoint: fsEntry, targets: [{ format, blend }] },
      primitive: { topology },
      multisample: { count: SAMPLES },
      // Text is translucent: test against depth but don't write it.
      depthStencil: { format: 'depth24plus', depthWriteEnabled: !blend, depthCompare: 'less-equal' },
    });
  const photos = await loadPhotos(device);
  const slideUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const photoEntries: GPUBindGroupEntry[] = [
    { binding: 2, resource: sampler },
    { binding: 3, resource: photos.texture.createView({ dimension: '2d-array' }) },
    { binding: 4, resource: { buffer: slideUniform } },
    { binding: 5, resource: { buffer: photos.aspects } },
  ];

  const pipelines = {
    image: pipeline('triangle-list', 'vs_image', 'fs_image', STRIDE, boxLayout),
    boxSolid: pipeline('triangle-list', 'vs', 'fs_solid', STRIDE, boxLayout),
    boxWire: pipeline('line-list', 'vs', 'fs_wire', STRIDE, boxLayout),
    textSolid: pipeline('triangle-list', 'vs_text', 'fs_text', TEXT_STRIDE, textLayout, alpha),
    textWire: pipeline('line-list', 'vs_text', 'fs_wire', TEXT_STRIDE, boxLayout),
  };

  const compositeModule = device.createShaderModule({ code: compositeCode });
  const composite = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: compositeModule, entryPoint: 'vs' },
    fragment: { module: compositeModule, entryPoint: 'fs', targets: [{ format }] },
  });
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
    const uniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
  const fanPhotos = createBufferWithData(device, 'fan-photos', Float32Array.from({ length: FAN_CARDS }, (_, i) => i % PHOTOS.length), GPUBufferUsage.VERTEX);

  // Yields after each route so the first compile can be spread across tasks.
  const compileScenes = function* () {
    for (const r of owned) r.destroy();
    owned = [];
    draws = [];

    let photo = 0;
    for (const [scene, { root }] of routes.entries()) {
      if (scene === ABOUT) boxDraws(scene, fan, FAN_CARDS, 1, fanPhotos);
      const boxes = new Float32Array(compile(root, '[data-gl]', 'background-color'));
      if (boxes.length) {
        // Leaf panes get the next photo; containers (e.g. the grid) keep their colour.
        const layers = [...root.querySelectorAll('[data-gl]')].map((el) =>
          el.querySelector('[data-gl]') ? -1 : photo++ % PHOTOS.length,
        );
        boxDraws(scene, vertexBuffer('boxes', boxes), boxes.length / STRIDE, 0, vertexBuffer('photos', Float32Array.from(layers)));
      }
      const imgs = new Float32Array(compile(root, '[data-gl-image]', 'background-color'));
      if (imgs.length)
        addDraw(
          { pipeline: pipelines.image, index: triBuf, n: mesh.tris.length, wire: 0, ring: 0, scene, slot2: noPhotos(imgs.length / STRIDE) }, // no cursor bulge on the work slideshow
          vertexBuffer('images', imgs),
          imgs.length / STRIDE,
        );

      yield;
      const atlas = atlases[scene];
      const textEls = [...root.querySelectorAll('[data-gl-text]')];
      const text = layoutText(textEls, new Float32Array(compile(root, '[data-gl-text]', 'color')), atlas);
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
        addDraw({ pipeline: pipelines.textSolid, index: triBuf, n: mesh.tris.length, wire: 0, ring: 0, scene, slot2: buffer }, inst, glyphCount, [
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: sampler },
        ]);
        addDraw({ pipeline: pipelines.textWire, index: lineBuf, n: mesh.lines.length, wire: 1, ring: 0, scene, slot2: buffer }, inst, glyphCount);
      }

      // Frames: wire-only outlines around text wrappers and text blocks.
      const frames = new Float32Array(compile(root, '[data-gl-frame], [data-gl-text]:not([data-slide])', 'color'));
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
  // Split-text triggers: a text block reveals the first time it is in view
  // during a route visit (scrolled to, or its route entered).
  const inView = new Set<Element>();
  const sceneOf = (el: Element) => routes.findIndex((r) => r.root.contains(el));
  const played = new WeakSet<Element>(); // once per route visit; scrolling doesn't replay
  // Work slides: `cur` shows, `next` rises over it while `k` runs 0 -> 1.
  const slide = { cur: 0, next: 0, k: 0 };
  const isHiddenSlide = (el: Element) => {
    const s = (el as HTMLElement).dataset.slide;
    return s !== undefined && Number(s) !== slide.next;
  };
  const play = (el: Element) => {
    if (played.has(el) || isHiddenSlide(el)) return;
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
  thumbs.forEach((b, i) => (b.onclick = () => goTo(i)));
  const slideText = (i: number) => routes[WORK].root.querySelectorAll(`[data-slide="${i}"]`);
  const goTo = (i: number) => {
    if (i === slide.next) return;
    // The outgoing title sinks back under its mask; the new one rises.
    for (const el of slideText(slide.next)) gsap.to(timeOf(el), { time: 0, duration: 0.5, ease: 'power2.in', overwrite: true });
    slide.cur = slide.next;
    slide.next = i;
    for (const el of slideText(i)) {
      played.delete(el);
      gsap.killTweensOf(timeOf(el));
      timeOf(el).time = 0;
      gsap.delayedCall(SLIDE_SECONDS * 0.4, () => play(el));
    }
    gsap.fromTo(slide, { k: 0 }, { k: 1, duration: REDUCED ? 0.01 : SLIDE_SECONDS, ease: 'none', overwrite: true });
    thumbs.forEach((b, j) => b.toggleAttribute('aria-current', j === i));
    counter.textContent = `${pad(i + 1)} / ${pad(SLIDES)}`;
  };

  // Work navigation: arrow keys and wheel step through slides, one per gesture.
  const step = (dir: number) => {
    if (to !== WORK || (slide.k > 0 && slide.k < 1)) return;
    goTo((slide.next + dir + SLIDES) % SLIDES);
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
  });
  addEventListener('wheel', (e) => Math.abs(e.deltaY) > 20 && step(Math.sign(e.deltaY)), { passive: true });
  thumbs[0].toggleAttribute('aria-current', true);

  const onRoute = () => {
    const next = routeIndex();
    if (next !== to) {
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
    scrollTo(0, 0);
    // Only home scrolls; work is a full-screen slideshow with its minimap.
    document.documentElement.style.overflow = next === 0 ? '' : 'hidden';
    // Only the current route's text is exposed to assistive tech (inert), and
    // each route gets its own title, description, canonical URL and chrome.
    applyMeta(next);
    // Chrome sits on the full-bleed image on work, so it flips to light.
    for (const id of ['#nav', '#view']) requiredElement(id).classList.toggle('on-dark', next === WORK);
  };
  addEventListener('popstate', onRoute);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('#nav a'))
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // new tab etc. stays native
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
      for (const d of draws) {
        if (d.scene !== scene) continue;
        if ((d.wire && mode === 'solid') || (!d.wire && mode === 'wire')) continue;
        const u = new Float32Array(28);
        u.set(viewProj);
        u.set([w, h, scrollY, spin.angle, FAN_CARDS, d.wire, d.ring, spin.vel, mouse.x, mouse.y + scrollY, mouse.hover, d.lift ?? 0], 16);
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

    device.queue.writeBuffer(slideUniform, 0, new Float32Array([SLIDE_PHOTOS[slide.cur], SLIDE_PHOTOS[slide.next], slide.k, 0]));
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
  };
  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
  message.textContent = error instanceof Error ? error.message : String(error);
  message.classList.add('visible');
});
