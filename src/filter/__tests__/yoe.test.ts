import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatedYoeMin } from "../yoe.js";

test("parses the common '+ years' forms", () => {
  assert.equal(parseStatedYoeMin("8+ years of professional software development experience"), 8);
  assert.equal(parseStatedYoeMin("5 + years of experience"), 5);
  assert.equal(parseStatedYoeMin("Minimum 7 years of relevant experience"), 7);
  assert.equal(parseStatedYoeMin("At least 6 years of experience building web apps"), 6);
  assert.equal(parseStatedYoeMin("7 yrs+ experience"), 7);
});

test("takes the LOW end of a range, which is the actual entry bar", () => {
  assert.equal(parseStatedYoeMin("3-5 years of experience"), 3);
  assert.equal(parseStatedYoeMin("8 to 10 years of experience"), 8);
  assert.equal(parseStatedYoeMin("between 4 and 7 years of experience"), 4);
});

// Multiple stated minimums are separate requirements, not a stacked bar - the entry bar is the smallest one.
test("takes the smallest minimum when a JD states several", () => {
  assert.equal(
    parseStatedYoeMin("- 3+ years of non-internship professional software development experience\n- 2+ years of design or architecture experience"),
    2,
  );
  assert.equal(parseStatedYoeMin("10+ years leading teams; 4+ years writing code"), 4);
});

test("returns null when no experience requirement is stated", () => {
  assert.equal(parseStatedYoeMin("We are looking for a passionate engineer to join us"), null);
  assert.equal(parseStatedYoeMin(""), null);
  assert.equal(parseStatedYoeMin("Experience with React and TypeScript"), null);
});

test("ignores numbers that are not years of experience", () => {
  // Founded/copyright years, team sizes, salary, and product versions all put bare numbers near "years".
  assert.equal(parseStatedYoeMin("Founded in 2019, we serve 10 million customers"), null);
  assert.equal(parseStatedYoeMin("© 2026 Acme Corp. All rights reserved."), null);
  assert.equal(parseStatedYoeMin("A team of 12 engineers"), null);
  assert.equal(parseStatedYoeMin("Salary 15-20 LPA"), null);
});

test("ignores implausible year counts", () => {
  assert.equal(parseStatedYoeMin("2026 years of experience"), null);
  assert.equal(parseStatedYoeMin("0 years of experience"), null);
});

// "years of age", tenure and company-age phrasing are not candidate experience.
test("ignores 'years' that describe something other than the candidate", () => {
  assert.equal(parseStatedYoeMin("must be 18 years of age"), null);
  assert.equal(parseStatedYoeMin("We have been in business for 30 years"), null);
});

test("reads the real Amazon PayUI and Tez qualification blocks", () => {
  assert.equal(
    parseStatedYoeMin("Basic qualifications:\n- 1+ years of non-internship professional software development experience- Experience programming with at least one software programming language"),
    1,
  );
  assert.equal(
    parseStatedYoeMin("Basic qualifications:\n- 3+ years of non-internship professional software development experience- 2+ years of non-internship design or architecture (design patterns, reliability and scaling) of new and existing systems experience"),
    2,
  );
});
