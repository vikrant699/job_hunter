import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// process.exit(0) at the end of a run would lose whatever a worker-thread transport hasn't consumed yet, so the logger must write synchronously.
test("log line written immediately before process.exit(0) reaches stdout", async () => {
  const script = [
    'import { logger } from "./src/logger.js";',
    'logger.info("tail-flush-canary");',
    "process.exit(0);",
  ].join("\n");
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd() },
  );
  assert.match(stdout, /tail-flush-canary/);
});
