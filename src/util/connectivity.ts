import { config } from "../config.js";
import { logger } from "../logger.js";

export interface ConnectivityOptions {
  probe?: () => Promise<boolean>;
  intervalMs?: number;
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

let monitor: Monitor | null = null;

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

/** Read via a call: it can flip while a probe is awaited, and a monitor stopped mid-probe must not reschedule itself. */
function isStopped(m: Monitor): boolean {
  return m.stopped;
}

function schedule(m: Monitor): void {
  if (isStopped(m)) return;
  m.timer = setTimeout(() => {
    void runProbe(m);
  }, m.down ? m.downIntervalMs : m.intervalMs);
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
  void runProbe(m);
  return stopConnectivityMonitor;
}

export function stopConnectivityMonitor(): void {
  if (monitor === null) return;
  monitor.stopped = true;
  if (monitor.timer !== null) clearTimeout(monitor.timer);
  wakeWaiters(monitor);
  monitor = null;
}

export async function awaitNetwork(): Promise<void> {
  const m = monitor;
  if (m === null || !m.down) return;
  return new Promise<void>((resolve) => {
    m.waiters.push(resolve);
  });
}

export function reportNetworkFailure(): void {
  const m = monitor;
  if (m === null || m.stopped || m.probing) return;
  if (m.timer !== null) clearTimeout(m.timer);
  void runProbe(m);
}

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
