import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { kebabCase, resolveSlug } from "./slug.js";

describe("kebabCase", () => {
  it('converts "Acme Corp!" to "acme-corp"', () => {
    assert.strictEqual(kebabCase("Acme Corp!"), "acme-corp");
  });
  it('strips leading/trailing dashes from "  --Foo  Bar--  "', () => {
    assert.strictEqual(kebabCase("  --Foo  Bar--  "), "foo-bar");
  });
  it('converts slashes and dots in "a/b.c" to "a-b-c"', () => {
    assert.strictEqual(kebabCase("a/b.c"), "a-b-c");
  });
});

describe("resolveSlug", () => {
  it("returns source_slug when provided", () => {
    assert.strictEqual(
      resolveSlug({ name: "Acme Corp", source_slug: "acme-x" }),
      "acme-x",
    );
  });
  it("falls back to kebabCase(name) when source_slug is absent", () => {
    assert.strictEqual(resolveSlug({ name: "Acme Corp" }), "acme-corp");
  });
  it("falls back to kebabCase(name) when source_slug is empty string", () => {
    assert.strictEqual(resolveSlug({ name: "X", source_slug: "" }), "x");
  });
});
