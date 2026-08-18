// LLM adapter: turns an evidence pack into the plain-English heal prompt.
// The runtime LLM is a product feature (see README AI disclosure). Two impls:
// - TemplateLlm: deterministic renderer from core/diagnose/prompt.ts. Default
//   for tests and when no API credentials exist.
// - GeminiLlm: Gemini writes the prose; hard-capped at 1000 chars with
//   truncate-and-retry, falling back to the template on any failure.

import { GoogleGenAI, ThinkingLevel, type FinishReason } from "@google/genai";
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

// Gemini 3 bills thinking tokens against maxOutputTokens, so the tight cap a
// non-thinking model would take here is spent entirely on reasoning: the reply
// comes back empty with finishReason MAX_TOKENS, the template fallback fires on
// every incident, and the LLM looks wired up while never being used. Hence a
// generous ceiling plus an explicitly low thinking level — this is a short
// rewrite of an already-structured evidence pack, not a reasoning problem.
const MODEL = "gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 2048;

export class GeminiLlm implements LlmAdapter {
  // Reads GEMINI_API_KEY / GOOGLE_API_KEY from the environment.
  private client = new GoogleGenAI({});
  private fallback = new TemplateLlm();

  async healPrompt(ev: EvidencePack): Promise<string> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.client.models.generateContent({
          model: MODEL,
          contents:
            `Evidence pack:\n${JSON.stringify(ev, null, 1)}` +
            (attempt > 0 ? `\n\nYour previous draft was over ${PROMPT_MAX} characters. Compress it.` : ""),
          config: {
            systemInstruction: SYSTEM,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });
        const finish: FinishReason | undefined = response.candidates?.[0]?.finishReason;
        const text = response.text?.trim() ?? "";
        // Worth a log line rather than a silent fallback: a budget blown on
        // thinking is a config problem, not a model refusal, and the two look
        // identical from the incident record.
        if (!text && finish === "MAX_TOKENS") {
          console.warn(`[llm] ${MODEL} returned no text (finishReason=MAX_TOKENS) — raise MAX_OUTPUT_TOKENS or lower thinkingLevel`);
          break;
        }
        if (text.length > 0 && text.length <= PROMPT_MAX) return text;
      }
    } catch (err) {
      console.warn(`[llm] ${MODEL} call failed, using deterministic template: ${(err as Error).message}`);
    }
    return this.fallback.healPrompt(ev);
  }
}

// Env-gated default: Gemini when credentials exist, template otherwise.
export function defaultLlm(): LlmAdapter {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    ? new GeminiLlm()
    : new TemplateLlm();
}
