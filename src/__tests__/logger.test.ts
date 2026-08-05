import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// The bot ends its run with process.exit(0). A worker-thread log transport
// (pino-pretty's default mode) buffers writes in the main thread and loses
// whatever the worker hasn't consumed when the process dies — which is exactly
// the end-of-run outreach/verify log lines. The logger must therefore write
// synchronously: a line logged immediately before process.exit must still
// reach stdout.
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
