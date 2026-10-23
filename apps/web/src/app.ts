import type { Snapshot } from "@okayed/core";
import type { Session } from "./session.ts";

/** What every view gets: the latest snapshot and the ways to change it. */
export interface App {
  session: Session;
  snap: Snapshot;
  busy: boolean;
  /** Calls the API and returns the result; refresh with `run` or `rerender` as needed. */
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Calls the API, shows `ok` on success or the error, then refreshes. */
  run(method: string, path: string, body?: unknown, ok?: string): void;
  rerender(): void;
}
