import { defineConfig } from 'vite';

const proxy = {
  '/api': {
    target: 'http://127.0.0.1:5000',
    changeOrigin: true,
  },
  '/uploads': {
    target: 'http://127.0.0.1:5000',
    changeOrigin: true,
  },
};

export default defineConfig({
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
});
