import { fileURLToPath } from 'node:url';
import { productBoundary } from './scripts/design-boundaries.ts';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwind(), productBoundary(fileURLToPath(new URL('.', import.meta.url)))],
  build: { outDir: '../../dist/public', emptyOutDir: false, sourcemap: false },
  server: { host: '127.0.0.1', port: 3000, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
});
