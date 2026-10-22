import type { FlowEvent, FlowParams } from "./ports.ts";

/**
 * The grant lifecycle as a durable program: propose → await confirm → issue → await revoke or expiry.
 * Written once against `FlowRuntime`; Cloudflare Workflows and the in-memory runtime both run it.
 */

export interface FlowRuntime {
  /** Runs `fn` once, durably; replays return the recorded result. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Resolves with the next event of `type`, or null after `timeoutSeconds`. */
  waitFor(name: string, type: FlowEvent["type"], timeoutSeconds: number): Promise<FlowEvent | null>;
}

/** What the flow calls on the user's state. Every method is idempotent. */
export interface FlowTarget {
  proposed(proposalId: string): Promise<{ open: boolean }>;
  issue(proposalId: string, assurance: Extract<FlowEvent, { decision: "confirm" }>["assurance"] | { method: "policy"; at: number }): Promise<{ grantId: string; exp: number } | null>;
  lapse(proposalId: string): Promise<void>;
  decline(proposalId: string): Promise<void>;
  expire(grantId: string): Promise<void>;
  revoked(grantId: string, reason: string): Promise<void>;
  now(): Promise<number>;
}

export type FlowOutcome = "lapsed" | "denied" | "refused" | "revoked" | "expired" | "closed";

export async function runGrantFlow(rt: FlowRuntime, target: FlowTarget, p: FlowParams): Promise<FlowOutcome> {
  const { open } = await rt.step("propose", () => target.proposed(p.proposalId));
  if (!open) return "closed";

  let assurance: Parameters<FlowTarget["issue"]>[1];
  if (p.auto) {
    assurance = { method: "policy", at: await rt.step("auto-approved at", () => target.now()) };
  } else {
    const ev = await rt.waitFor("await decision", "decision", p.waitSeconds);
    if (!ev || ev.type !== "decision") {
      await rt.step("lapse", () => target.lapse(p.proposalId));
      return "lapsed";
    }
    if (ev.decision === "deny") {
      await rt.step("decline", () => target.decline(p.proposalId));
      return "denied";
    }
    assurance = ev.assurance;
  }

  const issued = await rt.step("issue", () => target.issue(p.proposalId, assurance));
  if (!issued) return "refused";

  const now = await rt.step("issued at", () => target.now());
  const ev = await rt.waitFor("await revoke or expiry", "revoke", Math.max(1, issued.exp - now));
  if (ev && ev.type === "revoke") {
    await rt.step("revoked", () => target.revoked(issued.grantId, ev.reason));
    return "revoked";
  }
  await rt.step("expire", () => target.expire(issued.grantId));
  return "expired";
}
