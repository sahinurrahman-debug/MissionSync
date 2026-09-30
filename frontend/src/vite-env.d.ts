/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the MissionSync backend. Empty ⇒ same origin (dev proxy) or the demo engine. */
  readonly VITE_API_URL?: string
  readonly VITE_APP_ENV?: string
  /** Tile URL template (default: OpenStreetMap — fine for demos, use a provider for real traffic). */
  readonly VITE_TILE_URL?: string
  readonly VITE_TILE_ATTRIBUTION?: string
}
