// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.ts"],
  ignores: ["dist/**", "node_modules/**", "data/**"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
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
});
