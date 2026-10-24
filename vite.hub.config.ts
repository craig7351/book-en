import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 學習中心（本地視窗）：單字庫、複習、統計
export default defineConfig({
  plugins: [react()],
  root: 'src/hub',
  base: './',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
})
