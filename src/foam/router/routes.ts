// Routes are the `<main data-route>` elements in foam.html, in document order
// (0 home, 1 about, 2 work); each is its own WebGPU scene.
const SITE_ORIGIN = import.meta.env.VITE_SITE_ORIGIN;
const routes = [...document.querySelectorAll<HTMLElement>('[data-route]')];
const META: Record<string, { title: string; description: string; image: string }> = {
  '/': {
    title: 'Foam: a native WebGPU renderer',
    description: 'A live demonstration of a native WebGPU renderer: Rust compiles the DOM into GPU buffers, pretext lays out the text, and every pane and glyph is drawn on the GPU.',
    image: '02',
  },
  '/about': {
    title: 'About · Foam WebGPU renderer',
    description: 'How Foam works: Rust compiles the DOM into instance buffers, and WebGPU draws each route to its own texture and reveals one through the other.',
    image: '00',
  },
  '/work': {
    title: 'Work · Foam WebGPU renderer',
    description: 'A full-screen WebGPU slideshow of photography, installation, print and film work, with split-text titles drawn glyph by glyph on the GPU.',
    image: '06',
  },
};

/** Index of the route matching the current URL path (unknown paths fall back to home). */
export const routeIndex = () =>
  Math.max(0, routes.findIndex((r) => r.dataset.route === (location.pathname.replace(/\/$/, '') || '/')));

const setAttr = (sel: string, name: string, value: string) => document.querySelector(sel)?.setAttribute(name, value);

/** Title, description, canonical and Open Graph tags for route `i`; works with or without WebGPU. */
export const applyMeta = (i: number) => {
  const path = routes[i].dataset.route!;
  const { title, description, image } = META[path];
  const url = SITE_ORIGIN + path;
  document.title = title;
  setAttr('meta[name="description"]', 'content', description);
  setAttr('meta[property="og:title"]', 'content', title);
  setAttr('meta[property="og:description"]', 'content', description);
  setAttr('meta[property="og:url"]', 'content', url);
  setAttr('meta[property="og:image"]', 'content', `${SITE_ORIGIN}/images/${image}.webp`);
  setAttr('link[rel="canonical"]', 'href', url);
  routes.forEach((r, j) => (r.inert = j !== i));
  document.querySelector<HTMLElement>('#work-ui')!.hidden = path !== '/work';
  for (const a of document.querySelectorAll<HTMLAnchorElement>('#nav a')) a.toggleAttribute('aria-current', a.pathname === path);
};
