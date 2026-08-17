import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLocation, checkLocationFromText } from "../location.js";
import type { LocationConfig } from "../location.js";

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

const urlCfg: LocationConfig = { ...cfg, rejectRegions: [...(cfg.rejectRegions ?? []), "brazil", "new york"] };

test("checkLocationFromText rejects a foreign region visible only in the job URL (Zoom Brazil leak)", () => {
  const r = checkLocationFromText(
    "Senior Front-End Engineer",
    "Build tools that help agencies focus on meaningful work.",
    urlCfg,
    "https://careers.zoom.us/jobs/senior-front-end-engineer-remote-brazil-baae9adb-7eac",
  );
  assert.deepEqual(r, { accept: false, reason: "geo-rejected-url" });
});

test("checkLocationFromText matches multi-word regions across URL hyphens", () => {
  const r = checkLocationFromText("Engineer", "", urlCfg, "https://x.example/jobs/senior-engineer-new-york-123");
  assert.equal(r.accept, false);
});

test("checkLocationFromText: an in-region signal in the title overrides a foreign URL slug", () => {
  const r = checkLocationFromText("Engineer, Bangalore", "", urlCfg, "https://x.example/jobs/london-team-engineer");
  assert.equal(r.accept, true);
});

test("checkLocationFromText: an in-region signal in the URL itself overrides a foreign slug", () => {
  const r = checkLocationFromText("Engineer", "", urlCfg, "https://x.example/jobs/engineer-london-or-bengaluru");
  assert.equal(r.accept, true);
});

test("checkLocationFromText ignores the URL host (foreign words there are not role locations)", () => {
  const r = checkLocationFromText("Engineer", "Frontend role.", urlCfg, "https://london.example.com/jobs/engineer-42");
  assert.equal(r.accept, true);
});

test("checkLocationFromText still defers when the URL carries no geo signal", () => {
  const r = checkLocationFromText("Engineer", "Frontend role.", urlCfg, "https://x.example/jobs/engineer-42");
  assert.deepEqual(r, { accept: true, reason: "unknown-defer" });
});

test("checkLocationFromText rejects an explicit reject phrase ANYWHERE in the JD, not just the head", () => {
  // Visa/work-authorization boilerplate usually sits past the 2000-char head window the region scan uses.
  const jd = "Great frontend role. " + "We ship fast. ".repeat(200) + "\nApplicants: US only.";
  assert.ok(jd.length > 2500);
  assert.equal(checkLocationFromText("Engineer", jd, cfg).accept, false);
});

test("checkLocationFromText rejects a foreign region on an explicit Location: label line (Confido leak)", () => {
  const r = checkLocationFromText(
    "Senior Frontend Engineer",
    "Location: New York, NY (Relocation supported)\nWe build voice AI used by teams around the world.",
    urlCfg,
  );
  assert.deepEqual(r, { accept: false, reason: "geo-rejected-jd-location" });
});

test("checkLocationFromText: an in-region city on the Location: line overrides the foreign one", () => {
  const r = checkLocationFromText(
    "Engineer",
    "Location: Bengaluru or New York\nJoin our platform team.",
    urlCfg,
  );
  assert.equal(r.accept, true);
});

test("checkLocationFromText: a foreign place in prose (not a Location: label) still does NOT reject", () => {
  const r = checkLocationFromText(
    "Engineer",
    "Our HQ is in New York but this team ships from anywhere.",
    urlCfg,
  );
  assert.equal(r.accept, true);
});
