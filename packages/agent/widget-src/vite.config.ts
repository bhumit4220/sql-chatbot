import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'index.ts',
      name: 'SqlChatbot',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    outDir: '../widget',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        banner: 'if(typeof globalThis.process==="undefined"){globalThis.process={env:{},emit:function(){}};}',
      },
    },
  },
})
