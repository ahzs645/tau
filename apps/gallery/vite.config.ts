import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tauRuntime } from '@taucad/runtime/vite';
import { defineConfig } from 'vite';
import { galleryStaticPages } from '#static-pages.vite-plugin.js';
import { galleryWorkerBuilds } from '#worker-builds.vite-plugin.js';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/gallery',
  plugins: [
    tauRuntime({ crossOriginIsolation: false }),
    react(),
    tailwindcss(),
    galleryWorkerBuilds(),
    galleryStaticPages(),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    assetsInlineLimit: 0,
    // Skip unused re-exports in side-effect-free icon and component libraries.
    rolldownOptions: { experimental: { lazyBarrel: true } },
  },
  worker: { rolldownOptions: { experimental: { lazyBarrel: true } } },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
