import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { DEMO_SYSTEM, demoTools, scriptedModel, type DemoBackend } from "@okayed/core";
import type { Env } from "./env.ts";

/**
 * The demo chat, one per person: Assistant with simulated tools. Every tool call goes through the person's okayed (its own
 * Durable Object): go ahead under policy, ask with a card, or refuse. Messages persist in this object's SQLite.
 */
export class OkayedChat extends AIChatAgent<Env> {
  async onChatMessage(onFinish: unknown, options?: { abortSignal?: AbortSignal }): Promise<Response> {
    const okayed = await getAgentByName(this.env.OkayedAgent, this.name);
    const rpc = okayed as unknown as {
      demoRequest: DemoBackend["request"];
      demoByRef: DemoBackend["byRef"];
      demoUse: DemoBackend["use"];
      demoPropose: DemoBackend["proposePolicy"];
    };
    const backend: DemoBackend = {
      request: (i) => rpc.demoRequest(i),
      byRef: (ref) => rpc.demoByRef(ref),
      use: (event, act, res) => rpc.demoUse(event, act, res),
      proposePolicy: (sentence) => rpc.demoPropose(sentence),
    };
    const { tools, toolApproval } = demoTools(backend);
    const model =
      this.env.DRAFTER === "heuristic" || !this.env.AI
        ? scriptedModel()
        : createWorkersAI({ binding: this.env.AI })((this.env.MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast") as never);
    const result = streamText({
      model,
      system: DEMO_SYSTEM,
      messages: await convertToModelMessages(this.messages),
      tools,
      toolApproval,
      stopWhen: stepCountIs(5),
      ...(onFinish ? { onFinish: onFinish as never } : {}),
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    return result.toUIMessageStreamResponse();
  }
}
