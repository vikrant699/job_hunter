// @ts-check
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

import local from "./eslint-local-plugin.js";

const languageOptions = {
  parser: tseslint.parser,
  parserOptions: {
    projectService: true,
    tsconfigRootDir: import.meta.dirname,
  },
};

const plugins = {
  "@typescript-eslint": tseslint.plugin,
  unicorn,
  local,
};

// ESLint flat config ignores .gitignore; per-machine config/profiles/* would otherwise fail lint (e.g. filename-case).
const IGNORES = ["dist/**", "node_modules/**", "data/**", ".claude/**", "temp/**", "config/profiles/**"];

export default tseslint.config(
  // Global ignore (an object with only `ignores`): per-block ignores still let `eslint .` parse scratch .js under temp/.
  { ignores: IGNORES },
  {
    files: ["**/*.ts"],
    ignores: IGNORES,
    languageOptions,
    plugins,
    // Inline eslint directives are inert and warn (--max-warnings 0 fails); change the rule here.
    linterOptions: { noInlineConfig: true },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-restricted-types": [
        "error",
        {
          types: {
            unknown: {
              message:
                "Standard rule 3: no hand-written unknown. Validate with zod and use z.infer, narrow with typeof/Array.isArray/in, or use JsonValue from util/json.ts. A value that came out of catch is Caught (util/errorCause.ts).",
            },
          },
        },
      ],
      // `ignore` covers ancestor dirs too; `__tests__` must be exempt or this contradicts local/tests-in-tests-folder.
      "unicorn/filename-case": [
        "error",
        { case: "camelCase", ignore: [/^__tests__$/u, /^__mocks__$/u] },
      ],
      "local/tests-in-tests-folder": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: 'ImportDeclaration[importKind="value"] ImportSpecifier[importKind="type"]',
          message:
            'Do not use inline `type` imports alongside value imports. Use a separate `import type { ... } from "..."` statement.',
        },
        {
          selector: "TSEnumDeclaration",
          message:
            "Avoid TypeScript enums; use a const object with `as const` and derive the type from it.",
        },
        {
          selector:
            "TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])",
          message:
            "Type assertions are banned (Standard rule 1). Validate with zod instead. Only `as const` is allowed.",
        },
        {
          selector: "TSTypeAssertion",
          message:
            "Type assertions are banned (Standard rule 1). Validate with zod instead. Only `as const` is allowed.",
        },
      ],
    },
  },
  {
    // Test files are exempt from no-floating-promises: node:test's top-level test() returns promises the runner tracks.
    files: ["**/*.ts"],
    ignores: [...IGNORES, "**/*.test.ts"],
    languageOptions,
    plugins,
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
);
