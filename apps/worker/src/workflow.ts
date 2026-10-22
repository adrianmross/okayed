import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { runGrantFlow, type FlowEvent, type FlowParams, type FlowRuntime, type FlowTarget } from "@okayed/core";
import type { OkayedAgent } from "./agent.ts";

/**
 * The grant lifecycle on Cloudflare Workflows: the same `runGrantFlow` the in-memory runtime runs, with each
 * step durable and each wait a `waitForEvent` that survives restarts.
 */
export class GrantLifecycle extends AgentWorkflow<OkayedAgent, FlowParams> {
  async run(event: AgentWorkflowEvent<FlowParams>, step: AgentWorkflowStep) {
    const agent = this.agent;
    const rt: FlowRuntime = {
      step: (name, fn) => step.do(name, fn as () => Promise<never>),
      waitFor: async (name, type, timeoutSeconds) => {
        try {
          const ev = await step.waitForEvent<FlowEvent>(name, { type, timeout: `${Math.max(1, Math.ceil(timeoutSeconds))} seconds` });
          return ev.payload;
        } catch {
          return null;
        }
      },
    };
    const target: FlowTarget = {
      proposed: (id) => agent.flowProposed(id),
      issue: (id, assurance) => agent.flowIssue(id, assurance as never),
      lapse: (id) => agent.flowLapse(id),
      decline: (id) => agent.flowDecline(id),
      expire: (id) => agent.flowExpire(id),
      revoked: (id, reason) => agent.flowRevoked(id, reason),
      now: async () => Math.floor(Date.now() / 1000),
    };
    return runGrantFlow(rt, target, event.payload);
  }
}
