import { defineConfig, type Connect, type Plugin } from 'vite';

// Foam uses History API routes; a direct load or refresh of any of them serves foam.html.
const ROUTES = new Set(['/', '/about', '/work']);

const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
  const [path, query] = (req.url ?? '/').split('?');
  if (ROUTES.has(path.replace(/\/$/, '') || '/')) req.url = `/foam.html${query ? `?${query}` : ''}`;
  next();
};

const foamRoutes: Plugin = {
  name: 'foam-routes',
  configureServer: (server) => void server.middlewares.use(rewrite),
  configurePreviewServer: (server) => {
    server.middlewares.use(rewrite);
    // Hashed bundles are immutable; everything else revalidates.
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (req.url?.startsWith('/images/')) res.setHeader('Cache-Control', 'public, max-age=604800');
      next();
    });
  },
};

export default defineConfig({
  plugins: [foamRoutes],
  // WebGPU browsers all support modulepreload; skip the polyfill chunk.
  build: { modulePreload: { polyfill: false }, rollupOptions: { input: { index: 'index.html', foam: 'foam.html' } } },
});
