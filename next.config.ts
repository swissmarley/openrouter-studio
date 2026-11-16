import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Native / WASM / ESM-only packages that must be loaded by Node itself, not bundled.
  serverExternalPackages: ["better-sqlite3", "quickjs-emscripten", "@openrouter/agent", "@openrouter/sdk"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
