import type { Draft, DraftContext, Drafter } from "./ports.ts";
import { DRAFT_SCHEMA, DRAFT_SYSTEM, EXPLAIN_SYSTEM, draftUser, parseDraft } from "./prompts.ts";

export interface OpenAICompatibleOptions {
  /** Up to and including `/v1`, e.g. `https://api.openai.com/v1` or Workers AI's `…/accounts/<id>/ai/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** How it shows in the app and in evals; defaults to the model id. */
  name?: string;
  /** Some models reject `temperature` (reasoning models); null leaves it out. Default 0. */
  temperature?: number | null;
  /** Ask for DRAFT_SCHEMA itself (`json_schema`) or just any JSON (`json_object`). Default `json_schema`. */
  json?: "json_schema" | "json_object";
}

/**
 * Any model behind an OpenAI-compatible chat completions API: OpenAI, Workers AI, OpenRouter, Groq, a local Ollama
 * or vLLM. It drafts with the same prompts and schema as every other drafter, and the engine still decides.
 */
export class OpenAICompatibleDrafter implements Drafter {
  readonly name: string;
  private readonly o: OpenAICompatibleOptions;

  constructor(o: OpenAICompatibleOptions) {
    this.o = o;
    this.name = o.name ?? o.model;
  }

  private async complete(messages: { role: string; content: string }[], json: boolean): Promise<string> {
    const r = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.o.model,
        messages,
        ...(this.o.temperature === null ? {} : { temperature: this.o.temperature ?? 0 }),
        ...(json
          ? { response_format: this.o.json === "json_object" ? { type: "json_object" } : { type: "json_schema", json_schema: { name: "okayed_draft", schema: DRAFT_SCHEMA } } }
          : {}),
      }),
    });
    if (!r.ok) throw new Error(`${this.name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as { choices?: { message?: { content?: string | null } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }

  async draft(utterance: string, ctx: DraftContext): Promise<Draft> {
    const reply = await this.complete([{ role: "system", content: DRAFT_SYSTEM }, { role: "user", content: draftUser(utterance, ctx) }], true);
    return parseDraft(reply);
  }

  async explain(facts: string): Promise<string | null> {
    const reply = await this.complete([{ role: "system", content: EXPLAIN_SYSTEM }, { role: "user", content: facts }], false);
    return reply.trim() || null;
  }
}
