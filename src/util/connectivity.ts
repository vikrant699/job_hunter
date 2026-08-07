// src/util/connectivity.ts - one process-wide answer to "is the internet up?".
//
// The problem this solves: every outbound caller used to discover an outage on its
// own, and a single failed request cannot distinguish "the connection is gone" from
// "this one host is refusing us". So each board burned ~35s of retries, gave up, and
// the run marched on through the whole company list - skipping hundreds of boards
// during what was only a few minutes of downtime (run 29: an ~8 minute drop).
//
// The fix is to stop inferring it from failures at all. A heartbeat probes a neutral
// endpoint on a timer, so an outage is noticed within one tick rather than after a
// worker has already wasted its retry budget. A failing request no longer decides
// anything by itself; it just asks for a probe RIGHT NOW. The probe is the arbiter:
//
//   probe fails    -> the connection is down. Everything waits.
//   probe succeeds -> that one host is the problem. The run carries on.
//
// That asymmetry is what makes a Cloudflare-blocked vendor unable to stall the run,
// and it is why there is no "N hosts failed in M seconds" threshold anywhere here -
// such a rule is only ever a guess standing in for the evidence a probe gives you.
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

/**
 * null until a run starts one. Deliberate: `npm run health`, the blast tool, the
 * test suite and every other entry point keep their existing behaviour, and nothing
 * can accidentally park forever in a context that never opted in.
 */
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

/**
 * Read the flag through a call rather than touching `m.stopped` directly.
 * stopConnectivityMonitor() can set it WHILE the probe below is awaited, but
 * TypeScript's narrowing cannot see that and concludes the later checks are dead
 * code. They are not: without them a monitor stopped mid-probe would reschedule
 * itself and keep the loop alive past the end of the run.
 */
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
  // Waiting is unbounded by design, so the wait has to be loud enough that a run
  // parked at 3am does not look identical to a run that is merely slow.
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

/**
 * Begin monitoring. Returns the stop function; call it when the run ends.
 * Starting twice replaces the previous monitor rather than running two loops.
 */
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
  // Probe straight away rather than after one interval: the run's pre-flight starts
  // immediately, and starting blind means the first thing it does is fail against a
  // connection we could already have known was down. runProbe schedules the next one.
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

/**
 * Park here until the network is usable. Resolves immediately when things are
 * healthy, or when no monitor is running at all.
 *
 * Call it BEFORE each attempt inside a retry loop, so a retry waits for the network
 * instead of spending itself against a connection that is still down.
 */
export async function awaitNetwork(): Promise<void> {
  const m = monitor;
  if (m === null || !m.down) return;
  return new Promise<void>((resolve) => {
    m.waiters.push(resolve);
  });
}

/**
 * A request just failed. This does NOT declare an outage - it asks for a probe now
 * rather than at the next tick, so a genuine outage is confirmed in milliseconds and
 * a single hostile host is dismissed just as fast. Cheap to call from everywhere:
 * concurrent reports collapse into the one probe already in flight.
 */
export function reportNetworkFailure(): void {
  const m = monitor;
  if (m === null || m.stopped || m.probing) return;
  if (m.timer !== null) clearTimeout(m.timer);
  void runProbe(m);
}

/**
 * A request just got a response. Proof the connection works - including a 403 from a
 * bot-blocker, which says nothing about the board but everything about the network.
 * Beats a probe, so recovery is instant rather than waiting for the next tick.
 */
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
