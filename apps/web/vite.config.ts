import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiUrlWarning, PROXIED_PATH } from './config/apiUrl.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export default defineConfig(({ command, mode }) => {
  // Without VITE_API_URL the web app calls /api on its own origin; the dev and preview servers
  // forward it to the local API (port 3001, or API_PORT as set for `npm run dev`).
  const apiTarget = `http://127.0.0.1:${process.env.API_PORT || '3001'}`;
  const { VITE_API_URL } = loadEnv(mode, import.meta.dirname, 'VITE_');
  const warning = apiUrlWarning(VITE_API_URL, command === 'serve');
  if (warning) console.warn(`[web] ${warning}`);

  // Loopback by default: the /api proxy would otherwise let any host on the network start paid
  // analyses through the API, which itself listens on loopback only. WEB_HOST=0.0.0.0 opts in
  // (e.g. to try the app from a phone). `vite preview` uses the same host and proxy.
  const host = process.env.WEB_HOST || 'localhost';
  if (command === 'serve' && !LOOPBACK_HOSTS.has(host)) {
    console.warn(
      `[web] WEB_HOST=${host}: the app and its ${PROXIED_PATH} proxy to the API are reachable from the network`,
    );
  }

  return {
    server: {
      port: 3000,
      host,
      proxy: {
        [PROXIED_PATH]: { target: apiTarget },
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
      },
    },
  };
});
