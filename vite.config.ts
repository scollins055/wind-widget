import { defineConfig } from 'vite';

// Port 1420 is what src-tauri/tauri.conf.json points the dev window at.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
