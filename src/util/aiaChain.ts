import tls from "node:tls";
import type { DetailedPeerCertificate } from "node:tls";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { logger } from "../logger.js";
import { describeError, errorCauseCodes } from "./errorCause.js";
import type { Caught } from "./errorCause.js";

/** OpenSSL's verdicts for "the server never sent the cert that issued this one", the only failures AIA fetching can mend. */
const INCOMPLETE_CHAIN_CODES = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);

/** Real chains are leaf + 1-2 intermediates; the cap stops a looping or hostile AIA walk. */
const MAX_FETCHED_LEVELS = 3;
const PEEK_TIMEOUT_MS = 10_000;
const CERT_FETCH_TIMEOUT_MS = 10_000;
/** A certificate is a few KB; anything larger is not one. */
const MAX_CERT_BYTES = 64 * 1024;

const CA_ISSUERS_RE = /^CA Issuers - URI:(https?:\/\/\S+)$/gim;

export function isIncompleteChainError(err: Caught): boolean {
  return errorCauseCodes(err).some((code) => INCOMPLETE_CHAIN_CODES.has(code));
}

/** The http(s) CA Issuers URLs from an X509Certificate.infoAccess string (OCSP and ldap entries are skipped). */
export function aiaIssuerUrls(infoAccess: string | undefined): string[] {
  if (infoAccess === undefined) return [];
  return [...infoAccess.matchAll(CA_ISSUERS_RE)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** A certificate from DER or PEM bytes; null for anything else (an error page, a PKCS#7 bundle). */
export function parseCert(bytes: Uint8Array): X509Certificate | null {
  if (bytes.length === 0) return null;
  try {
    return new X509Certificate(bytes);
  } catch {
    return null;
  }
}

function isSelfIssued(cert: X509Certificate): boolean {
  return cert.subject === cert.issuer || cert.checkIssued(cert);
}

/** `candidate` is a non-self-signed CA cert whose key actually signed `child`; a self-signed cert in `ca` would become a trust anchor, so it is never accepted. */
export function isIssuingIntermediate(child: X509Certificate, candidate: X509Certificate): boolean {
  if (!candidate.ca || isSelfIssued(candidate)) return false;
  return child.checkIssued(candidate) && child.verify(candidate.publicKey);
}

function isAnchored(cert: X509Certificate, roots: readonly X509Certificate[]): boolean {
  return roots.some((root) => cert.checkIssued(root) && cert.verify(root.publicKey));
}

async function fetchIssuer(cert: X509Certificate, fetchCert: (url: string) => Promise<Uint8Array>): Promise<X509Certificate | null> {
  for (const url of aiaIssuerUrls(cert.infoAccess)) {
    const issuer = parseCert(await fetchCert(url));
    if (issuer !== null && isIssuingIntermediate(cert, issuer)) return issuer;
  }
  return null;
}

/** The intermediates to add so `presented` (leaf first) reaches one of `roots`; null when nothing is missing or no verified path to a root exists. */
export async function missingIntermediates(
  presented: readonly X509Certificate[],
  roots: readonly X509Certificate[],
  fetchCert: (url: string) => Promise<Uint8Array>,
): Promise<X509Certificate[] | null> {
  let current = presented[0];
  const added: X509Certificate[] = [];
  // the step cap also ends a cycle among presented cross-signs
  for (let step = 0; current !== undefined && step <= presented.length + MAX_FETCHED_LEVELS; step++) {
    if (isAnchored(current, roots)) return added.length > 0 ? added : null;
    const child = current;
    const sent = presented.find((c) => isIssuingIntermediate(child, c));
    if (sent !== undefined) {
      current = sent;
      continue;
    }
    if (added.length >= MAX_FETCHED_LEVELS) return null;
    const fetched = await fetchIssuer(child, fetchCert);
    if (fetched === null) return null;
    added.push(fetched);
    current = fetched;
  }
  return null;
}

// typed non-optional by @types/node, but absent past the last certificate the server sent
function issuerOf(cert: DetailedPeerCertificate): DetailedPeerCertificate | undefined {
  return cert.issuerCertificate;
}

function presentedChain(leaf: DetailedPeerCertificate): X509Certificate[] {
  const out: X509Certificate[] = [];
  const seen = new Set<string>();
  for (let c: DetailedPeerCertificate | undefined = leaf; c !== undefined && !seen.has(c.fingerprint256); c = issuerOf(c)) {
    seen.add(c.fingerprint256);
    out.push(new X509Certificate(c.raw));
  }
  return out;
}

/** The certificates `host` presents, leaf first; verification is off only to read them, and the socket closes right after the handshake. */
function peekPeerChain(host: string, port: number): Promise<X509Certificate[]> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, ...(isIP(host) === 0 ? { servername: host } : {}) });
    socket.setTimeout(PEEK_TIMEOUT_MS, () => socket.destroy(new Error(`TLS peek at ${host}:${port} timed out`)));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      try {
        resolve(presentedChain(socket.getPeerCertificate(true)));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        socket.destroy();
      }
    });
  });
}

async function downloadCert(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`AIA ${url} answered HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_CERT_BYTES) throw new Error(`AIA ${url} body is ${bytes.length} bytes, too large for a certificate`);
  return bytes;
}

/** Statuses whose Response must carry a null body (the constructor throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** fetch() through `agent` via undici's own fetch (its Agent does not type-check as the global fetch's dispatcher), re-wrapped as a global Response that keeps the post-redirect url. */
export async function fetchViaAgent(agent: Agent, url: string, init: RequestInit): Promise<Response> {
  const req = new Request(url, init);
  const body = req.body === null ? null : new Uint8Array(await req.arrayBuffer());
  const res = await undiciFetch(req.url, {
    method: req.method,
    headers: [...req.headers],
    redirect: req.redirect,
    signal: req.signal,
    dispatcher: agent,
    ...(body === null ? {} : { body }),
  });
  const out = new Response(NULL_BODY_STATUSES.has(res.status) ? null : await res.arrayBuffer(), {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
  });
  Object.defineProperty(out, "url", { value: res.url });
  return out;
}

export type RepairedFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ChainRepairDeps {
  /** The process's default trust store; a repaired chain must still end at one of these. */
  trustedRootPems: () => readonly string[];
  peerChain: (host: string, port: number) => Promise<X509Certificate[]>;
  fetchCert: (url: string) => Promise<Uint8Array>;
}

export interface ChainRepair {
  /** The repaired fetch for this URL's host, once one has been built. */
  fetcherFor: (url: string) => RepairedFetch | undefined;
  /** Fetch the host's missing intermediates via AIA and build a verifying fetch; null when the chain cannot be completed. */
  repair: (url: string) => Promise<RepairedFetch | null>;
}

function hostKey(u: URL): string {
  return `${u.hostname}:${u.port === "" ? "443" : u.port}`;
}

export function createChainRepair(deps: ChainRepairDeps): ChainRepair {
  const repaired = new Map<string, RepairedFetch>();
  const unrepairable = new Set<string>();
  const inflight = new Map<string, Promise<RepairedFetch | null>>();

  async function build(host: string, port: number, key: string): Promise<RepairedFetch | null> {
    let added: X509Certificate[] | null;
    try {
      const roots = deps.trustedRootPems().map((pem) => new X509Certificate(pem));
      added = await missingIntermediates(await deps.peerChain(host, port), roots, deps.fetchCert);
    } catch (err) {
      logger.warn({ host: key, err: describeError(err) }, "TLS chain repair failed; will retry on a later request");
      return null;
    }
    if (added === null) {
      unrepairable.add(key);
      logger.warn({ host: key }, "TLS chain is incomplete and AIA cannot complete it to a trusted root");
      return null;
    }
    // verification stays on: the extra certs only fill the gap, and the chain must still end at a default-store root
    const agent = new Agent({ connect: { ca: [...deps.trustedRootPems(), ...added.map((c) => c.toString())] } });
    const fetcher: RepairedFetch = (url, init) => fetchViaAgent(agent, url, init);
    repaired.set(key, fetcher);
    logger.info({ host: key, added: added.map((c) => c.subject.replace(/\n/g, ", ")) }, "completed an incomplete TLS chain via AIA");
    return fetcher;
  }

  return {
    // an unparseable URL is left for fetch() itself to reject
    fetcherFor: (url) => (URL.canParse(url) ? repaired.get(hostKey(new URL(url))) : undefined),
    repair: (url) => {
      if (!URL.canParse(url)) return Promise.resolve(null);
      const u = new URL(url);
      if (u.protocol !== "https:") return Promise.resolve(null);
      const key = hostKey(u);
      const known = repaired.get(key);
      if (known !== undefined) return Promise.resolve(known);
      if (unrepairable.has(key)) return Promise.resolve(null);
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const started = build(u.hostname, u.port === "" ? 443 : Number(u.port), key).finally(() => inflight.delete(key));
      inflight.set(key, started);
      return started;
    },
  };
}

export const chainRepair = createChainRepair({
  trustedRootPems: () => tls.getCACertificates("default"),
  peerChain: peekPeerChain,
  fetchCert: downloadCert,
});

/** fetch() that, like a browser, completes a server's missing intermediate via AIA and retries once with full verification; every other failure is rethrown untouched. */
export async function fetchRepairingChain(url: string, init: RequestInit, repair: ChainRepair = chainRepair): Promise<Response> {
  const known = repair.fetcherFor(url);
  if (known !== undefined) return known(url, init);
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isIncompleteChainError(err)) throw err;
    const repaired = await repair.repair(url);
    if (repaired === null) throw err;
    return repaired(url, init);
  }
}
