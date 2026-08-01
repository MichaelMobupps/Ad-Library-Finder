import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { normalizeBase } from './src/config';

/**
 * Where this SPA is served from, as a build-time constant stamped into every
 * asset URL in dist/index.html and exposed to the app as import.meta.env.BASE_URL.
 *
 * Unset (or "/") this is "/" — Vite's own default — so the build output is
 * byte-for-byte what it has always been. Set to "/leadfinder" it becomes
 * "/leadfinder/", and src/config.ts's apiPath() moves every fetch, sign-in link
 * and download href with it.
 *
 * Validation runs through the SAME normalizeBase the app itself uses, so a
 * hostile or malformed BASE_PATH throws HERE and fails the build, rather than
 * being stamped into the asset URLs of a dist nobody re-reads afterwards. Vite
 * surfaces the throw as a config-load error and exits non-zero.
 */
const prefix = normalizeBase(process.env.BASE_PATH);
const base = prefix === '' ? '/' : `${prefix}/`;

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
