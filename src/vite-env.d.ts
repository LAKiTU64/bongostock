/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MARKET_POC?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<object, object, any>
  export default component
}
