import { userForSubject, type Store } from "@okayed/core";
import type { Layer } from "@okayed/engine";
import { ceilingFor, type OrgPolicy } from "./org.ts";
import { groupName, type Principal } from "./principal.ts";

/**
 * A SCIM 2.0 service provider (RFC 7643, 7644): the endpoint an organization's identity provider (Okta, Microsoft
 * Entra, Google, JumpCloud…) provisions its people and groups into. okayed uses it two ways. Groups decide each
 * person's organization limits, and they follow every change the moment the IdP sends it. Removing or deactivating
 * someone stops their okayed: every permission their agents hold is taken back.
 *
 * It runs on okayed's `Store` port, so it works wherever okayed core does. It implements what IdPs use: Users and
 * Groups with create, read, replace, PATCH and delete; `eq`-style filters joined by `and`; paging; and the discovery
 * endpoints. Not bulk, sort, ETags or `or` filters.
 */

export const SCIM = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  enterprise: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  config: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const;

export interface ScimMeta {
  resourceType: "User" | "Group";
  created: string;
  lastModified: string;
  location?: string;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  emails?: { value: string; type?: string; primary?: boolean }[];
  roles?: { value: string; type?: string; primary?: boolean }[];
  entitlements?: { value: string }[];
  active: boolean;
  /** Read-only: the groups they're in, computed. */
  groups?: { value: string; display: string }[];
  meta: ScimMeta;
  [extension: string]: unknown;
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: { value: string; display?: string; type?: string }[];
  meta: ScimMeta;
}

/** One person whose standing changed: created, edited, deactivated, removed, or added to or taken out of a group. */
export interface DirectoryChange {
  /** As they are now, or as they were when removed. */
  user: ScimUser;
  before: ScimUser | null;
  removed: boolean;
  /** Their groups' names, now. */
  groups: string[];
}

export class ScimError extends Error {
  readonly status: number;
  readonly scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

export interface DirectoryOptions {
  /** Told after every write, with everyone it affected. Errors are logged, not returned to the IdP. */
  onChange?: (changes: DirectoryChange[]) => Promise<void>;
  now?: () => Date;
  newId?: () => string;
}

const USERS = "scim:u:";
const GROUPS = "scim:g:";
const READ_ONLY = new Set(["id", "meta", "schemas", "groups"]);
const CORE_PREFIX = /^urn:ietf:params:scim:schemas:core:2\.0:(?:User|Group):/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** SCIM says booleans, but IdPs send "True" and "False" too. */
function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  return fallback;
}

// ---------- PATCH paths: attr, attr.sub, attr[sub eq "x"].field, and extension attributes ----------

interface Path {
  ext?: string;
  attr: string;
  filter?: { attr: string; value: string };
  sub?: string;
}

function parsePath(raw: string): Path {
  let p = raw.trim().replace(CORE_PREFIX, "");
  let ext: string | undefined;
  if (p.startsWith("urn:")) {
    const cut = p.lastIndexOf(":");
    ext = p.slice(0, cut);
    p = p.slice(cut + 1);
  }
  const m = /^([A-Za-z][\w-]*)(?:\[\s*([A-Za-z][\w-]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\])?(?:\.([A-Za-z][\w-]*))?$/.exec(p);
  if (!m) throw new ScimError(400, `can't follow the path ${raw}`, "invalidPath");
  return { ...(ext ? { ext } : {}), attr: m[1]!, ...(m[2] ? { filter: { attr: m[2], value: m[3]!.replace(/\\(.)/g, "$1") } } : {}), ...(m[4] ? { sub: m[4] } : {}) };
}

function apply(target: Obj, op: "add" | "replace" | "remove", rawPath: string | undefined, value: unknown): void {
  if (!rawPath) {
    if (op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
    if (!isObj(value)) throw new ScimError(400, `${op} without a path needs an object of attributes`, "invalidValue");
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("urn:") && isObj(v) && !CORE_PREFIX.test(`${k}:`)) target[k] = { ...(isObj(target[k]) ? target[k] : {}), ...v };
      else apply(target, op, k, v);
    }
    return;
  }
  const path = parsePath(rawPath);
  if (!path.ext && READ_ONLY.has(path.attr)) return;
  const on: Obj = path.ext ? ((target[path.ext] = isObj(target[path.ext]) ? target[path.ext] : {}) as Obj) : target;
  const { attr, filter, sub } = path;
  if (filter) {
    const list = (Array.isArray(on[attr]) ? on[attr] : []) as Obj[];
    const hit = (e: Obj) => String(e[filter.attr] ?? "").toLowerCase() === filter.value.toLowerCase();
    if (op === "remove") {
      on[attr] = sub ? list.map((e) => (hit(e) ? (({ [sub]: _x, ...rest }) => rest)(e) : e)) : list.filter((e) => !hit(e));
      return;
    }
    let el = list.find(hit);
    if (!el) list.push((el = { [filter.attr]: filter.value }));
    if (sub) el[sub] = value;
    else if (isObj(value)) Object.assign(el, value);
    on[attr] = list;
    return;
  }
  if (sub) {
    const inner = (on[attr] = isObj(on[attr]) ? on[attr] : {}) as Obj;
    if (op === "remove") delete inner[sub];
    else inner[sub] = value;
    return;
  }
  if (op === "remove") {
    // "remove members" with a value takes out just those; without one, everyone.
    if (Array.isArray(on[attr]) && Array.isArray(value)) {
      const out = new Set(value.map((v) => (isObj(v) ? String(v.value) : String(v))));
      on[attr] = (on[attr] as Obj[]).filter((e) => !out.has(String(e.value)));
    } else delete on[attr];
    return;
  }
  if (op === "add" && Array.isArray(on[attr]) && Array.isArray(value)) on[attr] = [...(on[attr] as unknown[]), ...value];
  else on[attr] = value;
}

function patchOps(body: unknown): { op: "add" | "replace" | "remove"; path?: string; value?: unknown }[] {
  if (!isObj(body) || !Array.isArray(body.Operations)) throw new ScimError(400, "a PATCH needs Operations", "invalidSyntax");
  return body.Operations.map((o, i) => {
    const op = isObj(o) && typeof o.op === "string" ? o.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimError(400, `operation ${i + 1}: op must be add, replace or remove`, "invalidSyntax");
    return { op, ...(typeof o.path === "string" && o.path ? { path: o.path } : {}), ...("value" in o ? { value: o.value } : {}) };
  });
}

// ---------- filters: attr op "value", joined by and ----------

interface Clause {
  path: string;
  op: string;
  value?: string | number | boolean | null;
}

const CASE_EXACT = new Set(["id", "externalId", "members", "members.value"]);

function parseFilter(f: string): Clause[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < f.length; i++) {
    const c = f[i]!;
    if (c === '"' && f[i - 1] !== "\\") quoted = !quoted;
    if (!quoted && /^\s+and\s+/i.test(f.slice(i)) && cur.trim()) {
      parts.push(cur);
      cur = "";
      i += /^\s+and\s+/i.exec(f.slice(i))![0].length - 1;
      continue;
    }
    if (!quoted && (c === "(" || c === ")")) throw new ScimError(400, "grouped filters aren't supported", "invalidFilter");
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => {
    if (/\s+or\s+/i.test(p.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new ScimError(400, "or filters aren't supported", "invalidFilter");
    const pr = /^\s*([A-Za-z][\w.:-]*)\s+pr\s*$/i.exec(p);
    if (pr) return { path: pr[1]!.replace(CORE_PREFIX, ""), op: "pr" };
    const m = /^\s*([A-Za-z][\w.:-]*)\s+(eq|ne|co|sw|ew)\s+("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)\s*$/i.exec(p);
    if (!m) throw new ScimError(400, `can't read the filter "${p.trim()}"`, "invalidFilter");
    const raw = m[3]!;
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw);
    return { path: m[1]!.replace(CORE_PREFIX, ""), op: m[2]!.toLowerCase(), value };
  });
}

/** Every value at a path; multi-valued attributes give each element's `value`. */
function valuesAt(r: Obj, path: string): unknown[] {
  let cur: unknown[] = [r];
  for (const k of path.split(".")) {
    cur = cur.flatMap((x) => (isObj(x) ? (Array.isArray(x[k]) ? (x[k] as unknown[]) : x[k] === undefined ? [] : [x[k]]) : []));
  }
  return cur.map((x) => (isObj(x) && "value" in x ? x.value : x)).filter((x) => x !== undefined);
}

function matches(r: Obj, clauses: Clause[]): boolean {
  return clauses.every(({ path, op, value }) => {
    const vals = valuesAt(r, path);
    if (op === "pr") return vals.some((v) => v !== null && v !== "");
    const exact = CASE_EXACT.has(path);
    const norm = (v: unknown) => (typeof v === "string" && !exact ? v.toLowerCase() : v);
    const want = norm(value);
    const test = (v: unknown) => {
      const got = norm(v);
      if (op === "eq") return got === want;
      if (op === "ne") return got !== want;
      if (typeof got !== "string" || typeof want !== "string") return false;
      return op === "co" ? got.includes(want) : op === "sw" ? got.startsWith(want) : got.endsWith(want);
    };
    return op === "ne" ? vals.every(test) : vals.some(test);
  });
}

// ---------- the directory ----------

export class ScimDirectory {
  private readonly store: Store;
  private readonly o: DirectoryOptions;
  constructor(store: Store, o: DirectoryOptions = {}) {
    this.store = store;
    this.o = o;
  }

  private timestamp(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private newId(): string {
    return this.o.newId?.() ?? crypto.randomUUID();
  }

  async users(): Promise<ScimUser[]> {
    return [...(await this.store.list<ScimUser>(USERS)).values()].sort((a, b) => (a.meta.created < b.meta.created ? -1 : a.meta.created > b.meta.created ? 1 : a.id < b.id ? -1 : 1));
  }
  async groups(): Promise<ScimGroup[]> {
    return [...(await this.store.list<ScimGroup>(GROUPS)).values()].sort((a, b) => (a.meta.created < b.meta.created ? -1 : a.meta.created > b.meta.created ? 1 : a.id < b.id ? -1 : 1));
  }
  async user(id: string): Promise<ScimUser | null> {
    const u = await this.store.get<ScimUser>(USERS + id);
    return u ? { ...u, groups: (await this.groupsOf(id)).map((g) => ({ value: g.id, display: g.displayName })) } : null;
  }
  async group(id: string): Promise<ScimGroup | null> {
    return (await this.store.get<ScimGroup>(GROUPS + id)) ?? null;
  }
  async groupsOf(userId: string): Promise<ScimGroup[]> {
    return (await this.groups()).filter((g) => g.members.some((m) => m.value === userId));
  }

  async listUsers(filter?: string): Promise<ScimUser[]> {
    const clauses = filter ? parseFilter(filter) : [];
    const groups = await this.groups();
    return (await this.users())
      .map((u) => ({ ...u, groups: groups.filter((g) => g.members.some((m) => m.value === u.id)).map((g) => ({ value: g.id, display: g.displayName })) }))
      .filter((u) => matches(u as Obj, clauses));
  }
  async listGroups(filter?: string): Promise<ScimGroup[]> {
    const clauses = filter ? parseFilter(filter) : [];
    return (await this.groups()).filter((g) => matches(g as unknown as Obj, clauses));
  }

  /** A user from what the IdP sent: core attributes and extension objects, nothing else. */
  private readUser(body: unknown, base?: ScimUser): ScimUser {
    if (!isObj(body)) throw new ScimError(400, "a user must be an object", "invalidSyntax");
    if (typeof body.userName !== "string" || !body.userName.trim()) throw new ScimError(400, "userName is required", "invalidValue");
    const now = this.timestamp();
    const u: ScimUser = {
      schemas: [SCIM.user],
      id: base?.id ?? this.newId(),
      userName: body.userName.trim(),
      active: bool(body.active, true),
      meta: { resourceType: "User", created: base?.meta.created ?? now, lastModified: now },
    };
    if (typeof body.externalId === "string" && body.externalId) u.externalId = body.externalId;
    if (typeof body.displayName === "string" && body.displayName) u.displayName = body.displayName;
    if (isObj(body.name)) u.name = body.name as ScimUser["name"];
    for (const k of ["emails", "roles", "entitlements"] as const) if (Array.isArray(body[k])) (u as Obj)[k] = (body[k] as unknown[]).filter(isObj);
    for (const [k, v] of Object.entries(body)) {
      if (k.startsWith("urn:") && isObj(v)) {
        u[k] = v;
        if (!u.schemas.includes(k)) u.schemas.push(k);
      }
    }
    return u;
  }

  private async unique(tx: Pick<Store, "list">, u: ScimUser): Promise<void> {
    for (const other of (await tx.list<ScimUser>(USERS)).values()) {
      if (other.id !== u.id && other.userName.toLowerCase() === u.userName.toLowerCase()) throw new ScimError(409, `a user named ${u.userName} already exists`, "uniqueness");
    }
  }

  private async writeUser(u: ScimUser, before: ScimUser | null): Promise<ScimUser> {
    const { groups: _computed, ...stored } = u;
    await this.store.transaction(async (tx) => {
      if (before && !(await tx.get(USERS + u.id))) throw new ScimError(404, `no user ${u.id}`);
      await this.unique(tx, u);
      await tx.put(USERS + u.id, stored);
    });
    await this.notify([u.id], new Map([[u.id, before]]));
    return (await this.user(u.id))!;
  }

  async createUser(body: unknown): Promise<ScimUser> {
    return this.writeUser(this.readUser(body), null);
  }

  async replaceUser(id: string, body: unknown): Promise<ScimUser> {
    const before = await this.user(id);
    if (!before) throw new ScimError(404, `no user ${id}`);
    return this.writeUser(this.readUser(body, before), before);
  }

  async patchUser(id: string, body: unknown): Promise<ScimUser> {
    const before = await this.user(id);
    if (!before) throw new ScimError(404, `no user ${id}`);
    const next = structuredClone(before) as Obj;
    for (const op of patchOps(body)) apply(next, op.op, op.path, op.value);
    return this.writeUser(this.readUser(next, before), before);
  }

  async deleteUser(id: string): Promise<void> {
    const before = await this.user(id);
    if (!before) throw new ScimError(404, `no user ${id}`);
    await this.store.transaction(async (tx) => {
      await tx.delete(USERS + id);
      for (const [key, g] of await tx.list<ScimGroup>(GROUPS)) {
        if (g.members.some((m) => m.value === id)) await tx.put(key, { ...g, members: g.members.filter((m) => m.value !== id) });
      }
    });
    await this.notify([id], new Map([[id, before]]), new Set([id]));
  }

  /** A group from what the IdP sent; members who aren't users here are left out. */
  private async readGroup(body: unknown, base?: ScimGroup): Promise<ScimGroup> {
    if (!isObj(body)) throw new ScimError(400, "a group must be an object", "invalidSyntax");
    if (typeof body.displayName !== "string" || !body.displayName.trim()) throw new ScimError(400, "displayName is required", "invalidValue");
    const now = this.timestamp();
    const seen = new Set<string>();
    const members: ScimGroup["members"] = [];
    for (const m of Array.isArray(body.members) ? body.members : []) {
      const id = isObj(m) ? String(m.value ?? "") : "";
      if (!id || seen.has(id)) continue;
      const u = await this.store.get<ScimUser>(USERS + id);
      if (!u) continue;
      seen.add(id);
      members.push({ value: id, display: u.displayName ?? u.userName, type: "User" });
    }
    return {
      schemas: [SCIM.group],
      id: base?.id ?? this.newId(),
      ...(typeof body.externalId === "string" && body.externalId ? { externalId: body.externalId } : {}),
      displayName: body.displayName.trim(),
      members,
      meta: { resourceType: "Group", created: base?.meta.created ?? now, lastModified: now },
    };
  }

  private async writeGroup(g: ScimGroup, before: ScimGroup | null): Promise<ScimGroup> {
    await this.store.transaction(async (tx) => {
      if (before && !(await tx.get(GROUPS + g.id))) throw new ScimError(404, `no group ${g.id}`);
      for (const other of (await tx.list<ScimGroup>(GROUPS)).values()) {
        if (other.id !== g.id && other.displayName.toLowerCase() === g.displayName.toLowerCase()) throw new ScimError(409, `a group named ${g.displayName} already exists`, "uniqueness");
      }
      await tx.put(GROUPS + g.id, g);
    });
    // Everyone who joined or left, and everyone in it if its name changed (policies grant by name).
    const was = new Set(before?.members.map((m) => m.value) ?? []);
    const now = new Set(g.members.map((m) => m.value));
    const renamed = before && before.displayName !== g.displayName;
    const touched = [...new Set([...was, ...now])].filter((id) => renamed || was.has(id) !== now.has(id));
    await this.notify(touched);
    return g;
  }

  async createGroup(body: unknown): Promise<ScimGroup> {
    return this.writeGroup(await this.readGroup(body), null);
  }

  async replaceGroup(id: string, body: unknown): Promise<ScimGroup> {
    const before = await this.group(id);
    if (!before) throw new ScimError(404, `no group ${id}`);
    return this.writeGroup(await this.readGroup(body, before), before);
  }

  async patchGroup(id: string, body: unknown): Promise<ScimGroup> {
    const before = await this.group(id);
    if (!before) throw new ScimError(404, `no group ${id}`);
    const next = structuredClone(before) as unknown as Obj;
    for (const op of patchOps(body)) apply(next, op.op, op.path, op.value);
    return this.writeGroup(await this.readGroup(next, before), before);
  }

  async deleteGroup(id: string): Promise<void> {
    const before = await this.group(id);
    if (!before) throw new ScimError(404, `no group ${id}`);
    await this.store.delete(GROUPS + id);
    await this.notify(before.members.map((m) => m.value));
  }

  /** Everyone in the directory, as changes: to push every person's limits again, e.g. after the policy changes. */
  async everyone(): Promise<DirectoryChange[]> {
    const users = await this.users();
    return Promise.all(users.map(async (u) => ({ user: (await this.user(u.id))!, before: null, removed: false, groups: (await this.groupsOf(u.id)).map((g) => g.displayName) })));
  }

  private async notify(ids: string[], before = new Map<string, ScimUser | null>(), removed = new Set<string>()): Promise<void> {
    if (!this.o.onChange || !ids.length) return;
    const changes: DirectoryChange[] = [];
    for (const id of ids) {
      const now = removed.has(id) ? before.get(id) ?? null : await this.user(id);
      if (!now) continue;
      changes.push({ user: now, before: before.has(id) ? before.get(id)! : now, removed: removed.has(id), groups: removed.has(id) ? [] : (now.groups ?? []).map((g) => g.display) });
    }
    try {
      await this.o.onChange(changes);
    } catch (e) {
      console.error("directory change not applied", e);
    }
  }
}

// ---------- HTTP ----------

export interface ScimEndpoint {
  /** The bearer token the identity provider is set up with; checked in constant time. */
  token: string;
  /** Where this endpoint is reached, for `meta.location`: `https://okayed.example/scim/v2`. */
  base: string;
}

async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const u = new Uint8Array(x!);
  const v = new Uint8Array(y!);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i]! ^ v[i]!;
  return d === 0;
}

function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/scim+json; charset=utf-8", ...headers } });
}

function scimError(status: number, detail: string, scimType?: string): Response {
  return scimJson({ schemas: [SCIM.error], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
}

/**
 * Serves SCIM at `path`, the part after the endpoint's base (`/Users`, `/Groups/<id>`, `/ServiceProviderConfig`).
 * Mount it at `/scim/v2` and give the IdP that URL and the token.
 */
export async function handleScim(dir: ScimDirectory, req: Request, path: string, o: ScimEndpoint): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!o.token || !auth.startsWith("Bearer ") || !(await same(auth.slice(7).trim(), o.token))) return scimError(401, "a valid bearer token is required");
  const url = new URL(req.url);
  const p = path.replace(/\/+$/, "") || "/";
  const located = <T extends { id: string; meta: ScimMeta }>(r: T): T => ({ ...r, meta: { ...r.meta, location: `${o.base}/${r.meta.resourceType}s/${r.id}` } });
  const dropMembers = url.searchParams.get("excludedAttributes")?.split(",").map((s) => s.trim()).includes("members");
  const group = (g: ScimGroup) => (dropMembers ? (({ members: _m, ...rest }) => rest)(located(g)) : located(g));
  const body = async () => {
    try {
      return (await req.json()) as unknown;
    } catch {
      throw new ScimError(400, "the body isn't JSON", "invalidSyntax");
    }
  };
  const page = <T>(all: T[], map: (x: T) => unknown) => {
    const start = Math.max(1, Number(url.searchParams.get("startIndex")) || 1);
    const count = Math.min(200, Math.max(0, url.searchParams.has("count") ? Number(url.searchParams.get("count")) || 0 : 100));
    const items = all.slice(start - 1, start - 1 + count);
    return scimJson({ schemas: [SCIM.list], totalResults: all.length, startIndex: start, itemsPerPage: items.length, Resources: items.map(map) });
  };
  try {
    const m = /^\/(Users|Groups)(?:\/([^/]+))?$/.exec(p);
    if (req.method === "GET" && p === "/ServiceProviderConfig") {
      return scimJson({
        schemas: [SCIM.config],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "The SCIM token this okayed deployment is set up with", primary: true }],
        meta: { resourceType: "ServiceProviderConfig", location: `${o.base}/ServiceProviderConfig` },
      });
    }
    if (req.method === "GET" && p === "/ResourceTypes") {
      const types = [
        { schemas: [SCIM.resourceType], id: "User", name: "User", endpoint: "/Users", schema: SCIM.user, schemaExtensions: [{ schema: SCIM.enterprise, required: false }], meta: { resourceType: "ResourceType", location: `${o.base}/ResourceTypes/User` } },
        { schemas: [SCIM.resourceType], id: "Group", name: "Group", endpoint: "/Groups", schema: SCIM.group, meta: { resourceType: "ResourceType", location: `${o.base}/ResourceTypes/Group` } },
      ];
      return scimJson({ schemas: [SCIM.list], totalResults: types.length, startIndex: 1, itemsPerPage: types.length, Resources: types });
    }
    if (req.method === "GET" && p === "/Schemas") {
      const schemas = [
        { id: SCIM.user, name: "User", attributes: [] },
        { id: SCIM.group, name: "Group", attributes: [] },
        { id: SCIM.enterprise, name: "EnterpriseUser", attributes: [] },
      ].map((s) => ({ schemas: [SCIM.schema], ...s, meta: { resourceType: "Schema", location: `${o.base}/Schemas/${s.id}` } }));
      return scimJson({ schemas: [SCIM.list], totalResults: schemas.length, startIndex: 1, itemsPerPage: schemas.length, Resources: schemas });
    }
    if (!m) return scimError(404, `nothing at ${p}`);
    const [, kind, id] = m;
    const filter = url.searchParams.get("filter") ?? undefined;
    if (kind === "Users") {
      if (!id && req.method === "GET") return page(await dir.listUsers(filter), located);
      if (!id && req.method === "POST") {
        const u = located(await dir.createUser(await body()));
        return scimJson(u, 201, { location: u.meta.location! });
      }
      if (id && req.method === "GET") {
        const u = await dir.user(id);
        return u ? scimJson(located(u)) : scimError(404, `no user ${id}`);
      }
      if (id && req.method === "PUT") return scimJson(located(await dir.replaceUser(id, await body())));
      if (id && req.method === "PATCH") return scimJson(located(await dir.patchUser(id, await body())));
      if (id && req.method === "DELETE") return (await dir.deleteUser(id), scimJson(null, 204));
    } else {
      if (!id && req.method === "GET") return page(await dir.listGroups(filter), group);
      if (!id && req.method === "POST") {
        const g = located(await dir.createGroup(await body()));
        return scimJson(g, 201, { location: g.meta.location! });
      }
      if (id && req.method === "GET") {
        const g = await dir.group(id);
        return g ? scimJson(group(g)) : scimError(404, `no group ${id}`);
      }
      if (id && req.method === "PUT") return scimJson(group(await dir.replaceGroup(id, await body())));
      if (id && req.method === "PATCH") return scimJson(group(await dir.patchGroup(id, await body())));
      if (id && req.method === "DELETE") return (await dir.deleteGroup(id), scimJson(null, 204));
    }
    return scimError(405, `${req.method} isn't supported on ${p}`);
  } catch (e) {
    if (e instanceof ScimError) return scimError(e.status, e.message, e.scimType);
    console.error(e);
    return scimError(500, "internal error");
  }
}

// ---------- from the directory to each person's okayed ----------

/** A directory user as a principal: their groups and roles, and whether they're active. */
export function principalFromScim(user: ScimUser, groups: string[], issuer = "scim"): Principal {
  const email = user.emails?.find((e) => e.primary)?.value ?? user.emails?.[0]?.value ?? (user.userName.includes("@") ? user.userName : undefined);
  const name = user.displayName ?? user.name?.formatted;
  return {
    id: `scim:${user.id}`,
    issuer,
    subject: user.externalId ?? user.userName,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    groups: [...new Set(groups.map(groupName).filter((g): g is string => !!g))],
    roles: [...new Set([...(user.roles ?? []), ...(user.entitlements ?? [])].map((r) => groupName(r.value)).filter((r): r is string => !!r))],
    scopes: [],
    active: user.active,
  };
}

/**
 * Finds a directory user's okayed: the id their sign-in maps to (`userForSubject`), from the SCIM attribute that
 * holds the subject their identity provider puts in its tokens. Which one that is depends on how the IdP is set up.
 */
export function personBySubject(issuer: string, attr: "externalId" | "userName" | "id" = "externalId"): (u: ScimUser) => Promise<string | null> {
  return async (u) => {
    const sub = attr === "externalId" ? u.externalId : attr === "userName" ? u.userName : u.id;
    return sub ? userForSubject(issuer, sub) : null;
  };
}

/** Where directory changes land: each person's okayed, however the runtime reaches it. */
export interface DirectoryTarget {
  personFor(user: ScimUser): Promise<string | null>;
  /** Sets the organization's limits on one person (their `setCeiling`). */
  setLimits(userId: string, layer: Layer): Promise<void>;
  /** Takes back everything their agents hold and pauses their rules. Nothing to do for someone never signed in. */
  stop(userId: string, reason: string): Promise<void>;
}

/**
 * Turns directory changes into okayed: limits follow groups, and someone deactivated or removed is stopped once,
 * the moment it happens, with limits that block everything until they're back.
 */
export function applyDirectory(org: OrgPolicy, t: DirectoryTarget): (changes: DirectoryChange[]) => Promise<void> {
  return async (changes) => {
    for (const c of changes) {
      const userId = await t.personFor(c.user);
      if (!userId) continue;
      const gone = c.removed || !c.user.active;
      const p = principalFromScim(c.user, c.groups);
      await t.setLimits(userId, ceilingFor(gone ? { ...p, active: false } : p, org));
      // Once, as they go: someone already inactive was stopped when they were deactivated.
      if (gone && c.before?.active !== false) await t.stop(userId, c.removed ? `removed from ${org.name}'s directory` : `deactivated in ${org.name}'s directory`);
    }
  };
}
