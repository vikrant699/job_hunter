// Mechanical (no-LLM) stated-salary extraction from JD text, India-first; pure regex/arithmetic, no network/LLM calls.

export type SalaryPeriod = "year" | "month" | "week" | "day" | "hour";

export interface SalaryExtract {
  min: number;
  max: number;
  currency: string;
  period: SalaryPeriod;
  annualMin: number;
  annualMax: number;
  raw: string;
}

// Currency tokens: longer/symbol forms first so "US$" isn't split into "US" + "$"; word forms are \b-bounded so "Rs" never matches inside "Years"/"hrs" and "INR"/"USD"/etc never match mid-word.
const CUR = String.raw`(?:US\$|₹|\$|€|£|\bRs\.?|\bINR\b|\bUSD\b|\bEUR\b|\bGBP\b|\bAED\b|\bSGD\b|\bCAD\b|\bAUD\b)`;

// Digit groups with commas (handles both Indian 2-2-3 grouping and Western 3-3 grouping - stripping all commas before parsing works for either) plus an optional decimal.
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;

// Indian magnitude words + the ambiguous "k" shorthand; the negative lookahead stops "5 known" from reading "k" out of "known" - MAG only matches when nothing but whitespace/punctuation follows.
const MAG = String.raw`(?:LPA|LAKHS?|LACS?|CRORE|CR|K)(?![a-zA-Z])`;

const SEP = String.raw`\s*(?:-|–|—|\bto\b)\s*`;

const PATTERN =
  `(?<cur1>${CUR})?\\s*(?<num1>${NUM})\\s*(?<mag1>${MAG})?\\s*(?<curSuf1>${CUR})?` +
  `(?:${SEP}(?<cur2>${CUR})?\\s*(?<num2>${NUM})\\s*(?<mag2>${MAG})?\\s*(?<curSuf2>${CUR})?)?`;

const MASTER_RE = new RegExp(PATTERN, "gi");

const CONTEXT_RE = /\b(?:salary|compensation|pay|ctc|package|stipend|remuneration|budget)\b/i;

const YEAR_PERIOD_RE = /per\s*annum|\/\s*annum|\bannually\b|\byearly\b|per\s*year|\/\s*year|\/\s*yr\b/i;
const MONTH_PERIOD_RE = /per\s*month|\/\s*month|\bmonthly\b|\/\s*mo\b|per\s*mo\b/i;
const WEEK_PERIOD_RE = /per\s*week|\/\s*week|\bweekly\b/i;
const DAY_PERIOD_RE = /per\s*day|\/\s*day|\bdaily\b/i;
const HOUR_PERIOD_RE = /per\s*hour|\/\s*hour|\bhourly\b|\/\s*hr\b|per\s*hr\b/i;

function detectPeriod(window: string): SalaryPeriod | null {
  if (YEAR_PERIOD_RE.test(window)) return "year";
  if (MONTH_PERIOD_RE.test(window)) return "month";
  if (WEEK_PERIOD_RE.test(window)) return "week";
  if (DAY_PERIOD_RE.test(window)) return "day";
  if (HOUR_PERIOD_RE.test(window)) return "hour";
  return null;
}

function isIndianMagnitude(token: string | undefined): boolean {
  if (token === undefined) return false;
  const t = token.toLowerCase();
  return t === "lpa" || t === "lakh" || t === "lakhs" || t === "lac" || t === "lacs" || t === "cr" || t === "crore";
}

function isKMagnitude(token: string | undefined): boolean {
  return token !== undefined && token.toLowerCase() === "k";
}

function multiplierFor(token: string | undefined): number {
  if (token === undefined) return 1;
  const t = token.toLowerCase();
  if (t === "k") return 1000;
  if (t === "lpa" || t === "lakh" || t === "lakhs" || t === "lac" || t === "lacs") return 100000;
  if (t === "cr" || t === "crore") return 10000000;
  return 1;
}

function normalizeCurrency(token: string): string {
  const t = token.trim().toLowerCase().replace(/\.$/, "");
  if (t === "₹" || t === "rs" || t === "inr") return "INR";
  if (t === "us$" || t === "$" || t === "usd") return "USD";
  if (t === "€" || t === "eur") return "EUR";
  if (t === "£" || t === "gbp") return "GBP";
  if (t === "aed") return "AED";
  if (t === "sgd") return "SGD";
  if (t === "cad") return "CAD";
  if (t === "aud") return "AUD";
  return "USD";
}

function annualize(value: number, period: SalaryPeriod): number {
  switch (period) {
    case "year":
      return value;
    case "month":
      return value * 12;
    case "week":
      return value * 52;
    case "day":
      return value * 260;
    case "hour":
      return value * 2080;
  }
}

function capsFor(currency: string): [number, number] {
  if (currency === "INR") return [5e4, 2e8];
  if (currency === "USD" || currency === "EUR" || currency === "GBP") return [5e3, 2e6];
  return [1e4, 5e6];
}

function parseNum(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

interface Candidate extends SalaryExtract {
  index: number;
  isRange: boolean;
  hasExplicitCurrency: boolean;
  hasContext: boolean;
}

/** Best stated-salary figure in `text`, or null when nothing plausible is stated. Never estimates. */
export function extractSalary(text: string): SalaryExtract | null {
  if (!text || !text.trim()) return null;

  const candidates: Candidate[] = [];

  for (const m of text.matchAll(MASTER_RE)) {
    const g = m.groups;
    if (!g) continue;
    const start = m.index;
    const num1 = g.num1;
    if (num1 === undefined) continue;

    const isRange = g.num2 !== undefined;
    const mag1eff = g.mag1 ?? (isRange ? g.mag2 : undefined);
    const mag2eff = g.mag2 ?? (isRange ? g.mag1 : undefined);
    const curToken = g.cur1 ?? g.curSuf1 ?? (isRange ? (g.cur2 ?? g.curSuf2) : undefined);

    let currency: string;
    let hasExplicitCurrency: boolean;

    if (curToken !== undefined) {
      currency = normalizeCurrency(curToken);
      hasExplicitCurrency = true;
    } else if (isIndianMagnitude(mag1eff) || isIndianMagnitude(mag2eff)) {
      currency = "INR";
      hasExplicitCurrency = true;
    } else if (isRange && isKMagnitude(mag1eff) && isKMagnitude(mag2eff)) {
      // Currency-less range: only plausible salary when a compensation context word precedes it.
      const before = text.slice(Math.max(0, start - 120), start);
      if (!CONTEXT_RE.test(before)) continue;
      currency = "INR";
      hasExplicitCurrency = false;
    } else {
      continue; // no currency or magnitude signal at all - not a money expression
    }

    const min0 = parseNum(num1) * multiplierFor(mag1eff);
    const num2 = g.num2;
    const max0 = isRange && num2 !== undefined ? parseNum(num2) * multiplierFor(mag2eff) : min0;
    const min = Math.min(min0, max0);
    const max = Math.max(min0, max0);

    const impliedYear = isIndianMagnitude(mag1eff) || isIndianMagnitude(mag2eff);
    const afterWindow = text.slice(start, Math.min(text.length, start + m[0].length + 40));
    const beforeWindow = text.slice(Math.max(0, start - 25), start);
    const period: SalaryPeriod = impliedYear ? "year" : (detectPeriod(afterWindow) ?? detectPeriod(beforeWindow) ?? "year");

    const annualMin = annualize(min, period);
    const annualMax = annualize(max, period);
    const [capMin, capMax] = capsFor(currency);
    if (annualMin < capMin || annualMin > capMax || annualMax < capMin || annualMax > capMax) continue;

    const hasContext = CONTEXT_RE.test(text.slice(Math.max(0, start - 120), start));

    candidates.push({
      index: start,
      isRange,
      hasExplicitCurrency,
      hasContext,
      min,
      max,
      currency,
      period,
      annualMin,
      annualMax,
      raw: m[0].trim().slice(0, 80),
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.isRange !== b.isRange) return a.isRange ? -1 : 1;
    if (a.hasExplicitCurrency !== b.hasExplicitCurrency) return a.hasExplicitCurrency ? -1 : 1;
    if (a.hasContext !== b.hasContext) return a.hasContext ? -1 : 1;
    return a.index - b.index;
  });

  const best = candidates[0];
  if (!best) return null;
  return {
    min: best.min,
    max: best.max,
    currency: best.currency,
    period: best.period,
    annualMin: best.annualMin,
    annualMax: best.annualMax,
    raw: best.raw,
  };
}
