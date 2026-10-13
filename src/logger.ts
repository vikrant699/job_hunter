import pino from "pino";
import pretty from "pino-pretty";

type LogSink = (line: string) => void;
let sink: LogSink | null = null;

// sync:true: process.exit(0) would otherwise kill the worker transport before it drains. Guarded by logger.test.ts.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    hooks: { streamWrite: (line) => { sink?.(line); return line; } },
  },
  process.env.NODE_ENV === "production"
    ? undefined
    : pretty({ translateTime: "HH:MM:ss.l", ignore: "pid,hostname", sync: true }),
);

export function setLogSink(fn: LogSink | null): void {
  sink = fn;
}
