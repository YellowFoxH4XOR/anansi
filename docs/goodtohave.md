# Good to Have & Academic Research Insights

This document captures advanced research insights from recent 2026 preprints (ICLR, COLM, arXiv) and outlines high-value "good to have" enhancements for ANANSI.

---

## 1. Relevant 2026 Research Papers

| Paper | Venue / Date | Key Concept | Impact on ANANSI |
|---|---|---|---|
| **CausalRepair** | *arXiv:2608.10613 (Aug 2026)* | **Minimal Causal Slicing**: Purifies failure context to only the essential code/DOM dependencies. | Prevents LLM prompt pollution; constructs dense, targeted heal prompts that comfortably fit within Bright Data's strict 1,000-character CLI limit. |
| **RECAP** | *arXiv:2608.13292 (Aug 2026)* | **Anti-Bloat Post-Generation Refinement**: Shows that LLM code repairs often introduce bloated, brittle changes that pass one test but break elsewhere. | Directly justifies our Two-Phase Verification Gate (ADR-002) with strict canary regression testing across non-broken fields. |
| **LiveWeb-IE** | *ICLR 2026 (arXiv:2603.13773)* | **Temporal Web Evolution Benchmark**: Proves static test suites fail because live web layouts dynamically drift over time. | Validates our continuous Two-Sided CUSUM + Tolerance Band monitoring (ADR-001) over static null-checking. |
| **AXE** | *arXiv:2602.01838 (2026)* | **Grounded XPath Resolution (GXR)**: Ensures every extraction is physically traceable to a source DOM node before trusting it. | Protects V1 verification from hallucinated or hardcoded values in AI-generated scraper code. |
| **CAP** | *COLM 2026 (arXiv:2608.08392)* | **Complex Action & Perception Benchmark**: Demonstrates that agents fail when interacting with dynamic UI overlays, consent modals, and popups. | Informs Mutation Lab M3 (Cookie Wall) and exercises Scraper Studio's interactive primitives (`close_popup()`). |

---

## 2. "Good to Have" Feature Enhancements

### A. Causal Subtree DOM Slicing (Diagnose Pipeline)
- **Goal**: Instead of naive full-DOM or flat string diffs, find the Lowest Common Ancestor (LCA) container of the affected elements.
- **Benefit**: Keeps diagnosis prompts concise, highly contextual, and under the 1,000-character cap.

### B. Anti-Hallucination Grounding Check (Verify Gate V1)
- **Goal**: Inspect `preview_result` values and assert that each extracted string/number exists within the current DOM snapshot's text nodes.
- **Benefit**: Instantly rejects degenerate AI patches that attempt to hardcode expected golden values.

### C. Fleet Regression Invariance Matrix (Verify Gate V2)
- **Goal**: Run a full multi-canary check post-approval to ensure fields that were healthy before the heal did not degrade in accuracy or fill-rate.
- **Benefit**: Ensures self-healing never causes downstream collateral damage across the scraper fleet.

### D. Interactive Overlay Handler (Advanced Heals)
- **Goal**: Detect full-screen blocking modals / interstitials from DOM diffs and suggest `close_popup()` or interaction steps rather than standard selector updates.
