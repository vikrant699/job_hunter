import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyKey } from "../dedup.js";

test("same company+title+location → same key (case/space-insensitive)", () => {
  assert.equal(
    notifyKey("3M India", "Shopper Marketer", "IN, Bangalore Kar"),
    notifyKey("3m india", "  shopper   marketer ", "in, bangalore kar"),
  );
});

test("different location → different key (multi-city opening stays separate)", () => {
  assert.notEqual(
    notifyKey("Bosch", "Senior_AI_developer", "bangalore, IN"),
    notifyKey("Bosch", "Senior_AI_developer", "pune, IN"),
  );
});

test("different title → different key", () => {
  assert.notEqual(
    notifyKey("Stripe", "Data Analyst", "Bengaluru"),
    notifyKey("Stripe", "Payments Analyst", "Bengaluru"),
  );
});

test("null title and location are handled without throwing", () => {
  assert.equal(notifyKey("Acme", null, null), "acme||");
});
