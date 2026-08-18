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
//      pipeline). Parser code reads the tag as `parser.page_html`, and the
//      parser must RETURN it so the field exists in the collected object.
//      A returned field still only reaches production output if the OUTPUT
//      SCHEMA declares it — the schema drops undeclared fields silently.
//   2. input.url is returned on every row so heal preview rows are
//      attributable to a canary (heal's --url is cosmetic; preview_result is
//      backend-chosen sample rows).
//   3. dead_page semantics: navigate() throws dead_page on 404 by default —
//      never heal, never spend.
//   4. Contract-shaped validation is pushed into collect()'s validate_fn so
//      hard breakage fails loudly at the platform layer too. The callback
//      THROWS on invalid data (it does not return an error string).
//
// ⚠ OUTPUT SCHEMA: parser output is NOT the production payload. The schema
// renames, retypes and drops fields, and it is only applied on Save to
// Production. The generated schema shipped `product_title` and a `price` typed
// as price/raw, which is why production returned
// {"value":49.99,"currency":"USD"} while preview looked correct. The schema
// must declare exactly: url (text), title (text), price (NUMBER, not price),
// sale_price (number), availability (text), page_html (text).

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
  // The DOM snapshot ANANSI diffs against. Returned explicitly so the output
  // schema can declare it; without a matching schema field it is dropped.
  page_html: parser.page_html,
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
