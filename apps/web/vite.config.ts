import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Without VITE_API_URL the web app calls /api on its own origin; the dev and preview servers
// forward it to the local API (port 3001, or API_PORT as set for `npm run dev`).
const apiTarget = `http://127.0.0.1:${process.env.API_PORT || '3001'}`;

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
