import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLocation, checkLocationFromText, type LocationConfig } from "./location.js";

const cfg: LocationConfig = {
  targetCities: ["bangalore", "bengaluru", "mumbai", "pune"],
  targetCountryHints: ["india", "in,"],
  remoteAcceptStrings: ["remote - india", "remote india"],
  rejectIfPresent: ["us only", "remote - united states"],
  rejectRegions: ["sydney", "melbourne", "nsw", "vic", "paris", "chicago", "los angeles", "seattle", "san francisco", "london", "singapore"],
};

test("checkLocation accepts an in-region city", () => {
  assert.equal(checkLocation("Bengaluru, India", false, cfg).accept, true);
});

test("checkLocation rejects an out-of-region city", () => {
  assert.equal(checkLocation("Sydney, Australia", false, cfg).accept, false);
});

test("checkLocation rejects on an explicit reject phrase", () => {
  assert.equal(checkLocation("Remote - United States", false, cfg).accept, false);
});

test("checkLocation accepts a multi-location posting when an in-region city is also listed", () => {
  // foreign + in-region in the same metadata field → in-region wins (recall guard)
  assert.equal(checkLocation("Bengaluru, India; Seattle, WA", false, cfg).accept, true);
  assert.equal(checkLocation("Sydney, Australia | Pune, India", false, cfg).accept, true);
});

test("checkLocation still rejects multi-location postings that are all foreign", () => {
  assert.equal(checkLocation("Sydney, NSW; London, UK", false, cfg).accept, false);
});

test("checkLocation: explicit reject phrase wins even next to an in-region city", () => {
  assert.equal(checkLocation("Bengaluru preferred, US only", false, cfg).accept, false);
});

test("checkLocationFromText rejects a foreign place embedded in the TITLE (DoorDash leak)", () => {
  const r = checkLocationFromText("Data Scientist Sydney, NSW; Melbourne, VIC", "We deliver food.", cfg);
  assert.equal(r.accept, false);
});

test("checkLocationFromText rejects US cities in the title", () => {
  const r = checkLocationFromText("Senior Associate, DashMart Chicago, IL; Los Angeles, CA; Seattle, WA", "", cfg);
  assert.equal(r.accept, false);
});

test("checkLocationFromText rejects 'Paris Office' in the title", () => {
  assert.equal(checkLocationFromText("ML Engineer, AI for Robotics - Paris Office", "", cfg).accept, false);
});

test("checkLocationFromText accepts when the title names an in-region city", () => {
  assert.equal(checkLocationFromText("Data Analyst, Bangalore", "", cfg).accept, true);
});

test("checkLocationFromText is recall-safe: a foreign HQ mention in the JD body does NOT reject", () => {
  const r = checkLocationFromText(
    "Senior Data Analyst",
    "Headquartered in San Francisco, we serve millions. This role is in our Bangalore office.",
    cfg,
  );
  assert.equal(r.accept, true);
});

test("checkLocationFromText accepts a dual-location title when an in-region city is also named", () => {
  // foreign + in-region in the same title → in-region wins (recall guard)
  const r = checkLocationFromText("Senior Data Analyst, Singapore / Bangalore", "", cfg);
  assert.equal(r.accept, true);
});

test("checkLocationFromText defers (accepts) when there is no location signal anywhere", () => {
  const r = checkLocationFromText("Data Analyst", "Join our analytics team and build dashboards.", cfg);
  assert.equal(r.accept, true);
  assert.equal(r.reason, "unknown-defer");
});

test("checkLocationFromText rejects an explicit reject phrase in the JD body", () => {
  assert.equal(checkLocationFromText("Analyst", "This role is US only.", cfg).accept, false);
});

test("checkLocationFromText tolerates a missing rejectRegions field", () => {
  const noRegions: LocationConfig = { ...cfg, rejectRegions: undefined };
  // Sydney in title but no rejectRegions configured → falls through to defer (no crash)
  assert.equal(checkLocationFromText("Data Scientist Sydney", "", noRegions).accept, true);
});
