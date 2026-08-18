// Error-code routing table from docs/brightdata-notes.md, encoded once (ADR-003:
// blocked is an access problem — healing code can never fix it).

import type { Route } from "../types.js";

const NEVER_HEAL = new Set(["blocked", "detection_block", "captcha_timeout", "no_peers"]);
const RETRY = new Set(["infra_error", "worker_too_busy", "runner_disconnected"]);
const DEAD = new Set(["bad_input", "dead_page"]);
const CONFIG = new Set([
  "too_many_pages",
  "parse_mem_limit_exceeded",
  "parse_cpu_limit_exceeded",
  "job_run_timeout",
]);
const HEAL = new Set(["parse_error", "wait_element_timeout", "click_timeout"]);

export function routeErrorCode(code: string): Route {
  const c = code.toLowerCase().trim();
  if (NEVER_HEAL.has(c) || c.startsWith("proxy")) return "infra";
  if (RETRY.has(c) || c.startsWith("net_err") || /^5\d\d$/.test(c)) return "retry";
  if (DEAD.has(c)) return "dead";
  if (CONFIG.has(c)) return "config";
  if (HEAL.has(c)) return "heal";
  // Unknown codes: treat as transient rather than burning heal credits blind.
  return "retry";
}
