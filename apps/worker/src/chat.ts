import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type ModelMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { DEMO_SYSTEM, demoTools, scriptedModel, type DemoBackend } from "@okayed/core";
import type { Env } from "./env.ts";

/**
 * The demo chat, one per person: an assistant with simulated tools. Every tool call goes through the person's okayed
 * (its own Durable Object): allowed by a rule, asks with a card, or blocked. Messages persist in this object's SQLite.
 */
const SMALL_TALK = /^\s*(?:hi|hey|hello|yo|hiya|howdy|thanks|thank you|ty|good (?:morning|afternoon|evening)|what can you do|who are you|how were you built)\b[\s!.?,]*(?:there|again)?[\s!.?]*$/i;

function lastUserText(messages: ModelMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

export class OkayedChat extends AIChatAgent<Env> {
  async onChatMessage(onFinish: unknown, options?: { abortSignal?: AbortSignal }): Promise<Response> {
    // Each message costs a model call, so a person gets a few a minute; over that, the assistant says so.
    if (this.env.CHAT_LIMIT && !(await this.env.CHAT_LIMIT.limit({ key: `ai:${this.name}` })).success) {
      const id = "chat-limit";
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: "That's a lot of messages at once. Give me a minute, then ask again." });
          writer.write({ type: "text-end", id });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }
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
      // Llama calls the same tool again after its result instead of answering, so after a result it can only reply.
      // A greeting once set off a merge, so small talk gets no tools at all.
      prepareStep: ({ messages }) => (messages.at(-1)?.role === "tool" || SMALL_TALK.test(lastUserText(messages)) ? { activeTools: [] } : {}),
      ...(onFinish ? { onFinish: onFinish as never } : {}),
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    return result.toUIMessageStreamResponse();
  }
}
