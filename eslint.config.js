import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "data/", "qwen_profiles/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      // Explicit `any` is used intentionally across route bodies, DB rows,
      // Playwright page.evaluate payloads and dynamic imports. Re-typing all of
      // it is a separate incremental effort; the rule only produced warnings
      // (exit 0) and adding 251 casts would add churn without runtime value.
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  }
);
