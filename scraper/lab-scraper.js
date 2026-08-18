// ANANSI Lab scraper — hand-authored for Bright Data Scraper Studio (Rule 5:
// a custom Scraper Studio scraper is mandatory; library-only disqualifies).
//
// Paste the two sections below into the Scraper Studio IDE. Signatures verified
// against docs.brightdata.com/datasets/scraper-studio/functions.
//
// ⚠ WORKER: this scraper needs the **Browser worker**. tag_html() and wait()
// are both browser-only and throw on a Code worker.
//
// Load-bearing requirements, from docs/brightdata-notes.md:
//   1. tag_html() runs on EVERY page load (snapshot source for the diff
//      pipeline). Scraper Studio surfaces the tag under its own name, so the
//      run output carries `page_html` (plus an auto-added `page_html_url`)
//      without the parser having to return it. Verified against a live run.
//   2. input.url is returned on every row so heal preview rows are
//      attributable to a canary (heal's --url is cosmetic; preview_result is
//      backend-chosen sample rows).
//   3. dead_page semantics: navigate() throws dead_page on 404 by default —
//      never heal, never spend.
//   4. Contract-shaped validation is pushed into collect()'s validate_fn so
//      hard breakage fails loudly at the platform layer too. The callback
//      THROWS on invalid data (it does not return an error string).
//
// Division of labour, per the functions reference: parse() and collect() are
// INTERACTION functions. Parser code returns a record; interaction code
// collects it. Do not call collect() from parser code.

// ─── Interaction code ────────────────────────────────────────────────────────

navigate(input.url);

// Snapshot the full DOM for ANANSI's diff pipeline, before any wait can throw.
tag_html('page_html');

// The price block is the scrape target; M3 (cookie wall) makes this wait time
// out, which is exactly the signal ANANSI expects (wait_element_timeout →
// heal lane; the correct heal adds close_popup(), not a selector swap).
wait('.price-block', { timeout: 15000 });

// validate_fn throws on invalid data, so a null required field surfaces as a
// platform-level parse failure rather than a quiet null row.
collect(parse(), (row) => {
  if (!row.title || row.title.length < 3) throw new Error('title missing');
  if (row.price == null || row.price <= 0) throw new Error('price missing');
  if (!row.availability) throw new Error('availability missing');
});

// ─── Parser code ─────────────────────────────────────────────────────────────

const priceNumber = (sel) => {
  const el = $(sel).first();
  if (!el.length) return null;
  const digits = el.text().replace(/[^0-9.]/g, '');
  return digits ? parseFloat(digits) : null;
};

const firstText = (sel) => {
  const el = $(sel).first();
  return el.length ? el.text().trim() : null;
};

return {
  // Attribution: heal preview rows are useless without it.
  url: input.url,
  // NOTE: the DOM snapshot is NOT returned here. tag_html('page_html') above
  // already puts `page_html` in the output; returning a second copy under
  // another name only risks the output schema dropping it (it did).
  title: firstText('h1.title'),
  // Deliberately the naive selector: first .price on the page. M1 nulls it,
  // M2 makes it silently wrong ($12.99 cross-sell) — that's the demo.
  price: priceNumber('.price'),
  // .price is what the customer pays (and what every golden pins); .was is the
  // struck-through ORIGINAL. Collecting .was here would break the contract
  // invariant `sale_price <= price` on every discounted canary — the Lab's
  // aurora-lamp shows .price $29.99 over .was $34.50 — so a sale is described
  // by price alone until the contract gains a list_price field.
  sale_price: null,
  availability: firstText('.availability'),
};
