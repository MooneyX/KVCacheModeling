import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    proxy: { '/api': { target: process.env.SIM_API_URL || 'http://127.0.0.1:8787' } },
    watch: { ignored: ['**/.runtime/**'] },
  },
});
