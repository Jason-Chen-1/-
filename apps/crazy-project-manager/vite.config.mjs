import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const checkout = fileURLToPath(new URL('./', import.meta.url));
const frontend = fileURLToPath(new URL('./frontend/', import.meta.url));
const output = fileURLToPath(new URL('./dist/client/', import.meta.url));
const backend = 'http://127.0.0.1:4173';

const routes = {
  name: 'workbench-routes',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      request.url = request.url?.replace(/^\/workbench(?=\?|$)/, '/workbench.html').replace(/^\/(?:home|index)\.html(?=\?|$)/, '/');
      next();
    });
  }
};

export default defineConfig({
  root: frontend,
  base: '/',
  publicDir: fileURLToPath(new URL('./dist/', import.meta.url)),
  plugins: [react(), routes],
  appType: 'mpa',
  server: {
    fs: { allow: [checkout] },
    proxy: {
      '/api': { target: backend, ws: true },
      '/assets/': backend,
      '^/(?:reservation(?:\\.html)?|replay\\.css|replay-player\\.js|recognition-worklet\\.js)$': backend
    }
  },
  build: {
    outDir: output,
    emptyOutDir: true,
    copyPublicDir: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        home: fileURLToPath(new URL('./frontend/index.html', import.meta.url)),
        workbench: fileURLToPath(new URL('./frontend/workbench.html', import.meta.url))
      }
    }
  }
});
