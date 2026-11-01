import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      // 官方 SDK 样例用 @framework/* 引入 Framework 源码
      '@framework': fileURLToPath(new URL('./src/fw', import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'DSH_L2D',
      formats: ['iife'],
      fileName: () => 'renderer.js',
    },
    // 直接输出到插件 assets，插件按静态资源对外提供
    outDir: '../dsh-l2d-plugin/assets',
    emptyOutDir: false,
    minify: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        // 单文件，避免插件还要处理 chunk 拆分
        inlineDynamicImports: true,
      },
    },
  },
});
