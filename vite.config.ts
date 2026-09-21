import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 开发态：Vite 提供前端并热更新，/api 反向代理到本地 Node 服务。
// 生产态：`pnpm build` 产出 web/dist，由 Node 服务同源托管。
export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'web/src'),
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'web/dist'),
    emptyOutDir: true,
  },
});
