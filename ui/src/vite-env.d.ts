/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_PLATFORM?: string;
  readonly VITE_DISABLE_LOCAL_AUTH?: string;
  readonly VITE_PILOTDECK_DESKTOP_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
