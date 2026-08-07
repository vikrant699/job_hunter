import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startConnectivityMonitor,
  stopConnectivityMonitor,
  awaitNetwork,
  reportNetworkFailure,
  reportNetworkSuccess,
  connectivityStatus,
} from "../connectivity.js";

/** Let the monitor's timers and probe promises settle. */
async function tick(ms = 12): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** A probe whose answer the test controls, and which records how often it ran. */
function controllableProbe(initial: boolean): {
  probe: () => Promise<boolean>;
  set: (up: boolean) => void;
  calls: () => number;
} {
  let up = initial;
  let calls = 0;
  return {
    probe: async () => {
      calls++;
      return up;
    },
    set: (v: boolean) => {
      up = v;
    },
    calls: () => calls,
  };
}

const FAST = { intervalMs: 5, downIntervalMs: 5 };

test("awaitNetwork is a no-op when no monitor is running", async () => {
  stopConnectivityMonitor();
  // Entry points that never opted in (health, blast, the test suite) must keep
  // their existing behaviour and can never park.
  await awaitNetwork();
  assert.deepEqual(connectivityStatus(), { monitoring: false, down: false, downForMs: 0, waiting: 0 });
});

test("awaitNetwork resolves immediately while the network is healthy", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ ...FAST, probe: p.probe });
  await tick(20);

  await awaitNetwork();
  assert.equal(connectivityStatus().down, false);
});

// The heartbeat is the point: an outage is noticed on its own schedule, without any
// request having to fail first and burn its retry budget discovering it.
test("the heartbeat notices an outage with no failing request at all", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ ...FAST, probe: p.probe });
  await tick(20);
  assert.equal(connectivityStatus().down, false);

  p.set(false);
  await tick(40);
  assert.equal(connectivityStatus().down, true, "detected purely by polling");
});

test("awaitNetwork parks callers while down and releases them all on recovery", async (t) => {
  const p = controllableProbe(false);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ ...FAST, probe: p.probe });
  await tick(20);
  assert.equal(connectivityStatus().down, true);

  let resumed = 0;
  const parked = [awaitNetwork(), awaitNetwork(), awaitNetwork()].map((pr) =>
    pr.then(() => {
      resumed++;
    }),
  );
  await tick(20);
  assert.equal(resumed, 0, "must still be waiting, not skipping ahead");
  assert.equal(connectivityStatus().waiting, 3);

  p.set(true);
  await tick(30);
  await Promise.all(parked);
  assert.equal(resumed, 3, "everyone resumes where they left off");
  assert.equal(connectivityStatus().down, false);
});

// THE case that must never pause the run: one host refusing us (a WAF block, a dead
// vendor) while the connection itself is fine.
test("a failing request does not pause the run when the network is reachable", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ intervalMs: 10_000, downIntervalMs: 10_000, probe: p.probe });

  reportNetworkFailure();
  await tick(20);

  assert.equal(connectivityStatus().down, false, "one hostile host is not an outage");
  await awaitNetwork(); // resolves immediately
});

// ...and the mirror image: the same report during a real outage confirms it at once
// rather than waiting for the next scheduled tick.
test("a failing request confirms a real outage immediately", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
  // A long interval so only the failure-triggered probe can be responsible.
  startConnectivityMonitor({ intervalMs: 10_000, downIntervalMs: 10_000, probe: p.probe });
  await tick(15);

  p.set(false);
  reportNetworkFailure();
  await tick(20);

  assert.equal(connectivityStatus().down, true, "probed on demand, not at the next tick");
});

test("concurrent failure reports collapse into a single probe", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ intervalMs: 10_000, downIntervalMs: 10_000, probe: p.probe });
  await tick(15);
  const before = p.calls();

  // Fifty workers hitting the same outage must not become fifty probes.
  for (let i = 0; i < 50; i++) reportNetworkFailure();
  await tick(25);

  assert.ok(p.calls() - before <= 2, `expected ~1 extra probe, got ${p.calls() - before}`);
});

// A real response is better evidence than a probe, so it should not cost a whole
// tick to act on it.
test("a successful response resumes the run without waiting for the next probe", async (t) => {
  const p = controllableProbe(false);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ intervalMs: 10_000, downIntervalMs: 10_000, probe: p.probe });
  await tick(15);
  assert.equal(connectivityStatus().down, true);

  let resumed = false;
  const parked = awaitNetwork().then(() => {
    resumed = true;
  });

  reportNetworkSuccess();
  await parked;
  assert.equal(resumed, true);
  assert.equal(connectivityStatus().down, false);
});

test("stopping the monitor releases anyone still parked", async (t) => {
  const p = controllableProbe(false);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ ...FAST, probe: p.probe });
  await tick(20);

  let resumed = false;
  const parked = awaitNetwork().then(() => {
    resumed = true;
  });
  stopConnectivityMonitor();
  await parked;
  assert.equal(resumed, true, "a stopped monitor must not strand its waiters");
});

test("starting twice does not leave two loops running", async (t) => {
  const first = controllableProbe(true);
  const second = controllableProbe(true);
  t.after(stopConnectivityMonitor);

  startConnectivityMonitor({ ...FAST, probe: first.probe });
  await tick(20);
  const firstCalls = first.calls();

  startConnectivityMonitor({ ...FAST, probe: second.probe });
  await tick(30);

  assert.equal(first.calls(), firstCalls, "the replaced monitor stopped probing");
  assert.ok(second.calls() > 0);
});
