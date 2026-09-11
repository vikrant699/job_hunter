import pino from "pino";
import pretty from "pino-pretty";

type LogSink = (line: string) => void;
let sink: LogSink | null = null;

// sync:true (not the usual worker-thread transport): process.exit(0) at the end of a run would otherwise kill the transport before it drains, silently dropping the final log lines. Guarded by src/__tests__/logger.test.ts.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    // Test seam: pino hands every serialized line here synchronously before the destination writes it; the line itself is never altered.
    hooks: { streamWrite: (line) => { sink?.(line); return line; } },
  },
  process.env.NODE_ENV === "production"
    ? undefined
    : pretty({ translateTime: "HH:MM:ss.l", ignore: "pid,hostname", sync: true }),
);

/** Routes a copy of every log line to `fn` (tests only); null detaches. */
export function setLogSink(fn: LogSink | null): void {
  sink = fn;
}
