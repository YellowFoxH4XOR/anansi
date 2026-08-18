// token_set_ratio, chosen over plain Levenshtein ratio per docs/data-contract.md:
// a legitimate "- Black" suffix scores ~0.84 on Levenshtein (false alarm) but ~1.0 here.

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur.slice();
  }
  return prev[n]!;
}

export function ratio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(normalize(a));
  const tb = new Set(normalize(b));
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const diffA = [...ta].filter((t) => !tb.has(t)).sort();
  const diffB = [...tb].filter((t) => !ta.has(t)).sort();
  const s0 = inter.join(" ");
  const s1 = [s0, ...diffA].filter(Boolean).join(" ").trim();
  const s2 = [s0, ...diffB].filter(Boolean).join(" ").trim();
  return Math.max(ratio(s0, s1), ratio(s0, s2), ratio(s1, s2));
}
