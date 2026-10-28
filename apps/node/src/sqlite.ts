import type { DatabaseSync } from "node:sqlite";
import type { Store } from "@okayed/core";

type Tx = Omit<Store, "transaction">;

/**
 * okayed's Store on SQLite (node:sqlite): one table, one row per key, each person's keys apart. A person's
 * transactions run one at a time; each buffers its writes and commits them in one synchronous SQLite transaction,
 * so nothing interleaves with it and "once means once" holds as it does in a Durable Object.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly user: string;
  private static chains = new Map<string, Promise<unknown>>();

  constructor(db: DatabaseSync, user: string) {
    this.db = db;
    this.user = user;
    db.exec("CREATE TABLE IF NOT EXISTS kv (user TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user, key)) WITHOUT ROWID");
  }

  private read(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE user = ? AND key = ?").get(this.user, key) as { value: string } | undefined)?.value;
  }

  private write(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM kv WHERE user = ? AND key = ?").run(this.user, key);
    else this.db.prepare("INSERT INTO kv (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value").run(this.user, key, value);
  }

  private scan(prefix: string): [string, string][] {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE user = ? AND key >= ? AND key < ? ORDER BY key").all(this.user, prefix, `${prefix}￿`) as { key: string; value: string }[];
    return rows.map((r) => [r.key, r.value]);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.read(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.write(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<void> {
    this.write(key, null);
  }
  async list<T>(prefix: string): Promise<Map<string, T>> {
    return new Map(this.scan(prefix).map(([k, v]) => [k, JSON.parse(v) as T]));
  }

  transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
    const run = async () => {
      // Writes wait here until the end; reads see them first.
      const pending = new Map<string, string | null>();
      const tx: Tx = {
        get: async <T>(key: string) => {
          const v = pending.has(key) ? pending.get(key) : this.read(key);
          return v == null ? undefined : (JSON.parse(v) as T);
        },
        put: async <T>(key: string, value: T) => void pending.set(key, JSON.stringify(value)),
        delete: async (key: string) => void pending.set(key, null),
        list: async <T>(prefix: string) => {
          const merged = new Map(this.scan(prefix));
          for (const [k, v] of pending) if (k.startsWith(prefix)) (v === null ? merged.delete(k) : merged.set(k, v));
          return new Map([...merged].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, JSON.parse(v) as T]));
        },
      };
      const out = await fn(tx);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const [k, v] of pending) this.write(k, v);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return out;
    };
    const prev = SqliteStore.chains.get(this.user) ?? Promise.resolve();
    const next = prev.then(run, run);
    SqliteStore.chains.set(this.user, next.catch(() => undefined));
    return next;
  }
}
