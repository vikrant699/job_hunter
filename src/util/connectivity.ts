import { config } from "../config.js";
import { logger } from "../logger.js";

export interface ConnectivityOptions {
  /** Returns true when the network is reachable. Injected by tests. */
  probe?: () => Promise<boolean>;
  /** Gap between probes while things are healthy. */
  intervalMs?: number;
  /** Gap between probes during an outage - tighter, to resume promptly. */
  downIntervalMs?: number;
  now?: () => number;
}

interface Monitor {
  probe: () => Promise<boolean>;
  intervalMs: number;
  downIntervalMs: number;
  now: () => number;
  down: boolean;
  downSince: number | null;
  failedProbes: number;
  waiters: Array<() => void>;
  timer: NodeJS.Timeout | null;
  probing: boolean;
  stopped: boolean;
}

/** null until a run starts one, so other entry points (health check, blast tool, tests) keep their existing behaviour and never park in a context that didn't opt in. */
let monitor: Monitor | null = null;

/** Neutral, tiny, and built for exactly this: 204 with an empty body. */
async function defaultProbe(): Promise<boolean> {
  try {
    const res = await fetch(config.network.probeUrl, {
      signal: AbortSignal.timeout(config.network.probeTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function wakeWaiters(m: Monitor): void {
  const waiting = m.waiters.splice(0, m.waiters.length);
  for (const resolve of waiting) resolve();
}

/** Read via a call, not `m.stopped` directly: it can flip while a probe is awaited, and without re-checking, a monitor stopped mid-probe would reschedule itself and outlive the run. */
function isStopped(m: Monitor): boolean {
  return m.stopped;
}

function schedule(m: Monitor): void {
  if (isStopped(m)) return;
  m.timer = setTimeout(() => {
    void runProbe(m);
  }, m.down ? m.downIntervalMs : m.intervalMs);
  // Never hold the process open on the monitor's account.
  m.timer.unref();
}

async function runProbe(m: Monitor): Promise<void> {
  if (isStopped(m) || m.probing) return;
  m.probing = true;
  try {
    const ok = await m.probe();
    if (isStopped(m)) return;
    if (ok) {
      markUp(m);
    } else {
      markDown(m);
    }
  } finally {
    m.probing = false;
    if (!isStopped(m)) schedule(m);
  }
}

function markDown(m: Monitor): void {
  m.failedProbes++;
  if (!m.down) {
    m.down = true;
    m.downSince = m.now();
    logger.warn(
      { probeUrl: config.network.probeUrl },
      "network is DOWN — pausing every fetch until it comes back (nothing is skipped; work resumes where it left off)",
    );
    return;
  }
  // Waiting is unbounded by design, so this has to be loud enough that a parked run doesn't look identical to a slow one.
  const downMs = m.downSince === null ? 0 : m.now() - m.downSince;
  if (m.failedProbes % 6 === 0) {
    logger.warn(
      { downForMinutes: Math.round(downMs / 60_000), failedProbes: m.failedProbes },
      "network still down — still waiting",
    );
  }
}

function markUp(m: Monitor): void {
  m.failedProbes = 0;
  if (!m.down) return;
  const downMs = m.downSince === null ? 0 : m.now() - m.downSince;
  m.down = false;
  m.downSince = null;
  logger.info(
    { downForSeconds: Math.round(downMs / 1000), resumed: m.waiters.length },
    "network is back — resuming",
  );
  wakeWaiters(m);
}

/** Begin monitoring; returns the stop function. Starting twice replaces the previous monitor rather than running two loops. */
export function startConnectivityMonitor(opts: ConnectivityOptions = {}): () => void {
  stopConnectivityMonitor();
  const m: Monitor = {
    probe: opts.probe ?? defaultProbe,
    intervalMs: opts.intervalMs ?? config.network.probeIntervalMs,
    downIntervalMs: opts.downIntervalMs ?? config.network.probeDownIntervalMs,
    now: opts.now ?? (() => Date.now()),
    down: false,
    downSince: null,
    failedProbes: 0,
    waiters: [],
    timer: null,
    probing: false,
    stopped: false,
  };
  monitor = m;
  // Probe immediately rather than after one interval, so the pre-flight doesn't fail blind against a connection we could already know was down.
  void runProbe(m);
  return stopConnectivityMonitor;
}

export function stopConnectivityMonitor(): void {
  if (monitor === null) return;
  monitor.stopped = true;
  if (monitor.timer !== null) clearTimeout(monitor.timer);
  // Anything parked must not hang for the rest of the process's life.
  wakeWaiters(monitor);
  monitor = null;
}

/** Parks until the network is usable (resolves immediately if healthy or unmonitored). Call before each retry-loop attempt so it waits instead of spending itself against a dead connection. */
export async function awaitNetwork(): Promise<void> {
  const m = monitor;
  if (m === null || !m.down) return;
  return new Promise<void>((resolve) => {
    m.waiters.push(resolve);
  });
}

/** A failing request never decides the network is down; it only asks for a probe now, and the probe is the sole arbiter. Concurrent reports collapse into one in-flight probe. */
export function reportNetworkFailure(): void {
  const m = monitor;
  if (m === null || m.stopped || m.probing) return;
  if (m.timer !== null) clearTimeout(m.timer);
  void runProbe(m);
}

/** A request just got a response (even a 403 from a bot-blocker), proving the network works; beats a probe so recovery is instant. */
export function reportNetworkSuccess(): void {
  const m = monitor;
  if (m === null || m.stopped) return;
  markUp(m);
}

export interface ConnectivityStatus {
  monitoring: boolean;
  down: boolean;
  downForMs: number;
  waiting: number;
}

/** For progress logging: is the run paused, and for how long. */
export function connectivityStatus(): ConnectivityStatus {
  const m = monitor;
  if (m === null) return { monitoring: false, down: false, downForMs: 0, waiting: 0 };
  return {
    monitoring: true,
    down: m.down,
    downForMs: m.down && m.downSince !== null ? m.now() - m.downSince : 0,
    waiting: m.waiters.length,
  };
}
