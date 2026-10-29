import { MemoryStore, settle } from "@okayed/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ScimDirectory, applyDirectory, handleScim, personBySubject, type DirectoryChange, type OrgPolicy } from "../src/index.ts";
import { person } from "./helpers.ts";

const BASE = "https://okayed.example/scim/v2";
const TOKEN = "scim-secret";

let changes: DirectoryChange[][];
let dir: ScimDirectory;
let n: number;

function scim(method: string, path: string, body?: unknown, token = TOKEN) {
  return handleScim(dir, new Request(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), path.split("?")[0]!, { token: TOKEN, base: BASE });
}
const read = async (r: Response) => (r.status === 204 ? null : ((await r.json()) as Record<string, any>));

beforeEach(() => {
  changes = [];
  n = 0;
  dir = new ScimDirectory(new MemoryStore(), { onChange: async (c) => void changes.push(c), newId: () => `id-${++n}`, now: () => new Date("2026-11-01T18:00:00Z") });
});

describe("SCIM, as Okta speaks it", () => {
  it("looks a user up, creates them, finds them, and deactivates them", async () => {
    expect((await read(await scim("GET", '/Users?filter=userName%20eq%20%22ada%40acme.dev%22&startIndex=1&count=100')))!.totalResults).toBe(0);
    const created = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "ada@acme.dev", externalId: "00u1", name: { givenName: "Ada", familyName: "Lovelace" }, emails: [{ primary: true, value: "ada@acme.dev", type: "work" }], active: true });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe(`${BASE}/Users/id-1`);
    const ada = (await read(created))!;
    expect(ada).toMatchObject({ id: "id-1", userName: "ada@acme.dev", externalId: "00u1", active: true, groups: [], meta: { resourceType: "User", location: `${BASE}/Users/id-1` } });
    const found = (await read(await scim("GET", '/Users?filter=userName eq "ADA@acme.dev"')))!;
    expect([found.totalResults, found.Resources[0].id]).toEqual([1, "id-1"]);
    expect((await scim("POST", "/Users", { userName: "Ada@Acme.dev" })).status).toBe(409);
    const off = (await read(await scim("PATCH", "/Users/id-1", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] })))!;
    expect(off.active).toBe(false);
    expect(changes.map((c) => c.map((x) => [x.user.id, x.user.active, x.before?.active ?? null]))).toEqual([[["id-1", true, null]], [["id-1", false, true]]]);
  });

  it("pushes groups and their members", async () => {
    await scim("POST", "/Users", { userName: "ada@acme.dev", externalId: "00u1" });
    await scim("POST", "/Users", { userName: "bob@acme.dev", externalId: "00u2" });
    const g = (await read(await scim("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Release Managers", members: [{ value: "id-1" }, { value: "nobody" }] })))!;
    expect(g.members).toEqual([{ value: "id-1", display: "ada@acme.dev", type: "User" }]);
    changes = [];
    await scim("PATCH", `/Groups/${g.id}`, { Operations: [{ op: "remove", path: "members", value: [{ value: "id-1" }] }, { op: "add", path: "members", value: [{ value: "id-2" }] }] });
    expect(changes[0]!.map((c) => [c.user.id, c.groups])).toEqual([["id-1", []], ["id-2", ["Release Managers"]]]);
    expect((await read(await scim("GET", "/Users/id-2")))!.groups).toEqual([{ value: g.id, display: "Release Managers" }]);
  });
});

describe("SCIM, as Microsoft Entra speaks it", () => {
  it("replaces with paths, string booleans and filtered email paths, and keeps the enterprise extension", async () => {
    const ent = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
    await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", ent], userName: "ada@acme.dev", externalId: "ada", active: true, emails: [{ primary: true, type: "work", value: "ada@acme.dev" }], [ent]: { department: "Eng" } });
    const u = (await read(await scim("PATCH", "/Users/id-1", {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "Replace", path: 'emails[type eq "work"].value', value: "ada@lovelace.dev" },
        { op: "Replace", path: "name.familyName", value: "Lovelace" },
        { op: "Add", path: `${ent}:department`, value: "Platform" },
        { op: "Replace", path: "active", value: "False" },
      ],
    })))!;
    expect(u).toMatchObject({ active: false, emails: [{ type: "work", value: "ada@lovelace.dev", primary: true }], name: { familyName: "Lovelace" }, [ent]: { department: "Platform" } });
    expect(u.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:User", ent]);
  });

  it("checks membership by filter, removes members by path filter, and skips members on request", async () => {
    await scim("POST", "/Users", { userName: "ada@acme.dev" });
    const g = (await read(await scim("POST", "/Groups", { displayName: "Ops", members: [{ value: "id-1" }] })))!;
    const hit = (await read(await scim("GET", `/Groups?filter=id eq "${g.id}" and members eq "id-1"&excludedAttributes=members`)))!;
    expect([hit.totalResults, "members" in hit.Resources[0]]).toEqual([1, false]);
    await scim("PATCH", `/Groups/${g.id}`, { Operations: [{ op: "Remove", path: 'members[value eq "id-1"]' }] });
    expect((await read(await scim("GET", `/Groups/${g.id}`)))!.members).toEqual([]);
    expect((await read(await scim("GET", '/Groups?filter=displayName eq "ops"')))!.totalResults).toBe(1);
  });
});

describe("the SCIM endpoint", () => {
  it("wants the token, says what it supports, pages, and answers in SCIM's error format", async () => {
    expect((await scim("GET", "/Users", undefined, "wrong")).status).toBe(401);
    const spc = (await read(await scim("GET", "/ServiceProviderConfig")))!;
    expect([spc.patch.supported, spc.bulk.supported, spc.filter.supported]).toEqual([true, false, true]);
    expect((await read(await scim("GET", "/ResourceTypes")))!.Resources.map((r: { id: string }) => r.id)).toEqual(["User", "Group"]);
    for (const name of ["a", "b", "c"]) await scim("POST", "/Users", { userName: name });
    const page = (await read(await scim("GET", "/Users?startIndex=2&count=1")))!;
    expect([page.totalResults, page.startIndex, page.itemsPerPage, page.Resources[0].userName]).toEqual([3, 2, 1, "b"]);
    const bad = (await read(await scim("GET", '/Users?filter=userName eq "a" or userName eq "b"')))!;
    expect(bad).toEqual({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "400", detail: "or filters aren't supported", scimType: "invalidFilter" });
    expect((await scim("GET", "/Users/nope")).status).toBe(404);
    expect((await scim("DELETE", "/Users/id-1")).status).toBe(204);
    expect((await read(await scim("GET", "/Users")))!.totalResults).toBe(2);
  });
});

describe("from the directory to each person's okayed", () => {
  const ACME: OrgPolicy = { name: "Acme", default: "deny", grants: [{ to: "*", effect: "allow", act: "github.read" }, { to: "deployers", effect: "allow", act: "site.deploy", res: "site:*/staging" }] };

  it("limits follow groups, and deactivating someone takes back everything their agents hold", async () => {
    const ada = await person("ada");
    const stops: string[] = [];
    dir = new ScimDirectory(new MemoryStore(), {
      newId: () => `id-${++n}`,
      onChange: applyDirectory(ACME, {
        personFor: async (u) => (u.externalId === "00u1" ? "ada" : null),
        setLimits: (_id, layer) => ada.svc.setCeiling("organization", layer),
        stop: async (_id, reason) => void (stops.push(reason), await ada.svc.stop(reason)),
      }),
    });
    const deploy = () => ada.svc.submitRequest(ada.agent, { act: "site.deploy", res: ["site:acme.dev/staging"], why: "x" });

    await scim("POST", "/Users", { userName: "ada@acme.dev", externalId: "00u1" });
    expect(await deploy()).toMatchObject({ status: "denied", reason: "Refused by Acme: nothing here covers site.deploy." });

    const g = (await read(await scim("POST", "/Groups", { displayName: "Deployers", members: [{ value: "id-1" }] })))!;
    const asked = await deploy();
    expect(asked.status).toBe("pending");
    await ada.svc.confirm(asked.cardId!);
    await settle();
    expect((await ada.svc.snapshot()).grants.filter((x) => x.status === "active")).toHaveLength(1);

    await scim("PATCH", "/Users/id-1", { Operations: [{ op: "replace", path: "active", value: false }] });
    const snap = await ada.svc.snapshot();
    expect(snap.grants.map((x) => [x.status, x.revokeReason])).toEqual([["revoked", "deactivated in Acme's directory"]]);
    expect(snap.paused).toBe(true);
    expect((await deploy()).reason).toBe("Refused by Acme: you're no longer active at Acme.");

    // Once: changing groups while they're inactive doesn't stop them again.
    await scim("PATCH", `/Groups/${g.id}`, { Operations: [{ op: "remove", path: "members" }] });
    expect(stops).toEqual(["deactivated in Acme's directory"]);
  });

  it("finds a person by the subject their sign-in uses", async () => {
    const find = personBySubject("https://acme.okta.com");
    const id = await find({ externalId: "00u1" } as never);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await personBySubject("https://acme.okta.com", "userName")({ userName: "ada@acme.dev" } as never)).not.toBe(id);
    expect(await find({ userName: "x" } as never)).toBeNull();
  });
});
