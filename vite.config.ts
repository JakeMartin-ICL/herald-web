import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
      },
      manifest: {
        name: 'Herald',
        short_name: 'Herald',
        description: 'Board game turn order manager',
        theme_color: '#16213e',
        background_color: '#0a0a1a',
        display: 'standalone',
        icons: [
          { src: '/icons/icon.png',   sizes: '192x192', type: 'image/png' },
          { src: '/icons/splash.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
