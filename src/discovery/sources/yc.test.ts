import { test } from "node:test";
import assert from "node:assert/strict";
import { extractYcWebsite } from "./yc.js";

test("extractYcWebsite picks the most-frequent external non-social host", () => {
  const html = `
    <a href="https://www.ycombinator.com/companies/dyte">YC</a>
    <a href="https://dyte.io">Logo</a>
    <a href="https://dyte.io/about">Visit website</a>
    <a href="https://www.dyte.io/blog">Blog</a>
    <a href="https://twitter.com/dyte">Twitter</a>
    <a href="https://www.linkedin.com/company/dyte">LinkedIn</a>
    <a href="https://github.com/dyte-io">GitHub</a>
  `;
  assert.equal(extractYcWebsite(html), "https://dyte.io");
});

test("extractYcWebsite ignores social/YC/asset hosts and returns null when no real site", () => {
  const html = `
    <a href="https://www.ycombinator.com/companies/x">YC</a>
    <a href="https://twitter.com/x">Twitter</a>
    <a href="https://www.linkedin.com/company/x">LinkedIn</a>
    <a href="https://www.workatastartup.com/companies/x">Jobs</a>
  `;
  assert.equal(extractYcWebsite(html), null);
});

test("extractYcWebsite handles a domain that differs from the YC slug", () => {
  // slug 'binks' but real site getbinks.com — the fabricated <slug>.com would be wrong.
  const html = `
    <a href="https://getbinks.com">Home</a>
    <a href="https://getbinks.com/product">Product</a>
    <a href="https://twitter.com/binks">x</a>
  `;
  assert.equal(extractYcWebsite(html), "https://getbinks.com");
});
