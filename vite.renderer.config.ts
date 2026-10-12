import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import { transformRendererCsp } from './src/renderer/csp-policy'

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  resolve: {
    // OCR already serves the verified ORT module/WASM through arkdown-ocr: in
    // both development and packaged builds. Use ORT's supported external-WASM
    // entry point so Vite does not also emit an unused 26.8 MB WASM asset.
    conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'],
  },
  build: {
    outDir: '../../.vite/renderer/main_window',
    emptyOutDir: true,
  },
  plugins: [
    react(),
    {
      name: 'arkdown-renderer-csp',
      transformIndexHtml: (html) => transformRendererCsp(html, command),
    },
  ],
}))
