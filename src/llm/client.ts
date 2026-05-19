import { config } from "../config.js";
import { logger } from "../logger.js";

interface GenerateOpts {
  format?: "json";
  temperature?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ollama serializes on the GPU, so the AbortController is started AFTER the
// semaphore slot is held — otherwise deep queues caused tail calls to time out
// before generation began.
const waiters: Array<() => void> = [];
let inFlight = 0;

async function acquire(): Promise<() => void> {
  const limit = config.llm.maxConcurrent;
  if (inFlight < limit) {
    inFlight++;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  };
}

async function once(prompt: string, opts: GenerateOpts): Promise<string> {
  const release = await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(`${config.llm.ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.llm.model,
        prompt,
        stream: false,
        format: opts.format,
        options: { temperature: opts.temperature ?? 0.2 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { response?: string };
    if (typeof data.response !== "string") {
      throw new Error("Ollama returned no 'response' field");
    }
    return data.response;
  } finally {
    clearTimeout(timer);
    release();
  }
}

export async function generate(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.llm.maxRetries; attempt++) {
    try {
      return await once(prompt, opts);
    } catch (err) {
      lastErr = err;
      logger.warn({ attempt, err: String(err) }, "ollama generate failed");
      if (attempt < config.llm.maxRetries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
