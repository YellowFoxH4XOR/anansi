// Two-sided CUSUM (Page 1954) per field per URL — ADR-001.
// Upper-only cannot fire on downward drift, and prices drift down at least as often as up.
// σ floor: a golden-pinned canary returns a constant series whose σ ≈ 0, which would
// collapse k and h to 0 and turn the chart into an equality test that defeats the
// tolerance band — so σ_eff = max(σ_window, band_width / 8).

export type CusumParams = {
  kSigma: number; // allowance, in σ_eff units (default 0.5)
  hSigma: number; // threshold, in σ_eff units (default 4)
  bandWidth?: number; // absolute width of the golden tolerance band, for the σ floor
};

export type CusumResult = {
  alarm: boolean;
  side?: "upper" | "lower";
  sPlus: number;
  sMinus: number;
  mean: number;
  sigmaEff: number;
};

export const DEFAULT_CUSUM: CusumParams = { kSigma: 0.5, hSigma: 4 };

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// history: trailing window (oldest first) establishing μ and σ; series: the
// observations to chart (typically history plus the newest points).
export function cusum(
  history: number[],
  series: number[],
  params: CusumParams = DEFAULT_CUSUM,
): CusumResult {
  const mu = history.length > 0 ? mean(history) : 0;
  const sigmaWindow = stdev(history, mu);
  const floor = params.bandWidth != null ? params.bandWidth / 8 : 0;
  const sigmaEff = Math.max(sigmaWindow, floor);
  if (sigmaEff === 0 || history.length < 2) {
    // Not enough signal to chart — CUSUM stays silent; other signals own this case.
    return { alarm: false, sPlus: 0, sMinus: 0, mean: mu, sigmaEff };
  }
  const k = params.kSigma * sigmaEff;
  const h = params.hSigma * sigmaEff;
  let sPlus = 0;
  let sMinus = 0;
  for (const x of series) {
    sPlus = Math.max(0, sPlus + (x - mu - k));
    sMinus = Math.max(0, sMinus + (mu - x - k));
    if (sPlus > h) return { alarm: true, side: "upper", sPlus, sMinus, mean: mu, sigmaEff };
    if (sMinus > h) return { alarm: true, side: "lower", sPlus, sMinus, mean: mu, sigmaEff };
  }
  return { alarm: false, sPlus, sMinus, mean: mu, sigmaEff };
}
