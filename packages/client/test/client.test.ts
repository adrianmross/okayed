import { describe, expect, it } from "vitest";
import { OkayedClient, prResource } from "../src/index.ts";

const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";
const grant = { id: "g1", act: "github.pr.merge", res: [prResource("o", "r", 1, SHA)], aud: "agent:assistant", exp: 9, uses: 1, when: [], assurance: { method: "web-click", at: 1 } };
const event = { id: "e", pubkey: "p", kind: 4841, created_at: 1, tags: [], content: JSON.stringify(grant), sig: "s" };

function fake(script: Record<string, unknown[]>) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname.replace(/^\/api\/u\/u1/, "")}`;
    calls.push(`${key}${new URL(url).search}`);
    const next = script[key]?.shift();
    return next instanceof Response ? next : Response.json(next ?? { error: "unexpected" }, { status: next ? 200 : 500 });
  }) as typeof fetch;
  return { f, calls };
}

describe("OkayedClient", () => {
  it("asks, long-polls until the person decides, and parses the grant", async () => {
    const { f, calls } = fake({
      "POST /requests": [{ request: { id: "r_1" }, status: "pending" }],
      "GET /requests/r_1": [{ status: "pending" }, { status: "granted", grant: event }],
    });
    const c = new OkayedClient({ api: "https://ok.test/", user: "u1", token: "agt_x", fetch: f });
    const a = await c.ask("github.pr.merge", [prResource("o", "r", 1, SHA)], "tests pass", 60);
    expect(a).toMatchObject({ request: "r_1", status: "granted", grant: { act: "github.pr.merge", uses: 1 } });
    expect(calls).toEqual(["POST /requests", "GET /requests/r_1?wait=20", "GET /requests/r_1?wait=20"]);
  });

  it("treats a standing-policy approval as pending until the grant is issued", async () => {
    const { f } = fake({ "POST /requests": [{ request: { id: "r_2" }, status: "approving" }], "GET /requests/r_2": [{ status: "granted", grant: event }] });
    const a = await new OkayedClient({ api: "https://ok.test", user: "u1", token: "t", fetch: f }).ask("github.read", ["github:o/r"]);
    expect(a.status).toBe("granted");
  });

  it("surfaces refusals and errors", async () => {
    const { f } = fake({ "POST /requests": [{ request: { id: "r_3" }, status: "denied", reason: "never deploy to production" }] });
    const c = new OkayedClient({ api: "https://ok.test", user: "u1", token: "t", fetch: f });
    expect(await c.ask("site.deploy", ["site:x.org/production"])).toMatchObject({ status: "denied", reason: "never deploy to production" });
    await expect(c.merge(event, { owner: "o", repo: "r", number: 1, sha: SHA })).rejects.toThrow(/unexpected/);
  });
});
