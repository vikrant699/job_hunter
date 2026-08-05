// src/blast/mx.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MxChecker } from "../mx.js";
import type { MxResolver } from "../mx.js";

function countingResolver(answers: Record<string, { exchange: string; priority: number }[] | Error>): {
  resolver: MxResolver;
  calls: string[];
} {
  const calls: string[] = [];
  const resolver: MxResolver = (domain) => {
    calls.push(domain);
    const answer = answers[domain];
    if (answer === undefined) return Promise.reject(new Error(`ENOTFOUND ${domain}`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  return { resolver, calls };
}

test("valid MX -> true; resolver error -> false; empty MX answer -> false", async () => {
  const { resolver } = countingResolver({
    "good.com": [{ exchange: "mx.good.com", priority: 10 }],
    "empty.com": [],
    "dead.com": new Error("queryMx ENODATA dead.com"),
  });
  const mx = new MxChecker(resolver);
  assert.equal(await mx.hasMx("a@good.com"), true);
  assert.equal(await mx.hasMx("a@empty.com"), false);
  assert.equal(await mx.hasMx("a@dead.com"), false);
  assert.equal(await mx.hasMx("a@unlisted.com"), false);
});

test("caches per domain: one DNS query no matter how many addresses share it", async () => {
  const { resolver, calls } = countingResolver({ "x.com": [{ exchange: "mx.x.com", priority: 5 }] });
  const mx = new MxChecker(resolver);
  await mx.hasMx("a@x.com");
  await mx.hasMx("b@x.com");
  await mx.hasMx("c@x.com");
  assert.deepEqual(calls, ["x.com"]);
});

test("negative results are cached too", async () => {
  const { resolver, calls } = countingResolver({});
  const mx = new MxChecker(resolver);
  await mx.hasMx("a@gone.com");
  await mx.hasMx("b@gone.com");
  assert.deepEqual(calls, ["gone.com"]);
});
