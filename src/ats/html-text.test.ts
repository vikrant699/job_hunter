// src/ats/html-text.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, decodeNumericEntities } from "./html-text.js";

test("htmlToText strips tags, decodes entities, collapses whitespace", () => {
  const html = "<div><p>Senior&nbsp;Engineer &amp; Lead</p><ul><li>Build&#39;n&#39;ship</li></ul></div>";
  assert.equal(htmlToText(html), "Senior Engineer & Lead\nBuild'n'ship");
});

test("htmlToText drops script/style blocks entirely", () => {
  const html = "<style>p{color:red}</style><p>Role</p><script>var x = '<b>hi</b>';</script>";
  assert.equal(htmlToText(html), "Role");
});

test("htmlToText returns empty string for null/undefined/empty", () => {
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
  assert.equal(htmlToText(""), "");
});

test("decodeNumericEntities decodes decimal and hex forms", () => {
  assert.equal(decodeNumericEntities("A&#66;&#x43;"), "ABC");
});

test("decodeNumericEntities survives astral code points (emoji)", () => {
  assert.equal(decodeNumericEntities("Perks &#x1F600; &#128512;"), "Perks 😀 😀");
});

test("decodeNumericEntities passes malformed/out-of-range entities through", () => {
  assert.equal(decodeNumericEntities("&#99999999; stays"), "&#99999999; stays");
});
