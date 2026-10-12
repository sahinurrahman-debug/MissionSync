/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional build tag. */
  readonly VITE_APP_ENV?: string
  /** Tile URL template (default: OpenStreetMap — fine for demos, use a provider for real traffic). */
  readonly VITE_TILE_URL?: string
  readonly VITE_TILE_ATTRIBUTION?: string
}
