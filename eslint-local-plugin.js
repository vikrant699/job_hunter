// @ts-check
import path from "node:path";

const isTestFile = (base) => /\.(test|spec)\.ts$/u.test(base);

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
