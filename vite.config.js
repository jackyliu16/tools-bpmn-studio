import { defineConfig } from 'vite';

// base: './' so the built dist works from any static server and from
// Electron's file:// protocol (desktop packaging).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 4096
  },
  server: {
    port: 5173,
    strictPort: false,
    open: false
  },
  watch: {
    ignored: ['**/.wineprefix/**', '**/release/**']
  }
});