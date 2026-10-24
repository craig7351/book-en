import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 注入到 YouTube 的面板：打包成單一 IIFE 檔，由 Rust 以 initialization_script 注入
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'src-tauri/gen-overlay',
    emptyOutDir: true,
    lib: {
      entry: 'src/overlay/main.tsx',
      formats: ['iife'],
      name: 'BookEn',
      fileName: () => 'overlay.js',
    },
  },
})
