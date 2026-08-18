// ANANSI Lab scraper — hand-authored for Bright Data Scraper Studio (Rule 5:
// a custom Scraper Studio scraper is mandatory; library-only disqualifies).
//
// Paste the two sections into the Scraper Studio IDE (interaction code +
// parser code). Verify the exact function signatures against the IDE's
// functions reference during the hour-one smoke test — the load-bearing
// requirements, from docs/brightdata-notes.md, are:
//   1. tag_html() runs on EVERY page load (snapshot source for the diff
//      pipeline). Tagged values reach parser code only — the parser MUST
//      explicitly collect() the snapshot into an output field, or ANANSI
//      never sees it.
//   2. input.url is collected on every row so heal preview rows are
//      attributable to a canary (heal's --url is cosmetic; preview_result is
//      backend-chosen sample rows).
//   3. dead_page semantics: a 404 marks the URL dead — never heal, never spend.
//   4. Contract-shaped validation is pushed into collect() so hard breakage
//      fails loudly at the platform layer too.

// ─── Interaction code ────────────────────────────────────────────────────────

navigate(input.url);

// Snapshot the full DOM for ANANSI's diff pipeline. Tag on every run, before
// any waits can fail — a broken page's snapshot is the evidence.
tag_html('page_html');

// The price block is the scrape target; M3 (cookie wall) makes this wait time
// out, which is exactly the signal ANANSI expects (wait_element_timeout →
// heal lane; the correct heal adds close_popup(), not a selector swap).
wait('.price-block', { timeout: 15000 });

collect(parse());

// ─── Parser code ─────────────────────────────────────────────────────────────

const priceText = (sel) => {
  const el = $(sel).first();
  if (!el.length) return null;
  const m = el.text().replace(/[^0-9.]/g, '');
  return m ? parseFloat(m) : null;
};

const first = (sel) => {
  const el = $(sel).first();
  return el.length ? el.text().trim() : null;
};

const data = {
  // Attribution + snapshot: the two fields ANANSI cannot live without.
  url: input.url,
  _snapshot_html: html, // the tag_html('page_html') capture

  title: first('h1.title'),
  // Deliberately the naive selector: first .price on the page. M1 nulls it,
  // M2 makes it silently wrong ($12.99 cross-sell) — that's the demo.
  price: priceText('.price'),
  // .price is what the customer pays (and what every golden pins); .was is the
  // struck-through ORIGINAL. Collecting .was here would break the contract
  // invariant `sale_price <= price` on every discounted canary — the Lab's
  // aurora-lamp shows .price $29.99 over .was $34.50 — so a sale is described
  // by price alone until the contract gains a list_price field.
  sale_price: null,
  availability: first('.availability'),
};

// Contract-shaped validation at the platform layer: null required fields are
// a parse failure, not a quiet null row.
collect(data, (row) => {
  if (!row.title || row.title.length < 3) return 'title missing';
  if (row.price == null || row.price <= 0) return 'price missing';
  if (!row.availability) return 'availability missing';
  return true;
});
