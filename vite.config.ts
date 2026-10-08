import { defineConfig } from 'vite';

// The frontend lives in web/. In development Vite serves it on :5173 and forwards
// the API and WebSocket to the game server on :8787. `npm run build` writes dist/,
// which the game server serves in production (one service, one URL).
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2020' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
