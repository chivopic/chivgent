import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@chivgent": resolve(__dirname, "../../src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  server: {
    fs: {
      allow: [resolve(__dirname), resolve(__dirname, "../..")],
    },
  },
});
