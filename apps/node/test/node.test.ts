import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { okayedServer } from "../src/server.ts";
import { SqliteStore } from "../src/sqlite.ts";

describe("SqliteStore", () => {
  it("keeps people apart, and commits a transaction whole or not at all", async () => {
    const db = new DatabaseSync(":memory:");
    const a = new SqliteStore(db, "a");
    const b = new SqliteStore(db, "b");
    await a.put("k", 1);
    expect(await b.get("k")).toBeUndefined();
    await expect(
      a.transaction(async (tx) => {
        await tx.put("k", 2);
        await tx.put("other", 3);
        expect(await tx.get("k")).toBe(2);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await a.get("k")).toBe(1);
    expect(await a.get("other")).toBeUndefined();
    await a.transaction(async (tx) => {
      await tx.put("p:2", "two");
      await tx.put("p:1", "one");
      await tx.delete("k");
      expect([...(await tx.list("p:")).keys()]).toEqual(["p:1", "p:2"]);
    });
    expect(await a.get("k")).toBeUndefined();
    expect([...(await a.list<string>("p:")).values()]).toEqual(["one", "two"]);
  });

  it("runs one person's transactions one at a time", async () => {
    const s = new SqliteStore(new DatabaseSync(":memory:"), "u");
    await s.put("n", 0);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        s.transaction(async (tx) => {
          const n = (await tx.get<number>("n"))!;
          await new Promise((r) => setTimeout(r, 1));
          await tx.put("n", n + 1);
        }),
      ),
    );
    expect(await s.get("n")).toBe(20);
  });
});

describe("okayed on Node", () => {
  const server = okayedServer({ secret: "44".repeat(32), db: ":memory:" });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  it("serves the same API: a request, the person's okay, a signed grant, one use", async () => {
    const { body: me } = await call("POST", "/api/users");
    const u = `/api/u/${me.userId}`;
    await call("PUT", `${u}/policy`, me.ownerToken, { rules: [] });
    const { body: agent } = await call("POST", `${u}/agents`, me.ownerToken, { name: "ci" });
    const res = "github:adrianmross/okayed";
    const { status, body: asked } = await call("POST", `${u}/requests`, agent.token, { act: "github.read", res: [res], why: "release notes" });
    expect([status, asked.status]).toEqual([202, "pending"]);
    await call("POST", `${u}/cards/${asked.cardId}/confirm`, me.ownerToken);
    let st: Record<string, any> = {};
    for (let i = 0; i < 20 && st.status !== "granted"; i++) st = (await call("GET", `${u}/requests/${asked.request.id}?wait=1`, agent.token)).body;
    expect(st.grant.kind).toBe(4841);
    const use = { event: st.grant, aud: agent.id, act: "github.read", res, consume: true };
    expect((await call("POST", `${u}/verify`, undefined, use)).body.ok).toBe(true);
    expect((await call("GET", `${u}/state`, "own_wrong")).status).toBe(401);
    expect((await call("GET", `/api/u/${"0".repeat(32)}/state`, me.ownerToken)).status).toBe(404);
  });
});
