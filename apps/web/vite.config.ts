import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4000', '/health': 'http://127.0.0.1:4000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
