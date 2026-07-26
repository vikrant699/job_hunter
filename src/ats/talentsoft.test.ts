// src/ats/talentsoft.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  talentsoftListingUrl,
  talentsoftPageUrl,
  talentsoftIdFromUrl,
  talentsoftLocationFromDescItems,
  parseTalentsoftListingHtml,
  normalizeTalentsoftItem,
  extractTalentsoftJdHtml,
} from "./talentsoft.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "talentsoft",
  slug: "credit-agricole-cib",
  name: "Crédit Agricole CIB",
  careersUrl: "https://jobs.ca-cib.com/pages/offre/listeoffre.aspx?mode=list&lcid=2057&facet_Country=96",
  tenantUrl: null,
  apiMeta: null,
};

// --- talentsoftListingUrl / talentsoftPageUrl -----------------------------

test("talentsoftListingUrl prefers tenantUrl over careersUrl", () => {
  const withTenant: AdapterCompany = {
    ...company,
    tenantUrl: "https://jobs.ca-cib.com/pages/offre/listeoffre.aspx?lcid=2057&facet_Country=96",
  };
  const url = talentsoftListingUrl(withTenant);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://jobs.ca-cib.com/pages/offre/listeoffre.aspx");
  assert.equal(u.searchParams.get("lcid"), "2057");
  assert.equal(u.searchParams.get("facet_Country"), "96");
  assert.equal(u.searchParams.get("mode"), "list"); // forced
});

test("talentsoftListingUrl falls back to careersUrl when tenantUrl is null", () => {
  const url = talentsoftListingUrl(company);
  assert.equal(url, company.careersUrl);
});

test("talentsoftListingUrl forces mode=list even if the stored URL carries a different mode", () => {
  const withCardMode: AdapterCompany = {
    ...company,
    tenantUrl: "https://jobs.ca-cib.com/pages/offre/listeoffre.aspx?mode=card&lcid=2057",
  };
  const url = talentsoftListingUrl(withCardMode);
  assert.equal(new URL(url).searchParams.get("mode"), "list");
});

test("talentsoftPageUrl returns the bare URL for page 1", () => {
  assert.equal(talentsoftPageUrl(company.careersUrl, 1), company.careersUrl);
});

test("talentsoftPageUrl appends &page=N for page > 1", () => {
  const url = talentsoftPageUrl(company.careersUrl, 3);
  const u = new URL(url);
  assert.equal(u.searchParams.get("page"), "3");
  assert.equal(u.searchParams.get("lcid"), "2057"); // untouched
  assert.equal(u.searchParams.get("facet_Country"), "96"); // untouched
});

// --- talentsoftIdFromUrl ----------------------------------------------------

test("talentsoftIdFromUrl extracts the trailing numeric id", () => {
  assert.equal(
    talentsoftIdFromUrl("https://jobs.ca-cib.com/job/job-caspl-head-of-trade-finance_114086.aspx"),
    "114086",
  );
  assert.equal(talentsoftIdFromUrl("/job/job-trainee_113040.aspx"), "113040");
});

test("talentsoftIdFromUrl returns null for a URL that doesn't match the shape", () => {
  assert.equal(talentsoftIdFromUrl("https://jobs.ca-cib.com/pages/accueil.aspx"), null);
});

test("talentsoftIdFromUrl ignores a trailing query string", () => {
  assert.equal(talentsoftIdFromUrl("/job/job-trainee_113040.aspx?lcid=2057"), "113040");
});

// --- talentsoftLocationFromDescItems ---------------------------------------

test("talentsoftLocationFromDescItems joins the last two of three entries as city, country", () => {
  assert.equal(talentsoftLocationFromDescItems(["Permanent Contract", "India", "MUMBAI "]), "MUMBAI, India");
});

test("talentsoftLocationFromDescItems handles a single entry", () => {
  assert.equal(talentsoftLocationFromDescItems(["Remote"]), "Remote");
});

test("talentsoftLocationFromDescItems returns null for no entries", () => {
  assert.equal(talentsoftLocationFromDescItems([]), null);
});

// --- parseTalentsoftListingHtml: real listing markup -----------------------

// Trimmed excerpt of the real listing page (GET jobs.ca-cib.com/pages/offre/
// listeoffre.aspx?mode=list&lcid=2057&facet_Country=96) — two full
// `.ts-offer-list-item` cards plus the `.ts-ol-pagination__title.resultat`
// count block, matching what the integrator verified live.
const REAL_LISTING_HTML = `<!doctype html><html><body>
<div id="main" class="ts-related-offers listing-offres">
<a id="offercontent" name="listoffre"></a>
<ul class="ts-related-offers__row">
    <li class="ts-offer-list-item offerlist-item " title="" onclick="location.href='/job/job-caspl-head-of-trade-finance_114086.aspx';">
        <h3 class="ts-offer-list-item__title styleh3">
            <a class="ts-offer-list-item__title-link "
               href="/job/job-caspl-head-of-trade-finance_114086.aspx"
               title="2026-114086">
                CASPL Head of Trade Finance
            </a>
        </h3>
        <span class="ts-offer-list-item-favorite-link ts-offer-list-item-favorite-link--unselected lienfavori"
              data-reference="2026-114086"></span>
        <ul class="ts-offer-list-item__description ">
            <li>Permanent Contract</li><li>India</li><li class="noBorder">MUMBAI </li>
        </ul>
    </li>
    <li class="ts-offer-list-item offerlist-item " title="" onclick="location.href='/job/job-trainee_113040.aspx';">
        <h3 class="ts-offer-list-item__title styleh3">
            <a class="ts-offer-list-item__title-link "
               href="/job/job-trainee_113040.aspx"
               title="2026-113040">
                Trainee
            </a>
        </h3>
        <span class="ts-offer-list-item-favorite-link ts-offer-list-item-favorite-link--unselected lienfavori"
              data-reference="2026-113040"></span>
        <ul class="ts-offer-list-item__description ">
            <li>Internship/Trainee</li><li>India</li><li class="noBorder">Mumbai</li>
        </ul>
    </li>
</ul>
</div>
<div class="ts-ol-pagination__title resultat">
    Number of results:
    <span id="ctl00_ctl00_corpsRoot_corps_Pagination_TotalOffers" class="gras">10 vacancy(s)</span>&nbsp;
</div>
</body></html>`;

test("parseTalentsoftListingHtml extracts title/location/id/url for each card", () => {
  const { items, total } = parseTalentsoftListingHtml(REAL_LISTING_HTML, company.careersUrl);
  assert.equal(items.length, 2);

  assert.equal(at(items, 0).externalId, "114086");
  assert.equal(at(items, 0).jobTitle, "CASPL Head of Trade Finance");
  assert.equal(at(items, 0).jobUrl, "https://jobs.ca-cib.com/job/job-caspl-head-of-trade-finance_114086.aspx");
  assert.equal(at(items, 0).location, "MUMBAI, India");

  assert.equal(at(items, 1).externalId, "113040");
  assert.equal(at(items, 1).jobTitle, "Trainee");
  assert.equal(at(items, 1).location, "Mumbai, India");

  assert.equal(total, 10);
});

test("parseTalentsoftListingHtml skips a card with no href/title and dedups by id", () => {
  const html = `<li class="ts-offer-list-item"><h3 class="ts-offer-list-item__title"><a class="ts-offer-list-item__title-link"></a></h3></li>
  <li class="ts-offer-list-item"><h3 class="ts-offer-list-item__title"><a class="ts-offer-list-item__title-link" href="/job/job-x_1.aspx">X</a></h3></li>
  <li class="ts-offer-list-item"><h3 class="ts-offer-list-item__title"><a class="ts-offer-list-item__title-link" href="/job/job-x-dup_1.aspx">X dup</a></h3></li>`;
  const { items } = parseTalentsoftListingHtml(html, company.careersUrl);
  assert.equal(items.length, 1);
  assert.equal(at(items, 0).jobTitle, "X");
});

test("parseTalentsoftListingHtml returns total null when the count block is absent", () => {
  const { total } = parseTalentsoftListingHtml("<html><body>no jobs here</body></html>", company.careersUrl);
  assert.equal(total, null);
});

// --- normalizeTalentsoftItem -------------------------------------------------

test("normalizeTalentsoftItem builds a posting and flags remote via REMOTE_RE", () => {
  const { items } = parseTalentsoftListingHtml(REAL_LISTING_HTML, company.careersUrl);
  const p = normalizeTalentsoftItem(company, at(items, 0));
  assert.equal(p.provider, "talentsoft");
  assert.equal(p.externalId, "114086");
  assert.equal(p.jobTitle, "CASPL Head of Trade Finance");
  assert.equal(p.location, "MUMBAI, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");

  const remote = normalizeTalentsoftItem(company, { ...at(items, 0), location: "Remote, India" });
  assert.equal(remote.isRemote, true);
});

// --- extractTalentsoftJdHtml: real detail-page markup -----------------------

// Trimmed excerpt of the real detail page (GET jobs.ca-cib.com/job/job-caspl-
// head-of-trade-finance_114086.aspx) — the "General information" block (must
// be EXCLUDED), the "Job description" section (must be INCLUDED), and the
// start of "Position location" (must be EXCLUDED) — matching the boundary
// the integrator verified live.
const REAL_DETAIL_HTML = `<!doctype html><html><body>
<div class="ts-offer-page__content-details" id="contenu-ficheoffre" data-class="ts-offer-details-content">
    <h2>General information</h2>
    <div id="ctl00_ctl00_corpsRoot_corps_composantDetailOffre_entityBlock">
        <div class="ts-offer-page__entity-description">
            <h3>Entity</h3>
            About Crédit Agricole Corporate and Investment Bank (Crédit Agricole CIB) <br/><br/>We support major companies and financial institutions.
        </div>
        <div class="ts-offer-page__reference">
            <h3>Reference</h3>
            2026-114086&nbsp;&nbsp;
        </div>
    </div><h2 class="JobDescription">Job description</h2><h3>
	Business type
</h3><p id="fldjobdescription_primaryprofile">Types of Jobs - Operations</p><h3>
	Job summary
</h3><div id="fldjobdescription_description1" class="RichText_viewer_fo">
	<p><p>Ensure the provision of efficient, timely and error-free processing services to the client entities.</p></p>
</div><h2 class="Location">Position location</h2><h3>
	Geographical area
</h3><p id="fldlocation_location_geographicalareacoll">India</p>
</div>
</body></html>`;

test("extractTalentsoftJdHtml includes only the Job description section", () => {
  const jd = extractTalentsoftJdHtml(REAL_DETAIL_HTML);
  assert.match(jd, /Business type/);
  assert.match(jd, /Types of Jobs - Operations/);
  assert.match(jd, /error-free processing services/);
});

test("extractTalentsoftJdHtml excludes the General information block before it", () => {
  const jd = extractTalentsoftJdHtml(REAL_DETAIL_HTML);
  assert.doesNotMatch(jd, /About Crédit Agricole Corporate/);
  assert.doesNotMatch(jd, /2026-114086/);
});

test("extractTalentsoftJdHtml excludes the Position location section after it", () => {
  const jd = extractTalentsoftJdHtml(REAL_DETAIL_HTML);
  assert.doesNotMatch(jd, /Geographical area/);
});

test("extractTalentsoftJdHtml strips HTML tags to plain text", () => {
  const jd = extractTalentsoftJdHtml(REAL_DETAIL_HTML);
  assert.doesNotMatch(jd, /<[a-z][\s\S]*>/i);
});

test("extractTalentsoftJdHtml falls back to the whole details container when the JobDescription heading is absent", () => {
  const html = `<div id="contenu-ficheoffre"><p>Some other theme's JD content</p></div>`;
  const jd = extractTalentsoftJdHtml(html);
  assert.match(jd, /Some other theme's JD content/);
});
