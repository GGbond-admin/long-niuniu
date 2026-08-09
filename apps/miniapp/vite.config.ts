import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

/**
 * Telegram 安卓端嵌入的是系统 WebView，低版本机型常停留在 Chrome 64–80。
 * 默认 Vite 只产出现代 ES module，旧 WebView 解析失败会白屏/反复加载。
 * renderModernChunks:false 只产出兼容包，避免 nomodule 双轨在部分 WebView 上踩坑。
 */
export default defineConfig({
  plugins: [
    react(),
    legacy({
      targets: ['Android >= 7', 'Chrome >= 64', 'iOS >= 12', 'Safari >= 12'],
      modernPolyfills: true,
      renderModernChunks: false,
      additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
    }),
  ],
  build: {
    cssTarget: 'chrome64',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
