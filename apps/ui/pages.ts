// Server-rendered storefront pages. No client framework — mutations are just
// different HTML from the same renderer, keyed off the current mutation state.
//
// DOM CONTRACT (do not break - the scraper, the diff pipeline, and tests
// depend on these exact bytes):
//   - <span class="price">$NN.NN</span>
//   - div.price-block wrapping the price on product pages (scraper wait target)
//   - .card[data-sku] on the listing, .product[data-sku] on product pages
//   - h1.title / .availability with exact "in stock" | "out of stock" text
//   - control links are exactly /__control?mutate=<id>
// Everything else on these pages is decoration: baseline vs mutated renders
// must differ ONLY by the mutation itself (the diff pipeline diffs them).

export type Mutation =
  | "none"
  | "cardrename"
  | "paginate"
  | "jslinks";

export const MUTATIONS: {
  id: Mutation;
  tag: string; // short chip shown on the control panel
  name: string; // display name for the control-panel row
  series: "reset" | "L";
  blurb: string;
  expect: string; // the one-line expected ANANSI response
}[] = [
  {
    id: "none",
    tag: "R",
    name: "Baseline",
    series: "reset",
    blurb: "Healthy storefront, all selectors stable.",
    expect: "next sweep passes all five signals — fleet returns to HEALTHY.",
  },
  {
    id: "cardrename",
    tag: "L1",
    name: "Listing tile renamed",
    series: "L",
    blurb: ".card becomes .product-tile on the index. The product pages are untouched and every selector on them still works.",
    expect: "discovery finds zero links, so stage 2 never runs. The job reports SUCCESS with 0 rows — the run that collected nothing looks like the run that had nothing to collect.",
  },
  {
    id: "paginate",
    tag: "L2",
    name: "Half the catalogue behind Load more",
    series: "L",
    blurb: "The index renders 2 of 4 tiles; the rest arrive only after a click. Nothing is renamed and nothing errors.",
    expect: "row count halves on a clean run. No selector is wrong, so only volume against this collector's own history can see it.",
  },
  {
    id: "jslinks",
    tag: "L3",
    name: "Links go JS-driven",
    series: "L",
    blurb: 'href becomes "#" and the real path moves to data-href — an SPA migration. The anchors are still there and still match.',
    expect: "every card resolves to the index itself, so stage 2 scrapes the same page four times: the right NUMBER of rows, all of them the wrong page.",
  },
];

export type Product = {
  sku: string;
  title: string;
  category: string;
  price: number;
  sale_price?: number;
  availability: "in stock" | "out of stock";
  description: string;
  emoji: string;
};

export const PRODUCTS: Product[] = [
  {
    sku: "echo-speaker",
    title: "Echo Portable Speaker",
    category: "Sound",
    price: 49.99,
    availability: "in stock",
    description: "360° sound in a palm-sized cylinder. 14-hour battery, IPX6, and a voice assistant that mostly listens when asked.",
    emoji: "🔊",
  },
  {
    sku: "aurora-lamp",
    title: "Aurora Desk Lamp",
    category: "Light",
    price: 34.5,
    sale_price: 29.99,
    availability: "in stock",
    description: "Sunrise-to-candlelight spectrum with a brass dial that clicks exactly the way you hope it does.",
    emoji: "💡",
  },
  {
    sku: "graphite-keyboard",
    title: "Graphite Mechanical Keyboard",
    category: "Workspace",
    price: 89.0,
    availability: "out of stock",
    description: "Gasket-mounted 75% board with lubed linear switches. Thocks responsibly.",
    emoji: "⌨️",
  },
  {
    sku: "tidal-bottle",
    title: "Tidal Insulated Bottle",
    category: "Everyday",
    price: 24.95,
    availability: "in stock",
    description: "Keeps cold things cold for 24 hours and coffee drinkable until you actually finish it.",
    emoji: "🫗",
  },
];

const money = (n: number) => `$${n.toFixed(2)}`;
const savePct = (p: Product) => (p.sale_price ? Math.round((1 - p.sale_price / p.price) * 100) : 0);
const stockAttr = (p: Product) => (p.availability === "in stock" ? "in" : "out");

// ─── Storefront chrome ───────────────────────────────────────────────────────

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Loomcart</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..700&family=Inter:wght@300..700&display=swap" rel="stylesheet">
<style>
  :root {
    /* --muted 4.7:1 and --faint nudged toward legibility on --bg (AA-checked
       for the 16px reading copy: hero paragraph, .description). */
    --bg:#f7f3eb; --card:#fffdf8; --ink:#221e18; --soft:#4c463c; --muted:#746c5b;
    --faint:#9a9078; --accent:#b64a2e; --accent-deep:#93391f; --line:#e8e0d0;
    --wash:#f1eadb; --green:#3e6b4f; --green-bg:#e9f0e6; --gold-bg:#fbf3df; --gold-line:#ecdfb6;
    --serif:'Fraunces', Georgia, 'Times New Roman', serif;
    --sans:'Inter', -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  }
  * { box-sizing:border-box; margin:0; }
  html { -webkit-text-size-adjust:100%; }
  body { font-family:var(--sans); background:var(--bg); color:var(--ink); line-height:1.55; font-size:16px; }

  .announce { background:var(--ink); color:#f2ead9; text-align:center; font-size:.7rem; letter-spacing:.18em; text-transform:uppercase; padding:.55rem 1rem; }

  header.site { display:flex; align-items:center; flex-wrap:wrap; gap:.6rem 1.8rem; padding:1.05rem 2.2rem; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:10; }
  header.site .logo a { font-family:var(--serif); font-weight:600; font-size:1.5rem; letter-spacing:.01em; color:var(--ink); text-decoration:none; }
  header.site .logo .dot { color:var(--accent); }
  nav.main-nav { display:flex; align-items:center; gap:1.4rem; }
  nav.main-nav a { font-size:.76rem; font-weight:500; letter-spacing:.15em; text-transform:uppercase; color:var(--soft); text-decoration:none; transition:color .15s ease; }
  nav.main-nav a:hover { color:var(--accent); }
  a.lab-link { margin-left:auto; font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); border:1px solid var(--line); border-radius:99px; padding:.32rem .8rem; text-decoration:none; transition:all .15s ease; }
  a.lab-link:hover { color:var(--accent); border-color:var(--accent); }

  main { max-width:1140px; margin:0 auto; padding:2.2rem 2.2rem 4rem; }

  .kicker { font-size:.7rem; font-weight:600; letter-spacing:.22em; text-transform:uppercase; color:var(--accent); }

  /* ── Listing ── */
  .hero { padding:1.6rem 0 2.4rem; border-bottom:1px solid var(--line); margin-bottom:2.2rem; }
  .hero h1 { font-family:var(--serif); font-weight:520; font-size:clamp(1.9rem,3.4vw,2.7rem); line-height:1.12; letter-spacing:-.01em; margin:.55rem 0 .7rem; }
  .hero p { color:var(--muted); font-size:1.02rem; max-width:52ch; }
  .shop-head { display:flex; align-items:baseline; justify-content:space-between; gap:1rem; margin-bottom:1.3rem; }
  .shop-head h2 { font-family:var(--serif); font-weight:560; font-size:1.25rem; }
  .shop-head .count { color:var(--muted); font-size:.82rem; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(235px,1fr)); gap:1.5rem; }
  .card { position:relative; background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
  .card:hover { transform:translateY(-4px); box-shadow:0 14px 34px rgba(34,30,24,.10); border-color:#d9cfba; }
  .card-link { display:block; height:100%; color:inherit; text-decoration:none; }
  .card .thumb { position:relative; text-align:center; font-size:3.4rem; line-height:1; padding:2.5rem 0 2.1rem; background:radial-gradient(120% 95% at 50% 15%, #fdfaf3 0%, var(--wash) 100%); border-bottom:1px solid var(--line); }
  .flag { position:absolute; top:.8rem; left:.8rem; font-size:.62rem; font-weight:600; letter-spacing:.14em; text-transform:uppercase; background:var(--accent); color:#fff; border-radius:99px; padding:.3rem .7rem; }
  .flag-oos { background:var(--muted); }
  .card-body { padding:1.05rem 1.15rem 1.2rem; }
  .card-body .kicker { font-size:.62rem; }
  .card h2.title { font-family:var(--serif); font-weight:560; font-size:1.1rem; line-height:1.25; margin:.3rem 0 .6rem; }
  .buy-row { display:flex; align-items:baseline; gap:.5rem; flex-wrap:wrap; }
  .card .price, .card .price-now { color:var(--accent-deep); font-weight:650; font-size:1.02rem; }
  .was { color:var(--muted); text-decoration:line-through; font-size:.85rem; }

  .availability { display:inline-flex; align-items:center; gap:.4rem; margin-left:auto; font-size:.66rem; font-weight:600; letter-spacing:.08em; text-transform:capitalize; color:var(--green); background:var(--green-bg); border:1px solid #d3e0cf; border-radius:99px; padding:.24rem .62rem; white-space:nowrap; }
  .availability::before { content:""; width:.42em; height:.42em; border-radius:50%; background:var(--green); }
  [data-stock="out"] .availability { color:#8f8578; background:#f0ece4; border-color:#e2dccf; }
  [data-stock="out"] .availability::before { background:#a89d8d; }
  .card[data-stock="out"] .thumb { filter:grayscale(.75); opacity:.75; }
  .card[data-stock="out"] h2.title, .card[data-stock="out"] .price, .card[data-stock="out"] .price-now { color:var(--muted); }

  /* ── Product detail ── */
  .crumbs { display:flex; align-items:center; gap:.55rem; font-size:.78rem; color:var(--muted); margin-bottom:1.4rem; }
  .crumbs a { color:var(--muted); text-decoration:none; }
  .crumbs a:hover { color:var(--accent); }
  .crumbs b { color:var(--soft); font-weight:500; }
  .product { display:grid; grid-template-columns:minmax(300px,460px) 1fr; gap:2.8rem; background:var(--card); border:1px solid var(--line); border-radius:20px; padding:2.6rem; }
  .gallery { position:sticky; top:5.4rem; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1.1rem; min-height:400px; background:radial-gradient(120% 95% at 50% 15%, #fdfaf3 0%, var(--wash) 100%); border:1px solid var(--line); border-radius:16px; padding:2rem 1rem; }
  .hero-emoji { font-size:7.5rem; line-height:1; }
  .gallery-note { font-size:.66rem; letter-spacing:.16em; text-transform:uppercase; color:var(--faint); }
  .details h1.title { font-family:var(--serif); font-weight:540; font-size:clamp(1.7rem,2.6vw,2.35rem); line-height:1.12; letter-spacing:-.01em; margin:.2rem 0 .9rem; }
  .price-block { display:flex; align-items:baseline; flex-wrap:wrap; gap:.8rem; margin:.2rem 0 1.2rem; }
  /* Every price variant reads identically. A mutation must be invisible to a
     human and obvious to a parser — if the page looked broken, the demo would be
     about a broken page rather than about silent drift. M4's hashed twins are
     listed alongside their semantic names for the same reason. */
  .price-block .price, .price-block .price-now, .price-block .price-final,
  .price-block .Price_value__k39fa, .buy-row .price, .buy-row .price-now,
  .buy-row .price-final, .buy-row .Price_value__k39fa { font-family:var(--serif); font-size:1.9rem; font-weight:600; color:var(--accent-deep); }
  .buy-row .price, .buy-row .price-now, .buy-row .price-final, .buy-row .Price_value__k39fa { font-size:1.05rem; }
  .price-was, .buy-row .price-was { font-size:1.05rem; color:var(--faint); text-decoration:line-through; }
  .PriceBlock_root__2d7be { display:flex; align-items:baseline; flex-wrap:wrap; gap:.8rem; margin:.2rem 0 1.2rem; }
  .Title_heading__8b2c1 { font-family:var(--serif); font-weight:560; }
  /* L1's renamed tile must be visually identical to .card — a mutation a human
     can see is a broken page, not silent drift. */
  .product-tile { background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; transition:border-color .15s ease, transform .15s ease; }
  .product-tile:hover { border-color:var(--accent); transform:translateY(-2px); }
  .more { display:flex; justify-content:center; margin-top:1.6rem; }
  .load-more { font-family:var(--sans); font-size:.82rem; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--accent-deep); background:transparent; border:1px solid var(--line); border-radius:10px; padding:.8rem 1.8rem; cursor:pointer; }
  .load-more:hover { border-color:var(--accent); }
  .price-block .was { font-size:1.05rem; }
  .price-block .availability { margin-left:0; }
  .save-chip { font-size:.66rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); background:#f9e9e2; border:1px solid #eed3c8; border-radius:99px; padding:.26rem .68rem; }
  .pricing { display:flex; align-items:baseline; gap:.8rem; }
  .pricing .current span { font-family:var(--serif); font-size:1.9rem; font-weight:600; color:var(--accent-deep); }
  .description { color:var(--soft); font-size:1.02rem; max-width:54ch; margin-bottom:1.6rem; }
  .cart { font-family:var(--sans); font-size:.84rem; font-weight:600; letter-spacing:.16em; text-transform:uppercase; background:var(--accent); color:#fff; border:0; border-radius:10px; padding:.95rem 2.3rem; cursor:pointer; transition:background .15s ease, transform .15s ease; }
  .cart:hover { background:var(--accent-deep); transform:translateY(-1px); }
  .cart:disabled { background:#ccc4b6; color:#faf7f0; cursor:not-allowed; transform:none; }
  .perks { list-style:none; padding:1.3rem 0 0; margin-top:1.6rem; border-top:1px solid var(--line); display:grid; gap:.55rem; color:var(--soft); font-size:.9rem; }
  .perks li { display:flex; gap:.6rem; align-items:baseline; }
  .perks li::before { content:"✓"; color:var(--green); font-weight:700; }

  /* ── Cross-sell strip (M2) ── */


  @keyframes spin { to { transform:rotate(360deg); } }

  footer.site { border-top:1px solid var(--line); margin-top:3rem; padding:2.6rem 2rem 3rem; text-align:center; color:var(--muted); font-size:.85rem; }
  footer.site .foot-brand { font-family:var(--serif); font-weight:600; font-size:1.2rem; color:var(--ink); margin-bottom:.45rem; }
  footer.site a { color:var(--accent); }
  footer.site .foot-fine { margin-top:.5rem; font-size:.72rem; color:var(--faint); }

  @media (max-width:900px) {
    .product { grid-template-columns:1fr; padding:1.6rem; gap:1.6rem; }
    .gallery { position:static; min-height:260px; }
    .hero-emoji { font-size:5.5rem; }
  }
  @media (max-width:560px) {
    header.site { padding:.9rem 1.2rem; gap:.5rem 1rem; }
    nav.main-nav { gap:.9rem; }
    nav.main-nav a.aux { display:none; }
    main { padding:1.4rem 1.2rem 3rem; }
  }
</style>
</head>
<body>
<div class="announce">Complimentary shipping on orders over $50 — dispatched daily from the Loom studio</div>
<header class="site">
  <div class="logo"><a href="/">Loomcart<span class="dot">.</span></a></div>
  <nav class="main-nav">
    <a href="/">Shop</a>
    <a href="/" class="aux">Collections</a>
    <a href="/" class="aux">Journal</a>
    <a href="/" class="aux">About</a>
  </nav>
  <a class="lab-link" href="/__control">Lab</a>
</header>
<main>
${body}
</main>
<footer class="site">
  <div class="foot-brand">Loomcart</div>
  <p>Loomcart is the ANANSI Mutation Lab — a deliberately fragile storefront. Break it from <a href="/__control">the control panel</a>.</p>
  <p class="foot-fine">© 2026 Loomcart · A demonstration boutique — no real orders, and only the fake kind of cookies</p>
</footer>
</body>
</html>`;
}

// ─── Fragments ───────────────────────────────────────────────────────────────

// Product pages no longer mutate. Every scenario now breaks the INDEX, which is
// stage 1 of the scrape — and the sharp edge of a stage-1 break is precisely
// that the pages it never reached are still perfect. Keeping a mutation here
// would blunt that: a run could fail for two reasons at once and diagnosis
// could not identify which one caused the incident.
function priceMarkup(p: Product): string {
  const shown = p.sale_price ?? p.price;
  const was = p.sale_price ? `<span class="was">${money(p.price)}</span>` : "";
  return `<span class="price">${money(shown)}</span>${was}`;
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export function productPage(p: Product): string {
  const save = p.sale_price ? ` <span class="save-chip">Save ${savePct(p)}%</span>` : "";
  const inStock = p.availability === "in stock";
  const inner = `<nav class="crumbs"><a href="/">Shop</a><span>/</span><a href="/">${p.category}</a><span>/</span><b>${p.title}</b></nav>
<div class="product" data-sku="${p.sku}" data-stock="${stockAttr(p)}">
  <div class="gallery">
    <span class="hero-emoji" role="img" aria-label="${p.title}">${p.emoji}</span>
    <span class="gallery-note">Ref. ${p.sku} · studio photograph</span>
  </div>
  <div class="details">
    <div class="kicker">${p.category}</div>
    <h1 class="title">${p.title}</h1>
    <div class="price-block">
      ${priceMarkup(p)}
      <span class="availability">${p.availability}</span>${save}
    </div>
    <p class="description">${p.description}</p>
    <button class="cart" type="button"${inStock ? "" : " disabled"}>${inStock ? "Add to basket" : "Sold out — notify me"}</button>
    <ul class="perks">
      <li>Carbon-neutral delivery, 2–4 working days</li>
      <li>30-day returns, no questions asked</li>
      <li>Two-year Loomcart guarantee</li>
    </ul>
  </div>
</div>`;
  const body = inner;
  return layout(p.title, body);
}

/** L2's Load more, working the way a real one works.
 *
 *  The held-back cards must be genuinely ABSENT from the served HTML, not merely
 *  hidden. A cheerio-style `$('.card')` ignores CSS entirely, so cards behind
 *  `display:none` would still be found and L2 would stop breaking discovery at
 *  all — the scenario would render as a broken-looking page that changes
 *  nothing, which is the opposite of what the Lab is for.
 *
 *  So the markup ships base64-encoded inside a script tag: not parsed as DOM,
 *  and not matchable by a raw-text search for `class="card"` either. Clicking
 *  decodes and appends it, which is what a human needs to see and what a scraper
 *  that never clicks will never get. Decoded through TextDecoder because atob
 *  yields latin1 and these cards carry emoji. */
function loadMore(cardsHtml: string, count: number): string {
  const payload = Buffer.from(cardsHtml, "utf8").toString("base64");
  return `
<div class="more"><button class="load-more" type="button" data-remaining="${count}">Load ${count} more</button></div>
<script id="held-cards" type="application/base64">${payload}</script>
<script>
document.querySelector('.load-more').addEventListener('click', function () {
  var raw = document.getElementById('held-cards').textContent.trim();
  var bytes = Uint8Array.from(atob(raw), function (c) { return c.charCodeAt(0); });
  document.querySelector('.grid').insertAdjacentHTML('beforeend', new TextDecoder().decode(bytes));
  document.querySelector('.shop-head .count').textContent = document.querySelectorAll('.grid > *').length + ' objects';
  this.closest('.more').remove();
});
</script>`;
}

export function listingPage(mutation: Mutation): string {
  // L-series: the index is stage 1 of a two-stage scrape. It is parsed for
  // product links, and each link becomes an input to stage 2. Nothing here
  // touches the product pages — which is the point. A stage-1 break collects
  // NOTHING while every selector on the pages it never reached still works.
  const shown = mutation === "paginate" ? PRODUCTS.slice(0, 2) : PRODUCTS;
  const held = mutation === "paginate" ? PRODUCTS.slice(2) : [];
  const cardClass = mutation === "cardrename" ? "product-tile" : "card";
  const card = (p: Product): string => {
    const flag = p.availability === "out of stock"
      ? `<span class="flag flag-oos">Sold out</span>`
      : p.sale_price
        ? `<span class="flag">Save ${savePct(p)}%</span>`
        : "";
    // The listing renders each card through the SAME price markup as the product
    // page, matching the behavior of a shared component on a real store.
    // L3 keeps the anchor and its class — it still matches — and empties the
    // href. `new URL("#", base)` resolves to the index, so every product url
    // stage 1 hands on is the page it was already looking at.
    const href = mutation === "jslinks" ? `#" data-href="/product/${p.sku}` : `/product/${p.sku}`;
    return `<div class="${cardClass}" data-sku="${p.sku}" data-stock="${stockAttr(p)}">
  <a class="card-link" href="${href}">
    <div class="thumb">${p.emoji}${flag}</div>
    <div class="card-body">
      <div class="kicker">${p.category}</div>
      <h2 class="title">${p.title}</h2>
      <div class="buy-row">${priceMarkup(p)}<span class="availability">${p.availability}</span></div>
    </div>
  </a>
</div>`;
  };
  const cards = shown.map(card).join("\n");
  const inner = `<div class="hero">
  <div class="kicker">The Loomcart edit · considered objects, shipped weekly</div>
  <h1>Fewer things,<br>better things.</h1>
  <p>A small catalogue of objects we actually use — chosen slowly, priced honestly, restocked when the studio says so.</p>
</div>
<div class="shop-head">
  <h2>All products</h2>
  <span class="count">${shown.length} objects</span>
</div>
<div class="grid">
${cards}
</div>${held.length ? loadMore(held.map(card).join("\n"), held.length) : ""}`;
  const body = inner;
  return layout("Shop", body);
}

// ─── Control panel — light instrument styling, sharing the shop's palette ──

function controlRow(m: (typeof MUTATIONS)[number], current: Mutation): string {
  const active = m.id === current;
  const isReset = m.series === "reset";
  const chip = active ? `<span class="chip">● ACTIVE</span>` : "";
  // The active mutation's control is a state readout, not a re-fire link — the
  // /__control?mutate=<id> contract only needs the links that change state.
  const control =
    active && !isReset
      ? `<span class="fire live">Live</span>`
      : `<a class="fire${isReset ? " resetbtn" : ""}" href="/__control?mutate=${m.id}">${isReset ? "Restore" : "Fire ▸"}</a>`;
  return `<div class="row${active ? " active" : ""}${isReset ? " reset" : ""}">
  <span class="mid">${m.tag}</span>
  <div class="info">
    <div class="mname">${m.name}${chip}</div>
    <div class="mblurb">${m.blurb}</div>
    <div class="mexpect">${m.expect}</div>
  </div>
  ${control}
</div>`;
}

export function controlPage(current: Mutation): string {
  const reset = MUTATIONS.filter((m) => m.series === "reset").map((m) => controlRow(m, current)).join("\n");
  const lRows = MUTATIONS.filter((m) => m.series === "L").map((m) => controlRow(m, current)).join("\n");
  const stateLabel = current === "none" ? "BASELINE" : current.toUpperCase();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mutation Lab control · Loomcart</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  /* Light instrument panel, sharing the storefront's paper palette so the two
     read as one product. Every ink/ground pair here clears 4.5:1 on its own
     background — this gets filmed and projected, where a low-contrast grey is
     simply unreadable. --accent is the storefront's terracotta rather than the
     amber that only worked against near-black. */
  :root {
    --bg:#f7f3eb; --panel:#fffdf8; --panel2:#f1eadb; --line:#e4dbc9; --line2:#cfc3aa;
    --txt:#3b352b; --bright:#221e18; --dim:#6b6355; --faint:#8d8471;
    --accent:#b64a2e; --accent-soft:rgba(182,74,46,.07);
    --green:#3e6b4f; --green-soft:rgba(62,107,79,.08);
    --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing:border-box; margin:0; }
  body {
    font-family:var(--mono); color:var(--txt); font-size:14px; line-height:1.55; min-height:100vh;
    background:
      radial-gradient(1100px 380px at 50% -8%, rgba(182,74,46,.05), transparent),
      linear-gradient(rgba(34,30,24,.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(34,30,24,.035) 1px, transparent 1px),
      var(--bg);
    background-size:auto, 28px 28px, 28px 28px, auto;
  }
  header.bar { display:flex; align-items:center; flex-wrap:wrap; gap:.8rem 1.6rem; padding:1rem 1.8rem; border-bottom:1px solid var(--line); background:rgba(247,243,235,.92); backdrop-filter:blur(6px); position:sticky; top:0; z-index:5; }
  .brand { font-weight:700; letter-spacing:.22em; color:var(--bright); font-size:.92rem; }
  .brand .mark { color:var(--accent); }
  .brand .dim { color:var(--dim); font-weight:500; }
  .readout { display:flex; align-items:center; gap:.7rem; font-size:.7rem; letter-spacing:.2em; color:var(--dim); }
  .state-chip { font-size:.7rem; font-weight:700; letter-spacing:.18em; border:1px solid; border-radius:5px; padding:.32rem .75rem; }
  .state-chip.ok { color:var(--green); border-color:rgba(62,107,79,.45); background:var(--green-soft); }
  .state-chip.hot { color:var(--accent); border-color:rgba(182,74,46,.5); background:var(--accent-soft); animation:pulse 1.8s ease-in-out infinite; }
  header.bar nav { margin-left:auto; display:flex; gap:1.3rem; }
  header.bar nav a { color:var(--dim); text-decoration:none; font-size:.76rem; letter-spacing:.08em; transition:color .15s ease; }
  header.bar nav a:hover { color:var(--accent); }

  main { max-width:880px; margin:0 auto; padding:2.2rem 1.6rem 3rem; }
  .lede { color:var(--dim); font-size:.8rem; max-width:66ch; margin-bottom:1.8rem; }
  .lede b { color:var(--txt); font-weight:600; }

  /* Series header: description always on its own line under the name, so both
     groups share one shape at every width. --dim (not --faint) — this is
     teaching text that must survive video compression (≥4.5:1 on the panels). */
  .ghead { margin:2.1rem 0 .9rem; border-bottom:1px solid var(--line); padding-bottom:.55rem; }
  .gname { display:block; color:var(--bright); font-weight:700; letter-spacing:.26em; font-size:.8rem; }
  .gdesc { display:block; color:var(--dim); font-size:.7rem; letter-spacing:.04em; margin-top:.2rem; }

  .row { display:grid; grid-template-columns:auto 1fr auto; gap:1.1rem; align-items:center; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1rem 1.2rem; margin-bottom:.7rem; transition:border-color .15s ease, background .15s ease; }
  .row:hover { border-color:var(--line2); }
  .row.active { border-color:rgba(182,74,46,.55); background:linear-gradient(180deg, var(--accent-soft), transparent 70%), var(--panel); box-shadow:0 0 0 1px rgba(182,74,46,.18), 0 0 30px rgba(182,74,46,.06); }
  .row.reset.active { border-color:rgba(62,107,79,.5); background:linear-gradient(180deg, var(--green-soft), transparent 70%), var(--panel); box-shadow:0 0 0 1px rgba(62,107,79,.18), 0 0 30px rgba(62,107,79,.06); }
  .mid { font-size:.78rem; font-weight:700; color:var(--dim); background:var(--panel2); border:1px solid var(--line2); border-radius:6px; padding:.5rem .5rem; min-width:2.7rem; text-align:center; }
  .row.active .mid { color:var(--accent); border-color:rgba(182,74,46,.45); }
  .row.reset .mid { color:var(--green); border-color:rgba(62,107,79,.3); }
  .mname { color:var(--bright); font-weight:600; font-size:.9rem; display:flex; align-items:center; gap:.7rem; flex-wrap:wrap; }
  .chip { font-size:.6rem; font-weight:700; letter-spacing:.2em; color:#fffdf8; background:var(--accent); border-radius:4px; padding:.2rem .55rem; animation:pulse 1.6s ease-in-out infinite; }
  .row.reset .chip { background:var(--green); color:#fffdf8; }
  .mblurb { color:var(--dim); font-size:.75rem; margin-top:.2rem; }
  .mexpect { color:var(--dim); font-size:.7rem; margin-top:.35rem; }
  .mexpect::before { content:"↳ expected — "; }
  .fire { font-family:inherit; font-size:.7rem; font-weight:700; letter-spacing:.2em; text-transform:uppercase; color:var(--accent); background:rgba(182,74,46,.05); border:1px solid rgba(182,74,46,.5); border-radius:7px; padding:.65rem 1.2rem; text-decoration:none; white-space:nowrap; transition:all .15s ease; }
  a.fire:hover { background:var(--accent); color:#fffdf8; box-shadow:0 0 24px rgba(182,74,46,.28); transform:translateY(-1px); }
  .fire.resetbtn { color:var(--green); background:rgba(62,107,79,.05); border-color:rgba(62,107,79,.5); }
  a.fire.resetbtn:hover { background:var(--green); color:#fffdf8; box-shadow:0 0 24px rgba(62,107,79,.25); }
  /* The active mutation's control is a state readout (a <span>), not a link. */
  .fire.live { color:var(--dim); background:transparent; border-color:var(--line2); }

  footer { border-top:1px solid var(--line); text-align:center; color:var(--faint); font-size:.7rem; padding:1.4rem 1rem; letter-spacing:.04em; }
  footer code { color:var(--dim); }

  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }

  @media (max-width:640px) {
    .row { grid-template-columns:auto 1fr; }
    .fire { grid-column:1 / -1; text-align:center; }
    header.bar nav { margin-left:0; }
  }
</style>
</head>
<body>
<header class="bar">
  <div class="brand"><span class="mark">◉</span> ANANSI <span class="dim">/ MUTATION LAB</span></div>
  <div class="readout">STATE <span class="state-chip ${current === "none" ? "ok" : "hot"}">${stateLabel}</span></div>
  <nav><a href="/">storefront ↗</a><a href="/__state">/__state</a></nav>
</header>
<main>
  <p class="lede">Every storefront page re-reads mutation state <b>on every request</b> — a fire lands instantly, no deploy, no cache. Fire a mutation, run a sweep, watch ANANSI respond.</p>
${reset}
  <div class="ghead"><span class="gname">L-SERIES · INDEX PAGE</span><span class="gdesc">discovery breaks — stage 1 hands stage 2 the wrong links, or none, and the product pages stay perfect</span></div>
${lRows}
</main>
<footer>deep-link any scenario: <code>/__control?mutate=&lt;id&gt;</code> · state lives in KV · <code>Cache-Control: no-store</code> everywhere</footer>
</body>
</html>`;
}
