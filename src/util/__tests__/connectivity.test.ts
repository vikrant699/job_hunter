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

async function tick(ms = 12): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

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

test("a failing request does not pause the run when the network is reachable", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ intervalMs: 10_000, downIntervalMs: 10_000, probe: p.probe });

  reportNetworkFailure();
  await tick(20);

  assert.equal(connectivityStatus().down, false, "one hostile host is not an outage");
  await awaitNetwork();
});

test("a failing request confirms a real outage immediately", async (t) => {
  const p = controllableProbe(true);
  t.after(stopConnectivityMonitor);
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

  for (let i = 0; i < 50; i++) reportNetworkFailure();
  await tick(25);

  assert.ok(p.calls() - before <= 2, `expected ~1 extra probe, got ${p.calls() - before}`);
});

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
