// @ts-check
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importX from "eslint-plugin-import-x";

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.d.ts",
      "eslint.config.mjs",
      "vitest.config.ts",
      ".antigravity/**",
      ".agents/**",
      ".gstack/**",
    ],
  },

  // Base JS rules
  js.configs.recommended,

  // TypeScript files
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: [
          "./packages/foundation/tsconfig.json",
          "./packages/types/tsconfig.json",
          "./packages/contracts/tsconfig.json",
          "./packages/config/tsconfig.json",
          "./packages/logger/tsconfig.json",
          "./apps/api/tsconfig.json",
          "./apps/worker/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      // Declare Node.js globals so no-undef doesn't fire for process/console/etc.
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        URL: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "import-x": importX,
    },
    rules: {
      // TypeScript strict rules
      ...tsPlugin.configs["strict-type-checked"].rules,
      ...tsPlugin.configs["stylistic-type-checked"].rules,

      // Enforce no unused vars
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Prefer explicit return types for clarity
      "@typescript-eslint/explicit-function-return-type": ["warn", { allowExpressions: true }],

      // Disallow any (use unknown instead)
      "@typescript-eslint/no-explicit-any": "error",

      // No non-null assertions (use proper narrowing)
      "@typescript-eslint/no-non-null-assertion": "error",

      // Enforce consistent type imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],

      // Import ordering
      "import-x/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // No duplicate imports
      "import-x/no-duplicates": "error",

      // Disable base no-undef in favour of TypeScript's own checks
      "no-undef": "off",
    },
  },

  // Test files (slightly relaxed rules)
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
];

export default config;
