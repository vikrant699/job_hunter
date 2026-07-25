// @ts-check
import tseslint from "typescript-eslint";

const languageOptions = {
  parser: tseslint.parser,
  parserOptions: {
    projectService: true,
    tsconfigRootDir: import.meta.dirname,
  },
};

const plugins = {
  "@typescript-eslint": tseslint.plugin,
};

export default tseslint.config(
  {
    files: ["**/*.ts"],
    ignores: ["dist/**", "node_modules/**", "data/**", ".claude/**"],
    languageOptions,
    plugins,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-restricted-syntax": [
        "error",
        {
          // Ban `x as T` except `x as const`
          selector:
            "TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])",
          message:
            "Type assertions are banned (Standard rule 1). Validate with zod instead. Only `as const` is allowed.",
        },
        {
          // Ban angle-bracket assertions: <T>x
          selector: "TSTypeAssertion",
          message:
            "Type assertions are banned (Standard rule 1). Validate with zod instead. Only `as const` is allowed.",
        },
      ],
    },
  },
  {
    // Async-correctness rules for production code. Test files are exempt from
    // no-floating-promises only because node:test's top-level `test()` calls
    // return promises the runner itself tracks.
    files: ["**/*.ts"],
    ignores: ["dist/**", "node_modules/**", "data/**", ".claude/**", "**/*.test.ts"],
    languageOptions,
    plugins,
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Non-null assertions banned in production code only. Test files carry
    // 236 pre-existing `!` sites (mostly asserting on known-shape fixture
    // JSON/regex results) that are out of scope for this pass; revisit if
    // that debt is ever paid down.
    files: ["**/*.ts"],
    ignores: ["dist/**", "node_modules/**", "data/**", ".claude/**", "**/*.test.ts"],
    languageOptions,
    plugins,
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // Unnecessary-condition checks enforced in production code only. Test
    // files carry 111 pre-existing sites (mostly `?.` chains on fixture
    // objects whose types are wider than the literal test data) that are out
    // of scope for this pass; revisit if that debt is ever paid down.
    files: ["**/*.ts"],
    ignores: ["dist/**", "node_modules/**", "data/**", ".claude/**", "**/*.test.ts"],
    languageOptions,
    plugins,
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
);
