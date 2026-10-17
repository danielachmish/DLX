import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// השרת מאחורי /v1 — בפיתוח עובר דרך proxy, כך שאין CORS והקישור הציבורי /d/:token עובד
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/v1': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
  preview: { port: 4173, proxy: { '/v1': 'http://localhost:8787' } },
  build: { target: 'es2022', sourcemap: true },
});
