import { defineConfig } from 'vite';

export default defineConfig({
  base: '/herald-web/',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
