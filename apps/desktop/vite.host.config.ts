import { resolve } from "node:path";
import { defineConfig } from "vite";

const kernel = resolve(__dirname, "../../src");

/**
 * Standalone host bundle. electron-vite only owns main, preload, and renderer;
 * the utility process must be one file with its dependencies inlined so the
 * packaged app does not look up the source tree or a global install.
 */
export default defineConfig({
  resolve: {
    alias: { "@chivgent": kernel },
  },
  build: {
    ssr: resolve("src/host/index.ts"),
    outDir: "out/host",
    emptyOutDir: true,
    sourcemap: true,
  },
  ssr: {
    noExternal: true,
    external: ["electron"],
  },
});
