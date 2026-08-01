import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * View 層のビルド設定。
 *
 * `base` を相対パスにしてあるのは、M6 で GitHub Pages
 * (`/aws-terrarium/` のようなサブパス) に置くため。
 * 絶対パスのままだとサブパス配信でアセットが 404 になる。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // three.js を含むので既定の 500KB 警告は常時鳴る。意味のある閾値に上げる。
    chunkSizeWarningLimit: 1_200,
  },
});
