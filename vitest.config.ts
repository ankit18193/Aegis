import { resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    environmentMatchGlobs: [
      ["apps/console/**", "jsdom"],
      ["packages/**", "node"],
    ],
    setupFiles: ["./apps/console/src/test/setup.ts"],
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/**/src/**/*.ts", "apps/**/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/index.ts"],
    },
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "@aegis/foundation": resolve(__dirname, "packages/foundation/src"),
      "@aegis/types": resolve(__dirname, "packages/types/src"),
      "@aegis/contracts": resolve(__dirname, "packages/contracts/src"),
      "@aegis/config": resolve(__dirname, "packages/config/src"),
      "@aegis/logger": resolve(__dirname, "packages/logger/src"),
    },
  },
});
