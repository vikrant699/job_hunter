import pino from "pino";
import pretty from "pino-pretty";

// sync:true (not the usual worker-thread transport): process.exit(0) at the end of a run would otherwise kill the
// transport before it drains, silently dropping the final log lines. Guarded by src/logger.test.ts.
export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  process.env.NODE_ENV === "production"
    ? undefined
    : pretty({ translateTime: "HH:MM:ss.l", ignore: "pid,hostname", sync: true }),
);
