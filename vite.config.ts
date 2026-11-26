import { defineConfig } from "vite";

/**
 * One build produces both targets inside `dist/`:
 *
 *   dist/index.html      → hosted web demo (judges can try it without installing anything)
 *   dist/popup.html      → Chrome extension popup *and* side panel (manifest points at it)
 *   dist/background.js   → MV3 service worker (fixed file name, referenced by the manifest)
 *   dist/assets/*        → hashed JS/CSS chunks (shared by all entry points)
 *   dist/manifest.json   → copied verbatim from `public/`
 *
 * `base: "./"` keeps every emitted URL relative so the same HTML files work from
 * a normal web origin *and* from `chrome-extension://<id>/`.
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        demo: "index.html",
        popup: "popup.html",
        background: "src/extension/background.ts"
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  },
  server: {
    port: 5173
  }
});
