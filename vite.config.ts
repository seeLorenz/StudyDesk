import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Everything (JS, CSS, KaTeX fonts, the PDF worker) is inlined into one HTML
// file, because a claude.ai artifact page cannot load stylesheets or fonts
// from its own files. scripts/make-artifact.mjs then strips the document
// skeleton, which the artifact host adds itself.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, cssCodeSplit: false, target: "es2022" },
  test: { environment: "jsdom" },
} as any);
