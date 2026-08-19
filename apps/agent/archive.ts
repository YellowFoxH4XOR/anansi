// The free HTML archive.
//
// Dataset rows carry no page HTML unless the scraper happened to collect it,
// and there is no API to read or edit a scraper's source. So ANANSI fetches the
// target page itself with a plain HTTP GET — which costs nothing, because it
// never touches Bright Data — and archives that HTML after every successful
// job. On a failure it fetches again and diffs archived-good against current.
//
// CAVEAT, deliberately surfaced rather than hidden: a plain fetch is not Bright
// Data's browser rendering through its proxy network. On a JS-heavy page we see
// the shell the scraper never parsed; on a geo-gated or challenged page we see
// our own block, not the scraper's. Such a capture is marked low-confidence so
// a heal prompt is never generated from a captcha page while claiming to
// describe the product page.

import type { Store } from "../../packages/adapters/store/index.js";

export type PageCapture = {
  url: string;
  html: string;
  status: number;
  bytes: number;
  /** True when the response is too small, non-200, or challenge-shaped to be
   *  the page the scraper saw. */
  low_confidence: boolean;
  /** Set when the fetch never produced a page at all; mapped onto the same
   *  error taxonomy core/sense/triage.ts routes real platform codes by. */
  error_code?: string;
  fetched_ms: number;
};

export type PageFetcher = (url: string) => Promise<PageCapture>;

/** Below this a "page" is an error stub or an interstitial, not a product page. */
const MIN_PLAUSIBLE_BYTES = 512;

const CHALLENGE_MARKERS = [
  "captcha",
  "are you a human",
  "checking your browser",
  "access denied",
  "cf-browser-verification",
];

export function looksLikeChallenge(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => head.includes(m));
}

export type HttpFetcherOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** Plain GET of a target page. The status→error_code mapping is the platform's
 *  own taxonomy: 403 is an access problem that must never be healed, 404 marks
 *  the URL dead, 5xx and transport faults are transient. */
export function httpPageFetcher(opts: HttpFetcherOptions = {}): PageFetcher {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  return async (url: string): Promise<PageCapture> => {
    let res: Response;
    let html: string;
    try {
      res = await doFetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        // Identifying the agent is a courtesy the archive owes every host it
        // touches; ANANSI must not read as an anonymous scraper.
        headers: { "user-agent": "anansi-archive/1.0 (monitor)", "cache-control": "no-cache" },
      });
      html = await res.text();
    } catch (e) {
      return {
        url,
        html: "",
        status: 0,
        bytes: 0,
        low_confidence: true,
        error_code: `net_err_${(e as Error).name.toLowerCase()}`,
        fetched_ms: now(),
      };
    }

    const errorCode =
      res.status === 403
        ? "blocked"
        : res.status === 404
          ? "dead_page"
          : res.status >= 500
            ? String(res.status)
            : !res.ok
              ? "parse_error"
              : undefined;

    const bytes = Buffer.byteLength(html);
    return {
      url,
      html,
      status: res.status,
      bytes,
      low_confidence: errorCode != null || bytes < MIN_PLAUSIBLE_BYTES || looksLikeChallenge(html),
      ...(errorCode ? { error_code: errorCode } : {}),
      fetched_ms: now(),
    };
  };
}

/** Optional fetch-side origin substitution.
 *
 *  The archive may reach a target over a private network (the Lab is a sibling
 *  container in compose) instead of over the public internet. What it must NOT
 *  do is change the URL anyone else sees: `contract.canaries[].url` is the join
 *  key evaluate() matches dataset rows against, and Bright Data collects the
 *  PUBLIC url. Rewriting the contract to an internal address therefore makes
 *  every golden, and every golden-derived CUSUM band, silently inert — an
 *  entirely clean verdict on a page that changed. So the swap happens here, on
 *  the way out, and nothing upstream ever sees the internal address. */
export function originRewriter(publicHosts: readonly string[], base: string | undefined): (url: string) => string {
  if (!base) return (url) => url;
  const hosts = new Set(publicHosts);
  return (url) => {
    try {
      const target = new URL(url);
      if (!hosts.has(target.host)) return url;
      return new URL(target.pathname + target.search, base).toString();
    } catch {
      return url;
    }
  };
}

/** Fetches `rewrite(url)` but reports the ORIGINAL url, so snapshot refs stay
 *  keyed by the string the contract and the dataset both use. */
export function viaOrigin(fetchPage: PageFetcher, rewrite: (url: string) => string): PageFetcher {
  return async (url) => ({ ...(await fetchPage(rewrite(url))), url });
}

export type ArchiveOptions = {
  maxUrls: number;
  /** Per-URL floor between archive fetches. ANANSI must not become a scraper. */
  floorMs: number;
  /** A failure needs the page as it is NOW, not as it was archived a minute ago. */
  force?: boolean;
};

export type ArchiveResult = {
  refs: Record<string, string>;
  captures: PageCapture[];
};

/** Archive pages and return url → snapshot ref.
 *
 *  A capture produces a ref only when it is trustworthy enough to reason from.
 *  No HTML at all would diff as "the whole page vanished"; a challenge page, an
 *  error stub or a non-200 body would diff as OUR block and describe it to the
 *  model as the scraper's failure. Both send a confident, wrong prompt, so both
 *  are withheld. The capture itself is still returned — the caller logs it, and
 *  routes on its error_code — and an incident with no usable snapshot
 *  quarantines for a human instead of guessing. */
export async function archivePages(
  urls: readonly string[],
  store: Store,
  fetchPage: PageFetcher,
  opts: ArchiveOptions,
  lastFetchedMs: Map<string, number> = new Map(),
  now: () => number = Date.now,
): Promise<ArchiveResult> {
  const refs: Record<string, string> = {};
  const captures: PageCapture[] = [];
  const targets = [...new Set(urls)].slice(0, opts.maxUrls);

  for (const url of targets) {
    const last = lastFetchedMs.get(url);
    if (!opts.force && last != null && now() - last < opts.floorMs) continue;
    const cap = await fetchPage(url);
    lastFetchedMs.set(url, cap.fetched_ms);
    captures.push(cap);
    if (!cap.html || cap.low_confidence) continue;
    refs[url] = await store.saveSnapshot(cap.html);
  }
  return { refs, captures };
}
