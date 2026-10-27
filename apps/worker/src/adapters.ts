import { DRAFT_SCHEMA, DRAFT_SYSTEM, EXPLAIN_SYSTEM, draftUser, parseDraft, type Draft, type DraftContext, type Drafter, type Store } from "@okayed/core";

/** `Store` on Durable Object storage. The DO is the single writer for its user; transactions are atomic. */
export class DurableStore implements Store {
  constructor(private storage: DurableObjectStorage) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }
  put<T>(key: string, value: T): Promise<void> {
    return this.storage.put(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }
  list<T>(prefix: string): Promise<Map<string, T>> {
    return this.storage.list<T>({ prefix });
  }
  transaction<R>(fn: (tx: Omit<Store, "transaction">) => Promise<R>): Promise<R> {
    return this.storage.transaction(async (txn) =>
      fn({
        get: <T>(k: string) => txn.get<T>(k),
        put: <T>(k: string, v: T) => txn.put(k, v),
        delete: async (k: string) => {
          await txn.delete(k);
        },
        list: <T>(p: string) => txn.list<T>({ prefix: p }),
      }),
    );
  }
}

/** A Workers AI model (Llama 3.3 by default), in JSON mode. Its output is a draft for the engine, never a decision. */
export class WorkersAIDrafter implements Drafter {
  readonly name: string;
  /** Through an AI Gateway when one is configured: logs, caching, rate limits and analytics for every call. */
  private readonly options: AiOptions | undefined;
  constructor(
    private ai: Ai,
    private model: string,
    gateway?: string,
  ) {
    this.name = model.replace(/^@cf\//, "");
    this.options = gateway ? { gateway: { id: gateway } } : undefined;
  }

  async draft(utterance: string, ctx: DraftContext): Promise<Draft> {
    const out = (await this.ai.run(this.model as keyof AiModels, {
      messages: [
        { role: "system", content: DRAFT_SYSTEM },
        { role: "user", content: draftUser(utterance, ctx) },
      ],
      response_format: { type: "json_schema", json_schema: DRAFT_SCHEMA },
      max_tokens: 400,
      temperature: 0,
    } as never, this.options)) as { response?: unknown };
    return parseDraft(out.response);
  }

  async explain(facts: string): Promise<string | null> {
    const out = (await this.ai.run(this.model as keyof AiModels, {
      messages: [
        { role: "system", content: EXPLAIN_SYSTEM },
        { role: "user", content: facts },
      ],
      max_tokens: 120,
      temperature: 0.2,
    } as never, this.options)) as { response?: unknown };
    return typeof out.response === "string" && out.response.trim() ? out.response.trim() : null;
  }
}
