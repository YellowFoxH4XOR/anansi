// DOM normalization before diffing: hydration ids, nonces, timestamps and
// CSS-in-JS class suffixes change on every render and would drown the real diff.

import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

const DROP_ATTRS = new Set(["nonce", "data-reactid", "data-react-checksum", "data-hydration-id", "data-ssr-id", "style"]);
const CSS_IN_JS = /^(css|sc|emotion|jsx|svelte|astro)-[a-z0-9]{4,}$/i;
const RANDOM_ID = /(^|[-_])[a-f0-9]{6,}([-_]|$)|^\d{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}/i;
const TIMESTAMP_TEXT = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b|\b\d{10,13}\b/g;

export function normalizeHtml(html: string): HTMLElement {
  const root = parse(html, { comment: false });
  for (const el of root.querySelectorAll("script, style, noscript, link, meta")) el.remove();
  walk(root);
  return root;
}

function walk(el: HTMLElement): void {
  for (const attr of Object.keys(el.attributes)) {
    const val = el.attributes[attr] ?? "";
    if (DROP_ATTRS.has(attr) || attr.startsWith("data-v-") || attr.startsWith("data-emotion")) {
      el.removeAttribute(attr);
    } else if (attr === "class") {
      const kept = val.split(/\s+/).filter((c) => c && !CSS_IN_JS.test(c));
      if (kept.length) el.setAttribute("class", kept.sort().join(" "));
      else el.removeAttribute("class");
    } else if (attr === "id" && RANDOM_ID.test(val)) {
      el.removeAttribute("id");
    }
  }
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE) walk(child as HTMLElement);
    else if (child.nodeType === NodeType.TEXT_NODE) {
      const t = child.rawText.replace(TIMESTAMP_TEXT, "⟨ts⟩").replace(/\s+/g, " ");
      (child as Node & { rawText: string }).rawText = t;
    }
  }
}

// Stable structural signature for one element (tag + ordered classes + stable id).
export function signature(el: HTMLElement): string {
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).sort();
  const id = el.getAttribute("id");
  const testid = el.getAttribute("data-testid");
  return [
    el.rawTagName?.toLowerCase() ?? "",
    id ? `#${id}` : "",
    cls.length ? `.${cls.join(".")}` : "",
    testid ? `[data-testid=${testid}]` : "",
  ].join("");
}

// Root-to-node selector path, e.g. div.product > div.price-block > span.price
export function pathOf(el: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur.rawTagName) {
    parts.unshift(signature(cur));
    cur = cur.parentNode as HTMLElement | null;
  }
  return parts.join(" > ");
}

export function elementsOf(root: HTMLElement): HTMLElement[] {
  return root.querySelectorAll("*");
}
