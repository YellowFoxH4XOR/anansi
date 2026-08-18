// LLM adapter: turns an evidence pack into the plain-English heal prompt.
// The runtime LLM is a product feature (see README AI disclosure). Two impls:
// - TemplateLlm: deterministic renderer from core/diagnose/prompt.ts. Default
//   for tests and when no API credentials exist.
// - ClaudeLlm: Claude Opus 5 writes the prose; hard-capped at 1000 chars with
//   truncate-and-retry, falling back to the template on any failure.

import Anthropic from "@anthropic-ai/sdk";
import type { EvidencePack } from "../../core/diagnose/evidence.js";
import { buildPrompt, PROMPT_MAX } from "../../core/diagnose/prompt.js";

export interface LlmAdapter {
  healPrompt(ev: EvidencePack): Promise<string>;
}

export class TemplateLlm implements LlmAdapter {
  async healPrompt(ev: EvidencePack): Promise<string> {
    return buildPrompt(ev);
  }
}

const SYSTEM = `You write repair instructions for Bright Data's Scraper Studio "heal" feature.
Input: a JSON evidence pack describing how a scraped page's DOM changed and which output fields broke.
Output: ONE plain-English diagnosis prompt, under ${PROMPT_MAX} characters, structured as:
symptom → located change (cite the selector paths from the evidence) → expected output.
Never include raw HTML or the full diff. Tell the healer to leave working fields untouched.
If prior_failures is non-empty, say what failed and ask for a different approach.
Respond with the prompt text only — no preamble, no quotes, no markdown.`;

export class ClaudeLlm implements LlmAdapter {
  private client = new Anthropic();
  private fallback = new TemplateLlm();

  async healPrompt(ev: EvidencePack): Promise<string> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.client.beta.messages.create({
          model: "claude-opus-5",
          max_tokens: 1024, // deliberately short output — prompt is capped at 1000 chars
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          messages: [
            {
              role: "user",
              content:
                `Evidence pack:\n${JSON.stringify(ev, null, 1)}` +
                (attempt > 0 ? `\n\nYour previous draft was over ${PROMPT_MAX} characters. Compress it.` : ""),
            },
          ],
        });
        if (response.stop_reason === "refusal") break;
        const block = response.content.find((b) => b.type === "text");
        const text = block && "text" in block ? block.text.trim() : "";
        if (text.length > 0 && text.length <= PROMPT_MAX) return text;
      }
    } catch {
      // fall through to the deterministic template
    }
    return this.fallback.healPrompt(ev);
  }
}

// Env-gated default: Claude when credentials exist, template otherwise.
export function defaultLlm(): LlmAdapter {
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? new ClaudeLlm()
    : new TemplateLlm();
}
