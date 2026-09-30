import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// In dev the backend runs on :8000; proxying /api and /ws keeps the browser on one
// origin (no CORS, no URL config). In production set VITE_API_URL to the backend.
const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the heavy vendors so the app shell loads and caches independently of them.
        manualChunks: {
          react: ['react', 'react-dom'],
          map: ['leaflet', 'react-leaflet'],
          motion: ['framer-motion'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
