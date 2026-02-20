import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'SqlChatbot',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    outDir: 'dist',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        banner: 'if(typeof globalThis.process==="undefined"){globalThis.process={env:{},emit:function(){}};}',
      },
    },
  },
})
