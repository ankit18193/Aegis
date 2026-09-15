import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/index.ts"],
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
