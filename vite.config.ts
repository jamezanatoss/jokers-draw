import { defineConfig } from 'vitest/config';

/** Where `wrangler dev` serves the room server (see server/wrangler.jsonc). */
const WORKER = 'http://127.0.0.1:8787';

export default defineConfig({
  base: './',
  server: {
    // Online rooms: the browser talks to the same origin; Vite forwards the WebSockets.
    proxy: {
      '/parties': { target: WORKER, ws: true, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/parties': { target: WORKER, ws: true, changeOrigin: true },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
