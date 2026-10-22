// Intro loader (#loader in foam.html): plain DOM and the Web Animations API, so
// it is on screen before the renderer (and gsap) load. The percentage is fake:
// it eases toward 90 while the renderer boots, then runs to 100 once
// `foam:ready` fires. The exit lifts three stacked panels (ink, red, paper) in
// a stagger while the page settles from a slight zoom behind them.

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_SECONDS = 1.2; // keep the counter on screen at least this long
const EASE = 'cubic-bezier(0.76, 0, 0.24, 1)';

/** Starts the loader; resolves once it has gone and dispatches `foam:intro-done`. */
export function runLoader(): Promise<void> {
  const loader = document.getElementById('loader');
  const count = document.getElementById('loader-count');
  if (!loader || !count) return Promise.resolve();

  const start = performance.now();
  let value = 0;
  let ready = false;
  addEventListener('foam:ready', () => (ready = true), { once: true });

  return new Promise((resolve) => {
    let last = start;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // Fake progress: approach 90 while loading, then sprint to 100.
      const goal = ready && now - start > MIN_SECONDS * 1000 ? 100 : 90;
      value += (goal - value) * (1 - Math.exp(-dt * (goal === 100 ? 9 : 1.6)));
      if (goal === 100 && value > 99.5) value = 100;
      count.textContent = String(Math.floor(value));
      if (value < 100) return void requestAnimationFrame(tick);
      exit(loader).then(() => {
        loader.remove();
        dispatchEvent(new Event('foam:intro-done'));
        resolve();
      });
    };
    requestAnimationFrame(tick);
  });
}

async function exit(loader: HTMLElement) {
  if (REDUCED) {
    await loader.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
    return;
  }
  const panels = [...loader.querySelectorAll<HTMLElement>('.loader-panel')].reverse(); // top panel first
  const lift = panels.map((panel, i) =>
    panel.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], {
      duration: 1000,
      delay: 250 + i * 120,
      easing: EASE,
      fill: 'forwards',
    }),
  );
  // The counter leaves first, sliding up out of its line.
  loader.querySelector('.loader-count-line')?.animate(
    [{ transform: 'translateY(0)' }, { transform: 'translateY(-110%)' }],
    { duration: 500, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' },
  );
  // The page settles from a slight zoom as the last panel clears.
  document.getElementById('webgpu-canvas')?.animate([{ transform: 'scale(1.08)' }, { transform: 'scale(1)' }], {
    duration: 1400,
    delay: 250,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  });
  await Promise.all(lift.map((a) => a.finished));
}
