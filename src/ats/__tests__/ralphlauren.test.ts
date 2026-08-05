import { test } from "node:test";
import assert from "node:assert/strict";
import { indiaCityFromLatlon, ralphLaurenDetailLocation } from "../ralphlauren.js";

// Avature's job-detail page carries the true location as labelled fields in the
// first `article--details` block (verified live 2026-07-25 on jobId 64715 /
// 57886). The list API only gives lat/lon and dumps many jobs into an
// ungeocoded "," bucket, so this is the only place a real location exists for
// them — without it a Hong Kong role reaches the LLM gate as "unknown-defer".
const DETAIL_HTML = `
<article class="article article--details">
  <div class="article__content__view">
    <div class="article__content__view__field">
      <div class="article__content__view__field__label"> Ref # </div>
      <div class="article__content__view__field__value"> W175976 </div>
    </div>
    <div class="article__content__view__field">
      <div class="article__content__view__field__label"> State/Region </div>
      <div class="article__content__view__field__value"> Kowloon </div>
    </div>
    <div class="article__content__view__field">
      <div class="article__content__view__field__label"> Department </div>
      <div class="article__content__view__field__value"> Merchandising &amp; Planning </div>
    </div>
    <div class="article__content__view__field">
      <div class="article__content__view__field__label"> Location </div>
      <div class="article__content__view__field__value"> Hong Kong SAR </div>
    </div>
    <div class="article__content__view__field">
      <div class="article__content__view__field__label"> City </div>
      <div class="article__content__view__field__value"> Tsim Sha Tsui </div>
    </div>
  </div>
</article>`;

test("indiaCityFromLatlon maps Bangalore coords to a city string", () => {
  assert.equal(indiaCityFromLatlon("12.9716,77.5946"), "Bengaluru, India");
});

test("indiaCityFromLatlon returns 'India' for other in-box coords", () => {
  assert.equal(indiaCityFromLatlon("28.6139,77.2090"), "India"); // Delhi
});

test("indiaCityFromLatlon rejects foreign coords", () => {
  assert.equal(indiaCityFromLatlon("40.7128,-74.0060"), null); // NYC
  assert.equal(indiaCityFromLatlon("51.5099,-0.1413"), null); // London
});

test("indiaCityFromLatlon returns null for empty / ungeocoded", () => {
  assert.equal(indiaCityFromLatlon(""), null);
  assert.equal(indiaCityFromLatlon(","), null);
  assert.equal(indiaCityFromLatlon(null), null);
  assert.equal(indiaCityFromLatlon(undefined), null);
});

test("ralphLaurenDetailLocation builds city, region, country from the detail fields", () => {
  assert.equal(ralphLaurenDetailLocation(DETAIL_HTML), "Tsim Sha Tsui, Kowloon, Hong Kong SAR");
});

test("ralphLaurenDetailLocation reads an India posting's fields", () => {
  const html = DETAIL_HTML
    .replace("Kowloon", "Karnataka")
    .replace("Hong Kong SAR", "India")
    .replace("Tsim Sha Tsui", "Bangalore");
  assert.equal(ralphLaurenDetailLocation(html), "Bangalore, Karnataka, India");
});

test("ralphLaurenDetailLocation skips absent fields rather than emitting empties", () => {
  const html = `
<article class="article article--details">
  <div class="article__content__view">
    <div class="article__content__view__field">
      <div class="article__content__view__field__label"> Location </div>
      <div class="article__content__view__field__value"> India </div>
    </div>
  </div>
</article>`;
  assert.equal(ralphLaurenDetailLocation(html), "India");
});

test("ralphLaurenDetailLocation returns null when the page has no location fields", () => {
  assert.equal(ralphLaurenDetailLocation("<article class='article--details'><p>No fields</p></article>"), null);
  assert.equal(ralphLaurenDetailLocation(""), null);
});
