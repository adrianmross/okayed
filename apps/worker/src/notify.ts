import type { Notifier, PairedApprover } from "@okayed/core";

/** A nudge for an approver app: POST to its wake URL. It carries nothing; the app fetches its inbox. */
export interface WakeMessage {
  url: string;
}

/** Wakes paired approver apps through a queue, so a slow app never holds up a request. */
export class QueueNotifier implements Notifier {
  readonly name = "queue";
  private readonly queue: Queue<WakeMessage>;

  constructor(queue: Queue<WakeMessage>) {
    this.queue = queue;
  }

  async notify(approver: PairedApprover): Promise<void> {
    if (approver.wake) await this.queue.send({ url: approver.wake });
  }
}

/** The queue consumer: one empty POST per message, retried by the queue if the app doesn't answer. */
export async function wake(batch: MessageBatch<WakeMessage>): Promise<void> {
  for (const m of batch.messages) {
    try {
      const r = await fetch(m.body.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (r.ok) m.ack();
      else m.retry();
    } catch {
      m.retry();
    }
  }
}
