import { deriveIssuerKey, hexToBytes, publicKeyOf, signEvent, type EventTemplate, type NostrEvent } from "@okayed/grant";
import { runGrantFlow, type FlowRuntime, type FlowTarget } from "./flow.ts";
import type { Clock, FlowEvent, FlowParams, Lifecycle, Randomness, Signer, Store } from "./ports.ts";

/** In-memory `Store`. Transactions are serialized and roll back on throw. */
export class MemoryStore implements Store {
  private data = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list<T>(prefix: string): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.data].sort(([a], [b]) => (a < b ? -1 : 1))) if (k.startsWith(prefix)) out.set(k, JSON.parse(v) as T);
    return out;
  }
  transaction<R>(fn: (tx: Omit<Store, "transaction">) => Promise<R>): Promise<R> {
    const run = async () => {
      const snapshot = new Map(this.data);
      try {
        return await fn(this);
      } catch (e) {
        this.data = snapshot;
        throw e;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** A clock tests move by hand. Timers fire in order when time passes them. */
export class ManualClock implements Clock {
  private timers: { at: number; fire: () => void }[] = [];
  private t: number;
  constructor(t: number) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  at(when: number, fire: () => void): () => void {
    const timer = { at: when, fire };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }
  /** Moves time forward, firing due timers, and lets the resulting work settle. */
  async advance(seconds: number): Promise<void> {
    const target = this.t + seconds;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fire();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Math.floor(Date.now() / 1000);
  }
}

/** Lets queued promise chains run to completion. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

export const cryptoRandom: Randomness = {
  hex(bytes: number): string {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  },
};

export class KeySigner implements Signer {
  readonly pubkey: string;
  private readonly sk: Uint8Array;
  constructor(sk: Uint8Array) {
    this.sk = sk;
    this.pubkey = publicKeyOf(sk);
  }
  static forUser(serviceSecretHex: string, userId: string): KeySigner {
    return new KeySigner(deriveIssuerKey(hexToBytes(serviceSecretHex), userId));
  }
  async sign(t: EventTemplate): Promise<NostrEvent> {
    return signEvent(t, this.sk);
  }
}

/**
 * Runs `runGrantFlow` in-process. Steps run immediately; waits resolve on `send` or when the clock passes the
 * timeout. Not durable: a restart forgets flows. Fine for tests, local dev and single-process deployments.
 */
export class InlineLifecycle implements Lifecycle {
  private waiters = new Map<string, { type: FlowEvent["type"]; resolve: (e: FlowEvent | null) => void }>();
  private early = new Map<string, FlowEvent[]>();
  readonly outcomes = new Map<string, string>();
  target!: FlowTarget;

  private readonly clock: ManualClock | { at?: undefined; now(): number };
  constructor(clock: ManualClock | { at?: undefined; now(): number }) {
    this.clock = clock;
  }

  async start(id: string, params: FlowParams): Promise<void> {
    const rt: FlowRuntime = {
      step: (_name, fn) => fn(),
      waitFor: (_name, type, timeout) =>
        new Promise((resolve) => {
          const queued = this.early.get(id)?.find((e) => e.type === type);
          if (queued) {
            this.early.set(id, this.early.get(id)!.filter((e) => e !== queued));
            resolve(queued);
            return;
          }
          let cancel = () => {};
          const done = (e: FlowEvent | null) => {
            cancel();
            this.waiters.delete(id);
            resolve(e);
          };
          this.waiters.set(id, { type, resolve: done });
          if (this.clock instanceof ManualClock) cancel = this.clock.at(this.clock.now() + timeout, () => done(null));
          else {
            const h = setTimeout(() => done(null), timeout * 1000);
            cancel = () => clearTimeout(h);
          }
        }),
    };
    void runGrantFlow(rt, this.target, params).then((o) => this.outcomes.set(id, o));
  }

  async send(id: string, event: FlowEvent): Promise<void> {
    const w = this.waiters.get(id);
    if (w && w.type === event.type) w.resolve(event);
    else this.early.set(id, [...(this.early.get(id) ?? []), event]);
    await settle();
  }
}
