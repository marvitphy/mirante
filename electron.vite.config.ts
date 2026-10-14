import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react()],
    define: {
      // Baked at build time. A packaged app handed to friends cannot default
      // to localhost — there would be no server there to reach.
      //   MIRANTE_SIGNAL_URL=wss://seu.host npm run dist
      //
      // `||`, never `??`: an undefined GitHub Actions variable arrives as an
      // EMPTY STRING, which `??` happily passes through. That shipped a build
      // whose WebSocket URL was '', which the renderer resolved against its
      // own file:// origin and threw on before it ever reached the network.
      __SIGNAL_URL__: JSON.stringify(
        process.env.MIRANTE_SIGNAL_URL?.trim() || 'ws://localhost:8787'
      )
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
