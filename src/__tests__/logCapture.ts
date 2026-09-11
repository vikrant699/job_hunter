import pino from "pino";
import { z } from "zod";
import { logger, setLogSink } from "../logger.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const LogLineSchema = z.object({ level: z.number(), msg: z.string().optional() });

/** One captured line: pino's level label, the message, and the whole parsed line for field assertions. */
export interface LogLine {
  level: string;
  message: string | undefined;
  fields: JsonValue;
}

/** Runs `fn` collecting every log line pino emits; `level` is pinned for the duration so the capture never depends on LOG_LEVEL. */
export async function captureLogs(fn: () => Promise<void>, level = "info"): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const prevLevel = logger.level;
  logger.level = level;
  setLogSink((line) => {
    const fields = JsonValueSchema.parse(JSON.parse(line));
    const head = LogLineSchema.parse(fields);
    lines.push({ level: pino.levels.labels[head.level] ?? String(head.level), message: head.msg, fields });
  });
  try {
    await fn();
  } finally {
    setLogSink(null);
    logger.level = prevLevel;
  }
  return lines;
}
