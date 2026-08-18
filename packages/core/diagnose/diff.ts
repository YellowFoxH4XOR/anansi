// Structural subtree diff between last-good and current normalized DOMs.
// Output is selector-path oriented — exactly what a heal prompt needs to cite.

import type { HTMLElement } from "node-html-parser";
import { elementsOf, normalizeHtml, pathOf, signature } from "./normalize.js";

export type DomChange = { path: string; text?: string };

export type DomDiff = {
  added: DomChange[]; // paths present now, absent in last-good
  removed: DomChange[]; // paths present in last-good, gone now
  unchangedCount: number;
};

function pathMap(root: HTMLElement): Map<string, HTMLElement[]> {
  const m = new Map<string, HTMLElement[]>();
  for (const el of elementsOf(root)) {
    const p = pathOf(el);
    const arr = m.get(p) ?? [];
    arr.push(el);
    m.set(p, arr);
  }
  return m;
}

function shortText(el: HTMLElement): string {
  const t = el.structuredText?.replace(/\s+/g, " ").trim() ?? "";
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

// Collapse child paths whose ancestor already appears in the change set — the
// smallest containing subtree is the story; its descendants are noise.
function collapse(paths: Map<string, HTMLElement>): DomChange[] {
  const keys = [...paths.keys()].sort();
  const kept: string[] = [];
  for (const k of keys) {
    if (!kept.some((anc) => k.startsWith(`${anc} > `))) kept.push(k);
  }
  return kept.map((k) => ({ path: k, text: shortText(paths.get(k)!) }));
}

export function diffHtml(lastGoodHtml: string, currentHtml: string): DomDiff {
  const a = pathMap(normalizeHtml(lastGoodHtml));
  const b = pathMap(normalizeHtml(currentHtml));

  const removed = new Map<string, HTMLElement>();
  const added = new Map<string, HTMLElement>();
  let unchanged = 0;

  for (const [p, els] of a) {
    const bn = b.get(p)?.length ?? 0;
    if (bn >= els.length) unchanged += els.length;
    else {
      unchanged += bn;
      removed.set(p, els[0]!);
    }
  }
  for (const [p, els] of b) {
    const an = a.get(p)?.length ?? 0;
    if (els.length > an) added.set(p, els[els.length - 1]!);
  }

  return { added: collapse(added), removed: collapse(removed), unchangedCount: unchanged };
}

// Where does a pinned value live in the current DOM? Locates the element whose own
// text contains the golden — the heal prompt can then say "the correct value now
// renders at <path>". Also powers the V1 hardcode detector.
export function locateValue(currentHtml: string, value: unknown): DomChange[] {
  const root = normalizeHtml(currentHtml);
  const needle = String(value).toLowerCase();
  const hits: DomChange[] = [];
  for (const el of elementsOf(root)) {
    const own = el.childNodes
      .filter((n) => n.nodeType === 3)
      .map((n) => n.rawText)
      .join(" ")
      .toLowerCase();
    if (own.includes(needle)) hits.push({ path: pathOf(el), text: shortText(el) });
  }
  return hits;
}

export { signature };
