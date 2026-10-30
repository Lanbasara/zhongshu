import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/public', emptyOutDir: false, sourcemap: false },
  server: { host: '127.0.0.1', port: 3000, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
});
