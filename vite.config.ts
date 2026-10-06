import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file: open dist/index.html straight from disk.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true },
});
