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

// config/profiles/* is gitignored, per-machine content (a profile's own resume,
// deal-breakers and gate prompt). ESLint's flat config does not read .gitignore, so
// without this the repo's own rules - filename-case in particular - fail the
// non-negotiable `npm run lint` check on files that are not in the repo at all.
const IGNORES = ["dist/**", "node_modules/**", "data/**", ".claude/**", "temp/**", "config/profiles/**"];

export default tseslint.config(
  {
    files: ["**/*.ts"],
    ignores: IGNORES,
    languageOptions,
    plugins,
    // Inline eslint directives are inert (and each one is a warning, which --max-warnings 0
    // turns into a failure); change the rule here instead.
    linterOptions: { noInlineConfig: true },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      // Type-only imports must be their own `import type { ... }` statement, never
      // inline `{ type X }` mixed with value imports (matches core-ui). The
      // no-restricted-syntax selector below covers the mixed-import case that
      // consistent-type-imports does not flag on its own.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      // Standard rule 3 (no hand-written unknown), enforced mechanically. Caught values
      // use the Caught alias in util/errorCause.ts; JSON boundaries use JsonValue.
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
      // camelCase filenames. `ignore` also covers ancestor directory names, which the
      // rule checks too — `__tests__` is required by local/tests-in-tests-folder below,
      // so it must be exempt or the two rules contradict each other.
      "unicorn/filename-case": [
        "error",
        { case: "camelCase", ignore: [/^__tests__$/u, /^__mocks__$/u] },
      ],
      "local/tests-in-tests-folder": "error",
      "no-restricted-syntax": [
        "error",
        {
          // consistent-type-imports does not flag `{ type X }` mixed with value/default
          // imports (see TS-ESLint implementation), so ban that shape explicitly.
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
