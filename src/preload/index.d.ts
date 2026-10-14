import type { ElectronAPI } from '@electron-toolkit/preload'
import type { MiranteApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    mirante: MiranteApi
  }
}

export {}
