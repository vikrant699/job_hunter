// @ts-check
/**
 * Repo-local ESLint rules. Ported from the core-ui plugin of the same name,
 * trimmed to what applies here: job_hunter is a Node/TS backend with no JSX, so
 * the TSX-filename and hooks-folder rules are omitted.
 */
import path from "node:path";

const isTestFile = (base) => /\.(test|spec)\.ts$/u.test(base);

/**
 * Test files (`*.test.ts` / `*.spec.ts`) must live in a `__tests__/` folder.
 * Codifies the layout established when tests moved into parallel `__tests__`
 * directories — this rule is what keeps them there.
 */
const testsInTestsFolder = {
  meta: {
    type: "suggestion",
    docs: { description: "Test files must live in a __tests__/ folder." },
    schema: [],
    messages: {
      testOutsideTestsFolder: 'Test file "{{name}}" must live in a `__tests__/` folder.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || filename === "<input>" || filename === "<text>") return {};
    const base = path.basename(filename);
    if (!isTestFile(base)) return {};
    const parts = filename.split(/[\\/]/u);
    if (parts.includes("__tests__")) return {};
    return {
      Program(node) {
        context.report({ node, messageId: "testOutsideTestsFolder", data: { name: base } });
      },
    };
  },
};

export default {
  meta: { name: "local", version: "1.0.0" },
  rules: {
    "tests-in-tests-folder": testsInTestsFolder,
  },
};
