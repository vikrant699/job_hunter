// src/blast/mx.ts
import { resolveMx } from "node:dns/promises";

export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

/** Per-run MX cache: one DNS query per domain no matter how many addresses
 *  share it. Any resolver failure (NXDOMAIN, ENODATA, timeout) counts as "no
 *  MX" — for a cold-email tool, a domain we can't positively resolve is not
 *  worth risking a hard bounce over. */
export class MxChecker {
  private readonly cache = new Map<string, boolean>();
  private readonly resolver: MxResolver;

  constructor(resolver: MxResolver = resolveMx) {
    this.resolver = resolver;
  }

  async hasMx(email: string): Promise<boolean> {
    const domain = email.slice(email.indexOf("@") + 1);
    const cached = this.cache.get(domain);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      ok = (await this.resolver(domain)).length > 0;
    } catch {
      ok = false;
    }
    this.cache.set(domain, ok);
    return ok;
  }
}
