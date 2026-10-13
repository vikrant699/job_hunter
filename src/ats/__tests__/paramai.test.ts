import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeParamAi, paramAiJobUrl } from "../paramai.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "paramai",
  slug: "sharafdg",
  name: "Sharaf DG",
  careersUrl: "https://sharafdg.app.param.ai/careers",
  tenantUrl: null,
  apiMeta: null,
};

test("job url uses /jobs/<slug> (the /careers/<slug> path 404s on every tenant)", () => {
  const u = paramAiJobUrl("sharafdg", "senior-front-end-developer-141");
  assert.equal(u, "https://sharafdg.app.param.ai/jobs/senior-front-end-developer-141");
  assert.ok(!u.includes("/careers/"));
});

test("falls back to the /jobs/ listing when the slug is missing", () => {
  assert.equal(paramAiJobUrl("sharafdg", null), "https://sharafdg.app.param.ai/jobs/");
  assert.equal(paramAiJobUrl("sharafdg", undefined), "https://sharafdg.app.param.ai/jobs/");
});

test("normalizeParamAi wires the /jobs url and joins locations", () => {
  const p = normalizeParamAi(company, "sharafdg", {
    id: "f4486ac6",
    title: "Senior Front-end Developer",
    slug: "senior-front-end-developer-141",
    locations: ["Hyderabad ", ""],
    description: "<p>About</p>",
    created_at: "2026-09-02T00:00:00Z",
  });
  assert.equal(p.jobUrl, "https://sharafdg.app.param.ai/jobs/senior-front-end-developer-141");
  assert.equal(p.location, "Hyderabad");
  assert.equal(p.externalId, "f4486ac6");
});

test("apiMeta.country tags each bare town so an India-only tenant's Kharkhoda/Manesar roles stay in region", () => {
  const maruti: AdapterCompany = { ...company, slug: "maruti-suzuki-india", apiMeta: { subdomain: "maruti", country: "India" } };
  const job = { id: "1", title: "Buyer", slug: "buyer", locations: ["Kharkhoda", "Manesar ", "Pan-India"] };
  assert.equal(normalizeParamAi(maruti, "maruti", job).location, "Kharkhoda, India; Manesar, India; Pan-India");
  assert.equal(normalizeParamAi(company, "sharafdg", job).location, "Kharkhoda; Manesar; Pan-India");
});
