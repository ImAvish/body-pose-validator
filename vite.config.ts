import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';

const certPath = './localhost+1.pem';
const keyPath = './localhost+1-key.pem';
const hasLocalHttpsCert = fs.existsSync(certPath) && fs.existsSync(keyPath);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    ...(hasLocalHttpsCert
      ? {
          https: {
            cert: fs.readFileSync(certPath),
            key: fs.readFileSync(keyPath),
          },
        }
      : {}),
    headers: {
      // Required for SharedArrayBuffer used by WASM/MediaPipe.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
});
