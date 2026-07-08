import pino from "pino";
import pretty from "pino-pretty";

// pino-pretty runs as a SYNCHRONOUS in-process stream, not the usual
// worker-thread transport: the bot ends every run with process.exit(0), which
// kills a transport worker before it drains and silently drops the final log
// lines (the end-of-run outreach/verify stage). sync:true trades a little
// throughput for never losing the tail. (src/logger.test.ts guards this.)
export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  process.env.NODE_ENV === "production"
    ? undefined
    : pretty({ translateTime: "HH:MM:ss.l", ignore: "pid,hostname", sync: true }),
);
