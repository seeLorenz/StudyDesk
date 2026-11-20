import { defineConfig } from "vite";

// The nightly run's program (src/routine/cli.ts) as one file with no
// dependencies, for Node in a Claude Code cloud session. Published next to the
// page as routine.mjs, so the session runs the same code as the page.
export default defineConfig({
  build: {
    ssr: "src/routine/cli.ts",
    outDir: "artifact",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: { output: { format: "es", entryFileNames: "routine.mjs", inlineDynamicImports: true } },
  },
  ssr: { noExternal: true, target: "node" },
});
