import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Where the app talks to when nothing says otherwise.
 *
 * Deliberately the deployed worker: a development build that cannot join the
 * room everyone else is in cannot be tested with anyone else.
 */
const DEFAULT_SIGNAL_URL = 'wss://mirante-signal.mirante-signal-worker.workers.dev'

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
      //
      // The fallback is the real server, not localhost. It used to be
      // localhost, which meant `npm run dev` could never reach the room your
      // friends are actually in — testing a change against other people
      // required building an installer first. Running a worker locally is
      // the rarer case, and it is the one that now sets the variable.
      __SIGNAL_URL__: JSON.stringify(
        process.env.MIRANTE_SIGNAL_URL?.trim() || DEFAULT_SIGNAL_URL
      )
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
