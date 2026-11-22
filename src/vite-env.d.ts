/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the online room server lives, e.g. https://jokers-draw.example.workers.dev.
   * Optional: by default the page talks to its own origin (the deployed Worker serves both the
   * game and the rooms; in dev, Vite forwards /parties to wrangler dev).
   */
  readonly VITE_PARTY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
