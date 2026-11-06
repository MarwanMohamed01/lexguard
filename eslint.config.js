import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "**/.wrangler/",
      "**/dist/",
      "**/worker-configuration.d.ts",
      "evals/.evalite/",
    ],
  },
  js.configs.recommended,
  // Type-aware rules: catch unawaited promises, unsafe `any`, impossible conditions.
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
