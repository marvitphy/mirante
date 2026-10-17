/// <reference types="vite/client" />

/**
 * The AudioWorklet global scope, which `lib.dom` does not describe.
 *
 * Only what `rnnoise-worklet.ts` touches. These exist inside the worklet's
 * own realm, not on `window`, which is why TypeScript cannot see them from
 * a file that otherwise looks like ordinary renderer code.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}

declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor
): void

declare module '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' {
  /** Emscripten module factory, synchronous because the wasm is inlined. */
  const createRNNWasmModuleSync: () => unknown
  export default createRNNWasmModuleSync
}
