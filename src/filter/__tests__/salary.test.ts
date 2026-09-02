import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSalary } from "../salary.js";

test("LPA range: 'CTC: 12-18 LPA'", () => {
  const r = extractSalary("CTC: 12-18 LPA");
  assert.ok(r);
  assert.equal(r.currency, "INR");
  assert.equal(r.period, "year");
  assert.equal(r.annualMin, 1_200_000);
  assert.equal(r.annualMax, 1_800_000);
});

test("rupee-symbol range with Indian 2-2-3 comma grouping", () => {
  const r = extractSalary("₹12,00,000 - ₹15,00,000 per annum");
  assert.ok(r);
  assert.equal(r.currency, "INR");
  assert.equal(r.period, "year");
  assert.equal(r.min, 1_200_000);
  assert.equal(r.max, 1_500_000);
  assert.equal(r.annualMin, 1_200_000);
  assert.equal(r.annualMax, 1_500_000);
});

test("USD k-range: 'Salary: $120k-$150k'", () => {
  const r = extractSalary("Salary: $120k-$150k");
  assert.ok(r);
  assert.equal(r.currency, "USD");
  assert.equal(r.period, "year");
  assert.equal(r.min, 120_000);
  assert.equal(r.max, 150_000);
  assert.equal(r.annualMin, 120_000);
  assert.equal(r.annualMax, 150_000);
});

test("hourly rate with pay context annualizes to a plausible figure", () => {
  const r = extractSalary("Compensation details: pay is $25/hr for this role.");
  assert.ok(r);
  assert.equal(r.currency, "USD");
  assert.equal(r.period, "hour");
  assert.equal(r.min, 25);
  assert.equal(r.max, 25);
  assert.equal(r.annualMin, 52_000);
  assert.equal(r.annualMax, 52_000);
});

test("crore range: 'compensation of 1 - 1.5 Cr'", () => {
  const r = extractSalary("We are offering a compensation of 1 - 1.5 Cr for the right candidate.");
  assert.ok(r);
  assert.equal(r.currency, "INR");
  assert.equal(r.period, "year");
  assert.equal(r.annualMin, 10_000_000);
  assert.equal(r.annualMax, 15_000_000);
});

test("bare year range is not a salary", () => {
  assert.equal(extractSalary("Founded in 2024-2026, we are growing fast."), null);
});

test("bare years-of-experience range is not a salary", () => {
  assert.equal(extractSalary("Looking for someone with 5-8 years experience"), null);
});

test("single lakh figure: 'up to 30 lakhs'", () => {
  const r = extractSalary("We offer up to 30 lakhs for the right candidate.");
  assert.ok(r);
  assert.equal(r.currency, "INR");
  assert.equal(r.min, 3_000_000);
  assert.equal(r.max, 3_000_000);
  assert.equal(r.period, "year");
  assert.equal(r.annualMin, 3_000_000);
  assert.equal(r.annualMax, 3_000_000);
});

test("no salary stated returns null", () => {
  const jd = "We are looking for a passionate frontend engineer to join our growing team in Bengaluru.";
  assert.equal(extractSalary(jd), null);
});

test("implausible figure is rejected: '₹50 per year'", () => {
  assert.equal(extractSalary("We pay ₹50 per year, just kidding."), null);
});

test("empty text returns null", () => {
  assert.equal(extractSalary(""), null);
});

// Extra coverage beyond the required table: currency-less k-range needs a nearby context word.
test("currency-less k-range accepted only with a compensation context word nearby", () => {
  const withContext = extractSalary("Compensation for this role: 50k-70k depending on experience.");
  assert.ok(withContext);
  assert.equal(withContext.currency, "INR");
  assert.equal(withContext.min, 50_000);
  assert.equal(withContext.max, 70_000);

  const withoutContext = extractSalary("Team strength grew from 50k-70k users over the year.");
  assert.equal(withoutContext, null);
});

// A requisition id or a "24x7" shift phrase must never be read as a salary figure.
test("ignores requisition ids and shift-hours phrasing", () => {
  assert.equal(extractSalary("Req ID: 20260901. Support required 24x7 for this role."), null);
});

test("prefers a range over a single figure when both are present", () => {
  const jd = "Compensation up to 40 lakhs. CTC band: 25-35 LPA depending on experience.";
  const r = extractSalary(jd);
  assert.ok(r);
  assert.equal(r.annualMin, 2_500_000);
  assert.equal(r.annualMax, 3_500_000);
});
