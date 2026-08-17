// src/ats/talentrecruit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { DEFAULT_SEED, seedBytes, boxOpen, decryptToJson, extractSeedFromBundle, bundleUrlFromResponses, bundleKey, resolveSeed, decryptWithHealing, parseJobListPage, normalizeTalentRecruit, EncryptedBlobSchema } from "../talentrecruit.js";
import type { EncryptedBlob, SeedStore, TalentRecruitJob } from "../talentrecruit.js";
import type { AdapterCompany } from "../../types.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "talentrecruit", slug: "zepto", name: "Zepto",
  careersUrl: "https://zepto.talentrecruit.com/career-page",
  tenantUrl: "https://zepto.talentrecruit.com/career-page", apiMeta: null,
};

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

// Encrypts exactly as the TalentRecruit frontend does; note the misleading names (key=nonce, iv=sender public key).
function encryptForSeed(plaintext: string, seed: readonly number[]): EncryptedBlob {
  const receiver = nacl.box.keyPair.fromSecretKey(seedBytes(seed));
  const sender = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msg = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.box(msg, nonce, receiver.publicKey, sender.secretKey);
  return { text: b64(ciphertext), key: b64(nonce), iv: b64(sender.publicKey) };
}

function bundleWithSeed(seed: readonly number[]): string {
  return `!function(){var e={backendseed:{secretKey:[${seed.join(",")}]},other:1};return e}()`;
}

const envelope = <T,>(jobs: T[], count: number) => ({
  error: false, statusCode: 200, message: "Success!",
  data: { data: { noOfTotalRecords: { count }, data: jobs } },
});

const sampleJob: TalentRecruitJob = {
  jobid: "U2FsdGVkX1+abc", code: "12184", title: "Team Lead - Inventory",
  description: "<html><body>Lead the <b>inventory</b> team.<br/>FIFO &amp; audits.</body></html>",
  joblocation: "Bengaluru", city: "Bengaluru", state: "Karnataka", country: "India",
  name: "Inventory", isremotejob: 0, publishedtime: "2026-06-24T12:35:20.000Z",
  createdtime: "2026-06-22T10:52:28.000Z",
};

test("boxOpen + decryptToJson round-trip with the backend seed", () => {
  const blob = encryptForSeed(JSON.stringify({ hello: "world", n: 7 }), DEFAULT_SEED);
  const opened = boxOpen(blob, seedBytes(DEFAULT_SEED));
  assert.ok(opened, "box.open should succeed with the correct seed");
  const json = decryptToJson(blob, seedBytes(DEFAULT_SEED));
  assert.deepEqual(json, { hello: "world", n: 7 });
});

test("decryptToJson returns null with a wrong seed", () => {
  const blob = encryptForSeed(JSON.stringify({ a: 1 }), DEFAULT_SEED);
  const wrong = seedBytes(DEFAULT_SEED.map((_, i) => (i === 0 ? 1 : 2)));
  assert.equal(decryptToJson(blob, wrong), null);
});

test("EncryptedBlobSchema rejects a malformed blob", () => {
  assert.throws(() => EncryptedBlobSchema.parse({ text: "x", iv: "y" }));
});

test("extractSeedFromBundle pulls the 32-byte seed", () => {
  assert.deepEqual(extractSeedFromBundle(bundleWithSeed(DEFAULT_SEED)), [...DEFAULT_SEED]);
  // tolerant of whitespace in the array literal
  assert.deepEqual(extractSeedFromBundle("backendseed : { secretKey : [1, 2, 3] }"), null); // wrong length
  assert.equal(extractSeedFromBundle("no seed here"), null);
});

test("bundleUrlFromResponses prefers the tenant-host main.<hash>.js", () => {
  const urls = [
    "https://app.api.talentrecruit.com/api/v1/master/currency",
    "https://appcareer.talentrecruit.com/main.3c7e38e5e86154780c3d.js",
    "https://zepto.talentrecruit.com/main.c5020320440ba363d661.js",
  ];
  assert.equal(
    bundleUrlFromResponses(urls, "zepto.talentrecruit.com"),
    "https://zepto.talentrecruit.com/main.c5020320440ba363d661.js",
  );
  assert.equal(bundleUrlFromResponses(["https://x/app.js"], "zepto.talentrecruit.com"), null);
});

test("bundleKey is the bundle filename", () => {
  assert.equal(bundleKey("https://zepto.talentrecruit.com/main.abc123.js?v=1"), "main.abc123.js");
});

function memStore(init: Record<string, number[]> = {}): SeedStore {
  const m = new Map<string, number[]>(Object.entries(init));
  return { get: (k) => m.get(k), set: (k, s) => { m.set(k, s); } };
}

test("resolveSeed: cache hit returns without fetching the bundle", async () => {
  let fetches = 0;
  const store = memStore({ "main.x.js": [...DEFAULT_SEED] });
  const seed = await resolveSeed("main.x.js", async () => { fetches++; return ""; }, store);
  assert.equal(fetches, 0);
  assert.deepEqual([...seed], [...DEFAULT_SEED]);
});

test("resolveSeed: cache miss fetches the bundle, extracts + caches the seed", async () => {
  let fetches = 0;
  const store = memStore();
  const seed = await resolveSeed("main.new.js", async () => { fetches++; return bundleWithSeed(DEFAULT_SEED); }, store);
  assert.equal(fetches, 1);
  assert.deepEqual([...seed], [...DEFAULT_SEED]);
  assert.deepEqual(store.get("main.new.js"), [...DEFAULT_SEED]); // cached for next run
});

test("decryptWithHealing: cached seed works, no re-extraction", async () => {
  let fetches = 0;
  const store = memStore({ "main.x.js": [...DEFAULT_SEED] });
  const blob = encryptForSeed(JSON.stringify({ ok: 1 }), DEFAULT_SEED);
  const dec = await decryptWithHealing(blob, "main.x.js", async () => { fetches++; return ""; }, store);
  assert.deepEqual(dec, { ok: 1 });
  assert.equal(fetches, 0);
});

test("decryptWithHealing: stale cached seed triggers a forced re-extraction that succeeds", async () => {
  let fetches = 0;
  // Cache holds a WRONG seed; flip a middle byte since byte 0/31 changes are partly erased by Curve25519 clamping.
  const staleSeed = DEFAULT_SEED.map((n, i) => (i === 10 ? (n ^ 0x55) : n));
  const store = memStore({ "main.x.js": staleSeed });
  const blob = encryptForSeed(JSON.stringify({ healed: true }), DEFAULT_SEED);
  const dec = await decryptWithHealing(
    blob, "main.x.js",
    async () => { fetches++; return bundleWithSeed(DEFAULT_SEED); },
    store,
  );
  assert.deepEqual(dec, { healed: true });
  assert.equal(fetches, 1, "should have re-fetched the bundle once");
  assert.deepEqual(store.get("main.x.js"), [...DEFAULT_SEED], "cache repaired");
});

test("decryptWithHealing: throws loudly when every seed fails (scheme changed)", async () => {
  const store = memStore();
  const otherSeed = DEFAULT_SEED.map((_, i) => (i % 2 ? 3 : 9));
  // Blob encrypted for a seed that is neither cached, in the bundle, nor the default.
  const blob = encryptForSeed(JSON.stringify({ x: 1 }), otherSeed);
  await assert.rejects(
    decryptWithHealing(blob, "main.x.js", async () => "no seed in this bundle", store),
    /encryption scheme likely changed/,
  );
});

test("parseJobListPage unwraps the nested envelope and reads the total", () => {
  const page = parseJobListPage(asJson(envelope([sampleJob], 7)));
  assert.equal(page.total, 7);
  assert.equal(page.jobs.length, 1);
  assert.equal(page.jobs[0]?.code, "12184");
});

test("normalizeTalentRecruit maps fields, prefers code as id, strips JD HTML", () => {
  const p = normalizeTalentRecruit(company, sampleJob);
  assert.equal(p.provider, "talentrecruit");
  assert.equal(p.externalId, "12184"); // code, not the AES jobid
  assert.equal(p.jobTitle, "Team Lead - Inventory");
  assert.equal(p.location, "Bengaluru");
  assert.equal(p.isRemote, false);
  assert.equal(p.jobUrl, "https://zepto.talentrecruit.com/career-page");
  assert.match(p.jdText, /Lead the inventory team\./);
  assert.match(p.jdText, /FIFO & audits\./); // entity decoded
  assert.ok(!p.jdText.includes("<b>"));
  assert.equal(p.postedAt, "2026-06-24T12:35:20.000Z");
});

test("normalizeTalentRecruit falls back to jobid, city/state/country, remote flag", () => {
  const j: TalentRecruitJob = {
    ...sampleJob, code: null, joblocation: null, officelocation: null, isremotejob: 1,
  };
  const p = normalizeTalentRecruit(company, j);
  assert.equal(p.externalId, "U2FsdGVkX1+abc");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
  assert.equal(p.isRemote, true);
});

// End-to-end pure path: encrypt an envelope, decrypt with healing, unwrap, normalize.
test("full decrypt -> parse -> normalize pipeline (synthetic)", async () => {
  const store = memStore();
  const blobJson = JSON.stringify(envelope([sampleJob, { ...sampleJob, code: "99", title: "SDE" }], 2));
  const blob = encryptForSeed(blobJson, DEFAULT_SEED);
  const dec = await decryptWithHealing(blob, "main.k.js", async () => bundleWithSeed(DEFAULT_SEED), store);
  const page = parseJobListPage(dec);
  const postings = page.jobs.map((j) => normalizeTalentRecruit(company, j));
  assert.equal(postings.length, 2);
  assert.deepEqual(postings.map((p) => p.externalId), ["12184", "99"]);
});
