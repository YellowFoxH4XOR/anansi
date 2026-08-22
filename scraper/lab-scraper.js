// ANANSI Lab product-page scraper for Bright Data Scraper Studio.
//
// Paste the two sections below into the Scraper Studio IDE. Signatures verified
// against docs.brightdata.com/datasets/scraper-studio/functions.
//
// WORKER: this scraper needs the Browser worker. tag_html() and wait()
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
//   4. NO validate_fn on collect(). See the interaction code for why: a
//      throwing validator makes Studio discard the whole record, snapshot
//      included, which is fatal to the heal loop.
//
// OUTPUT SCHEMA: parser output is NOT the production payload. The schema
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

// The price block is the scrape target. If page interaction prevents it from
// appearing, Studio emits wait_element_timeout and ANANSI routes it to diagnosis.
wait('.price-block', { timeout: 15000 });

// Collected unconditionally, with NO validate_fn.
//
// A validate_fn that throws makes Scraper Studio discard the entire record and
// emit only system fields — no title, no price, and critically no page_html.
// On a renamed .price that is precisely backwards: the scenario the
// heal loop exists for arrives as an empty row, so Diagnose has no DOM to diff
// and the collector quarantines without ever attempting a heal. Observed live
// as incident 9708ba89.
//
// ANANSI's contract engine (core/sense/contract.ts) is the authority on field
// validity, and it needs to SEE the null to act on it. The scraper's job is to
// report what the page showed, nulls included.
collect(parse());

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
  // Deliberately the naive selector: the first .price on the page. Controlled
  // mutations can make it null or point it at a plausible wrong value.
  price: priceNumber('.price'),
  // .price is what the customer pays (and what every golden pins); .was is the
  // struck-through ORIGINAL. Collecting .was here would break the contract
  // invariant `sale_price <= price` on every discounted canary — the Lab's
  // aurora-lamp shows .price $29.99 over .was $34.50 — so a sale is described
  // by price alone until the contract gains a list_price field.
  sale_price: null,
  availability: firstText('.availability'),
};
