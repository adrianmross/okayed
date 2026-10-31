import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { convertToModelMessages, simulateStreamingMiddleware, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { DEMO_SYSTEM, demoTools, scriptedModel, type DemoBackend } from "@okayed/core";
import type { Env } from "./env.ts";

/**
 * The demo chat, one per person: an assistant with simulated tools. Every tool call goes through the person's okayed
 * (its own Durable Object): allowed by a rule, asks with a card, or blocked. Messages persist in this object's SQLite.
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
        : wrapLanguageModel({
            // Streamed tool calls from Workers AI arrive with each argument chunk twice (workers-ai-provider 4.0.1),
            // so the model answers whole and the stream is simulated. The replies are one line anyway.
            model: createWorkersAI({ binding: this.env.AI, ...(this.env.AI_GATEWAY ? { gateway: { id: this.env.AI_GATEWAY } } : {}) })((this.env.MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast") as never),
            middleware: simulateStreamingMiddleware(),
          });
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
