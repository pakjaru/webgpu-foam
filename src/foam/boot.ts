// Entry (foam.html): route state that must be right before any WebGPU code
// loads (title, meta, inert routes, work chrome). The renderer is fetched
// after first paint.
import { applyMeta, routeIndex } from './router/routes';

applyMeta(routeIndex());
// Fetch the renderer only after the page has loaded and first painted, so the
// chrome (nav, thumbnails) is on screen before the GPU work starts.
const loaded = new Promise((r) => (document.readyState === 'complete' ? r(0) : addEventListener('load', r, { once: true })));
const painted = new Promise((r) => new PerformanceObserver((_, o) => (o.disconnect(), r(0))).observe({ type: 'paint', buffered: true }));
Promise.all([loaded, painted]).then(() => setTimeout(() => import('./main')));
