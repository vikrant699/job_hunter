import { test } from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent } from "undici";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import {
  aiaIssuerUrls,
  createChainRepair,
  fetchRepairingChain,
  fetchViaAgent,
  isIncompleteChainError,
  isIssuingIntermediate,
  missingIntermediates,
  parseCert,
} from "../aiaChain.js";
import type { ChainRepair, ChainRepairDeps, RepairedFetch } from "../aiaChain.js";
import { rejectionOf } from "../../__tests__/caught.js";
import { stubFetch } from "../../ats/__tests__/testHelpers.js";

// Dummy EC chain ROOT -> INTERMEDIATE -> LEAF; leaf AIA names int.crt, intermediate's names root.crt.
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBnzCCAUWgAwIBAgIUaD6vZEHIdaImaiLvvetKbKzUcZ8wCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRRXhhbXBsZSBUZXN0IFJvb3QwIBcNMjYxMDEzMTY0ODEzWhgP
MjEyNjA5MTkxNjQ4MTNaMBwxGjAYBgNVBAMMEUV4YW1wbGUgVGVzdCBSb290MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ/7pEVURYF45YlIW6q4iqUiomsI2RroR
ExcVcHbr04t/d2HtMfzVKDv0oObG2y3fxbXJmqeck4a34oWlCg71dqNjMGEwHQYD
VR0OBBYEFKBy5I4mbPVKqapHLO7EC8ZXof+QMB8GA1UdIwQYMBaAFKBy5I4mbPVK
qapHLO7EC8ZXof+QMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoG
CCqGSM49BAMCA0gAMEUCIQCbHcayUDLlgPsOuCH5ROxfSAuGvYkoYom/S1E8W2Kp
SAIgWcz3XKant9+rEjAZh6qsf1O1WWkm1ww+Qs4jDDjSrE8=
-----END CERTIFICATE-----
`;

const INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIB6TCCAY+gAwIBAgIUPlNBPp5pCw8qIsFse3beD21hpKMwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRRXhhbXBsZSBUZXN0IFJvb3QwIBcNMjYxMDEzMTY0ODEzWhgP
MjEyNjA5MTkxNjQ4MTNaMCQxIjAgBgNVBAMMGUV4YW1wbGUgVGVzdCBJbnRlcm1l
ZGlhdGUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASm5jOVvWHtsWHtSdcsOnev
4cMFGYGGkfwgHD6aLPaqDXUJFOX5vfYaBW8a0XtwDtZ0M1JGNP0mZ0jJ31R4yIOs
o4GkMIGhMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMDsGCCsG
AQUFBwEBBC8wLTArBggrBgEFBQcwAoYfaHR0cDovL2NhLmV4YW1wbGUudGVzdC9y
b290LmNydDAdBgNVHQ4EFgQU3Ej9RwxjufI41iO2GY3mwrTYoAcwHwYDVR0jBBgw
FoAUoHLkjiZs9Uqpqkcs7sQLxleh/5AwCgYIKoZIzj0EAwIDSAAwRQIhANi9PlmE
DA6eJy8cdrZPoVlIhrHeTO1lfb6Yn3gwaW88AiB9SVEP2hDxLMzRcRlEy6ohXSq3
DCibq6O91Kz6aMC4fA==
-----END CERTIFICATE-----
`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIICFzCCAb6gAwIBAgIUZUkLruDTEl6AlvTdLeJu60uSxcEwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZRXhhbXBsZSBUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMTMx
NjQ4MTRaGA8yMTI2MDkxOTE2NDgxNFowHTEbMBkGA1UEAwwSYm9hcmQuZXhhbXBs
ZS50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOi9U7lHgowAEoMe1jSh+
GEy4ukDuhmDooifgCgwmj0ueDhOhGRAefyvzhz9T1HbH50g/NluObTJOS6K76jbA
c6OB0jCBzzAMBgNVHRMBAf8EAjAAMB0GA1UdEQQWMBSCEmJvYXJkLmV4YW1wbGUu
dGVzdDBgBggrBgEFBQcBAQRUMFIwJAYIKwYBBQUHMAGGGGh0dHA6Ly9vY3NwLmV4
YW1wbGUudGVzdDAqBggrBgEFBQcwAoYeaHR0cDovL2NhLmV4YW1wbGUudGVzdC9p
bnQuY3J0MB0GA1UdDgQWBBTaxI9xR7rpeefVjkgfimCJBSVPzzAfBgNVHSMEGDAW
gBTcSP1HDGO58jjWI7YZjebCtNigBzAKBggqhkjOPQQDAgNHADBEAiBTnde0Wf3P
uhXK4/lXBsQDSXznMvhI0cGGWYbt8J5oLQIgaOCQuue/otVu+Z03LzO1c4Itlmw7
lyOr0bcjM7LZcXc=
-----END CERTIFICATE-----
`;

const ROGUE_PEM = `-----BEGIN CERTIFICATE-----
MIIBnzCCAUWgAwIBAgIUTuxox82hQBLsNfTGCXrERkA3VVgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZRXhhbXBsZSBUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMTMx
NjQ4MTRaGA8yMTI2MDkxOTE2NDgxNFowJDEiMCAGA1UEAwwZRXhhbXBsZSBUZXN0
IEludGVybWVkaWF0ZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNEwoBmca3gU
UkOpsJ8S9q28Roj+iSN3hEvmcp4hTOofwx3+mPGiDt3Xayc1Y2rwfBTBRGZwM+Nq
ZY2QSxC6cWWjUzBRMB0GA1UdDgQWBBSs42QWQ8jzuQFNJEQTFP2aBpdZFzAfBgNV
HSMEGDAWgBSs42QWQ8jzuQFNJEQTFP2aBpdZFzAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0gAMEUCIQDM2vnqcFv2+RuRnawjhuEE+uOs4KiQhV3Ui6Jlicr7
HgIgOsrMUeFZ8r1vhrvFUw+JdjpRYGvT0nw3gZ1pbo/2yvA=
-----END CERTIFICATE-----
`;

const ROOT = new X509Certificate(ROOT_PEM);
const INTERMEDIATE = new X509Certificate(INTERMEDIATE_PEM);
const LEAF = new X509Certificate(LEAF_PEM);
const ROGUE = new X509Certificate(ROGUE_PEM);

const INT_URL = "http://ca.example.test/int.crt";
const ROOT_URL = "http://ca.example.test/root.crt";

/** The shape undici produces when the server sends only its leaf. */
function incompleteChainFailure(code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE"): Error {
  const cause = new Error("unable to verify the first certificate");
  Object.assign(cause, { code });
  return new TypeError("fetch failed", { cause });
}

function certServer(byUrl: Record<string, Uint8Array>): { fetchCert: (url: string) => Promise<Uint8Array>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchCert: (url) => {
      calls.push(url);
      const bytes = byUrl[url];
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`no cert at ${url}`));
    },
  };
}

test("isIncompleteChainError: matches both missing-issuer codes anywhere in the cause chain", () => {
  assert.equal(isIncompleteChainError(incompleteChainFailure()), true);
  assert.equal(isIncompleteChainError(incompleteChainFailure("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")), true);
});

test("isIncompleteChainError: other TLS and transport faults are not chain gaps", () => {
  assert.equal(isIncompleteChainError(incompleteChainFailure("CERT_HAS_EXPIRED")), false);
  assert.equal(isIncompleteChainError(incompleteChainFailure("DEPTH_ZERO_SELF_SIGNED_CERT")), false);
  assert.equal(isIncompleteChainError(incompleteChainFailure("ECONNRESET")), false);
  assert.equal(isIncompleteChainError(new Error("plain")), false);
});

test("aiaIssuerUrls: takes only the CA Issuers entries, never OCSP", () => {
  assert.deepEqual(aiaIssuerUrls(LEAF.infoAccess), [INT_URL]);
  assert.deepEqual(
    aiaIssuerUrls("OCSP - URI:http://status.rapidssl.com\nCA Issuers - URI:http://cacerts.rapidssl.com/RapidSSLTLSRSACAG1.crt"),
    ["http://cacerts.rapidssl.com/RapidSSLTLSRSACAG1.crt"],
  );
});

test("aiaIssuerUrls: no extension, or a non-http scheme, yields nothing", () => {
  assert.deepEqual(aiaIssuerUrls(undefined), []);
  assert.deepEqual(aiaIssuerUrls("CA Issuers - URI:ldap://dir.example.test/cn=ca"), []);
});

test("parseCert: accepts DER and PEM bytes alike and returns the same certificate", () => {
  const fromDer = parseCert(new Uint8Array(INTERMEDIATE.raw));
  const fromPem = parseCert(new TextEncoder().encode(INTERMEDIATE_PEM));
  assert.ok(fromDer !== null && fromPem !== null);
  assert.equal(fromDer.fingerprint256, INTERMEDIATE.fingerprint256);
  assert.equal(fromPem.fingerprint256, INTERMEDIATE.fingerprint256);
  assert.match(fromDer.toString(), /^-----BEGIN CERTIFICATE-----/);
});

test("parseCert: garbage (an HTML error page, an empty body) is null, not a throw", () => {
  assert.equal(parseCert(new TextEncoder().encode("<html>404</html>")), null);
  assert.equal(parseCert(new Uint8Array()), null);
});

test("isIssuingIntermediate: the real issuer passes; a same-named impostor, a leaf and a self-signed root fail", () => {
  assert.equal(isIssuingIntermediate(LEAF, INTERMEDIATE), true);
  assert.equal(isIssuingIntermediate(LEAF, ROGUE), false);
  assert.equal(isIssuingIntermediate(LEAF, LEAF), false);
  assert.equal(isIssuingIntermediate(INTERMEDIATE, ROOT), false);
});

test("missingIntermediates: fetches the leaf's issuer via AIA when a trusted root anchors it", async () => {
  const server = certServer({ [INT_URL]: new Uint8Array(INTERMEDIATE.raw) });
  const added = await missingIntermediates([LEAF], [ROOT], server.fetchCert);
  assert.deepEqual(added?.map((c) => c.fingerprint256), [INTERMEDIATE.fingerprint256]);
  assert.deepEqual(server.calls, [INT_URL]);
});

test("missingIntermediates: an intermediate the server did present is used without a fetch", async () => {
  const server = certServer({});
  assert.equal(await missingIntermediates([LEAF, INTERMEDIATE], [ROOT], server.fetchCert), null);
  assert.deepEqual(server.calls, []);
});

test("missingIntermediates: never adds a self-signed cert, so an untrusted root stays untrusted", async () => {
  const server = certServer({ [INT_URL]: new Uint8Array(INTERMEDIATE.raw), [ROOT_URL]: new Uint8Array(ROOT.raw) });
  assert.equal(await missingIntermediates([LEAF], [], server.fetchCert), null);
  assert.deepEqual(server.calls, [INT_URL, ROOT_URL]);
});

test("missingIntermediates: an unanchored chain the server sent in full ends at its self-signed top", async () => {
  const server = certServer({ [ROOT_URL]: new Uint8Array(ROOT.raw) });
  assert.equal(await missingIntermediates([LEAF, INTERMEDIATE, INTERMEDIATE], [], server.fetchCert), null);
  assert.deepEqual(server.calls, [ROOT_URL]);
});

test("missingIntermediates: an AIA URL serving an impostor is refused", async () => {
  const server = certServer({ [INT_URL]: new Uint8Array(ROGUE.raw) });
  assert.equal(await missingIntermediates([LEAF], [ROOT], server.fetchCert), null);
});

test("missingIntermediates: an AIA download failure propagates so the caller can retry later", async () => {
  const server = certServer({});
  const err = await rejectionOf(missingIntermediates([LEAF], [ROOT], server.fetchCert));
  assert.match(String(err), /no cert at/);
});

function fakeDeps(overrides: Partial<ChainRepairDeps> = {}): ChainRepairDeps & { peeks: string[] } {
  const peeks: string[] = [];
  const server = certServer({ [INT_URL]: new Uint8Array(INTERMEDIATE.raw) });
  return {
    peeks,
    trustedRootPems: () => [ROOT_PEM],
    fetchCert: server.fetchCert,
    peerChain: (host, port) => {
      peeks.push(`${host}:${port}`);
      return Promise.resolve([LEAF]);
    },
    ...overrides,
  };
}

test("createChainRepair: builds one verifying fetch per host and caches it for the process", async () => {
  const deps = fakeDeps();
  const repair = createChainRepair(deps);
  assert.equal(repair.fetcherFor("https://board.example.test/jobs"), undefined);
  const [a, b] = await Promise.all([
    repair.repair("https://board.example.test/jobs"),
    repair.repair("https://board.example.test/jobs?page=2"),
  ]);
  assert.notEqual(a, null);
  assert.equal(a, b);
  assert.equal(repair.fetcherFor("https://board.example.test/job/7"), a);
  assert.equal(repair.fetcherFor("https://other.example.test/"), undefined);
  assert.deepEqual(deps.peeks, ["board.example.test:443"]);
});

test("createChainRepair: an unrepairable host is remembered and not re-peeked", async () => {
  const deps = fakeDeps({ fetchCert: () => Promise.resolve(new Uint8Array(ROGUE.raw)) });
  const repair = createChainRepair(deps);
  assert.equal(await repair.repair("https://board.example.test/"), null);
  assert.equal(await repair.repair("https://board.example.test/"), null);
  assert.deepEqual(deps.peeks, ["board.example.test:443"]);
});

test("createChainRepair: a transient peek failure is not cached", async () => {
  let fail = true;
  const deps = fakeDeps({
    peerChain: () => (fail ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve([LEAF])),
  });
  const repair = createChainRepair(deps);
  assert.equal(await repair.repair("https://board.example.test:8443/"), null);
  fail = false;
  assert.notEqual(await repair.repair("https://board.example.test:8443/"), null);
});

test("createChainRepair: plain http and unparseable URLs are never repaired", async () => {
  const deps = fakeDeps();
  const repair = createChainRepair(deps);
  assert.equal(await repair.repair("http://board.example.test/"), null);
  assert.equal(await repair.repair("not a url"), null);
  assert.equal(repair.fetcherFor("not a url"), undefined);
  assert.deepEqual(deps.peeks, []);
});

function fakeRepair(): ChainRepair & { repairs: string[]; repairedCalls: string[] } {
  const repairs: string[] = [];
  const repairedCalls: string[] = [];
  let built: RepairedFetch | undefined;
  return {
    repairs,
    repairedCalls,
    fetcherFor: () => built,
    repair: (url) => {
      repairs.push(url);
      built = (u) => {
        repairedCalls.push(u);
        return Promise.resolve(new Response("ok"));
      };
      return Promise.resolve(built);
    },
  };
}

test("fetchRepairingChain: retries an incomplete-chain failure once through the repaired fetch, then reuses it", async (t) => {
  let plainCalls = 0;
  stubFetch(t, () => {
    plainCalls++;
    return Promise.reject(incompleteChainFailure());
  });
  const repair = fakeRepair();
  const res = await fetchRepairingChain("https://board.example.test/jobs", {}, repair);
  assert.equal(await res.text(), "ok");
  await fetchRepairingChain("https://board.example.test/job/1", {}, repair);
  assert.equal(plainCalls, 1);
  assert.deepEqual(repair.repairs, ["https://board.example.test/jobs"]);
  assert.deepEqual(repair.repairedCalls, ["https://board.example.test/jobs", "https://board.example.test/job/1"]);
});

test("fetchRepairingChain: any other failure is rethrown untouched with no repair attempt", async (t) => {
  const original = incompleteChainFailure("ECONNRESET");
  stubFetch(t, () => Promise.reject(original));
  const repair = fakeRepair();
  assert.equal(await rejectionOf(fetchRepairingChain("https://board.example.test/", {}, repair)), original);
  assert.deepEqual(repair.repairs, []);
});

test("fetchRepairingChain: an unrepairable chain rethrows the original error", async (t) => {
  const original = incompleteChainFailure();
  stubFetch(t, () => Promise.reject(original));
  const repair: ChainRepair = { fetcherFor: () => undefined, repair: () => Promise.resolve(null) };
  assert.equal(await rejectionOf(fetchRepairingChain("https://board.example.test/", {}, repair)), original);
});

async function localServer(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${address.port}`;
}

test("fetchViaAgent: follows redirects, sends the serialized body and headers, and keeps the final url", async (t) => {
  const seen: string[] = [];
  const base = await localServer(t, (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers["content-type"] ?? ""} ${req.headers["x-probe"] ?? ""} ${body}`);
      if (req.url === "/start") {
        res.writeHead(307, { Location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain", "X-Board": "yes" });
      res.end("landed");
    });
  });
  const agent = new Agent();
  t.after(() => agent.close());
  const res = await fetchViaAgent(agent, `${base}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Probe": "1" },
    body: new URLSearchParams({ page: "2" }).toString(),
    redirect: "follow",
  });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.url, `${base}/final`);
  assert.equal(res.headers.get("x-board"), "yes");
  assert.equal(await res.text(), "landed");
  assert.deepEqual(seen, [
    "POST /start application/x-www-form-urlencoded 1 page=2",
    "POST /final application/x-www-form-urlencoded 1 page=2",
  ]);
});

test("fetchViaAgent: a null-body status and a GET without body both survive the re-wrap", async (t) => {
  const base = await localServer(t, (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const agent = new Agent();
  t.after(() => agent.close());
  const res = await fetchViaAgent(agent, `${base}/x`, {});
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});
