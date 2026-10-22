import { describe, expect, it } from "vitest";
import { checkUse, type GrantBody } from "../src/index.ts";
import { NOW, SHA } from "./fixtures.ts";

const PR = `github:adrianmross/okayed/pull/182@${SHA}`;
const g: GrantBody = { v: 0, id: "g", aud: "agent:assistant", act: "github.pr.merge", res: [PR], when: [], nbf: NOW, exp: NOW + 900, uses: 1, risk: "high" };
const fresh = { revoked: false, used: 0, issuedAt: NOW };
const use = { aud: "agent:assistant", act: "github.pr.merge", res: PR, now: NOW + 10 };

describe("checkUse", () => {
  it("allows the exact use once", () => {
    expect(checkUse(g, use, fresh)).toEqual({ ok: true, left: 0 });
    expect(checkUse(g, use, { ...fresh, used: 1 })).toMatchObject({ ok: false, code: "used_up" });
  });

  it("enforces the time window", () => {
    expect(checkUse(g, { ...use, now: NOW - 1 }, fresh)).toMatchObject({ code: "not_yet" });
    expect(checkUse(g, { ...use, now: NOW + 900 }, fresh)).toMatchObject({ code: "expired" });
  });

  it("requires exact audience, action and resource", () => {
    expect(checkUse(g, { ...use, aud: "agent:mallory" }, fresh)).toMatchObject({ code: "wrong_audience" });
    expect(checkUse(g, { ...use, act: "github.pr.comment" }, fresh)).toMatchObject({ code: "wrong_action" });
    expect(checkUse(g, { ...use, res: "github:adrianmross/okayed/pull/183@" + SHA }, fresh)).toMatchObject({ code: "wrong_resource" });
    expect(checkUse(g, { ...use, res: "github:adrianmross/okayed/pull/182" }, fresh)).toMatchObject({ code: "wrong_resource" });
    expect(checkUse(g, { ...use, res: "github:adrianmross/**" }, fresh)).toMatchObject({ code: "wrong_resource" });
    expect(checkUse(g, { ...use, res: PR.toUpperCase().replace("GITHUB:", "github:") }, fresh).ok).toBe(true);
  });

  it("honors revocation and emergency stops", () => {
    expect(checkUse(g, use, { ...fresh, revoked: true })).toMatchObject({ code: "revoked" });
    expect(checkUse(g, use, { ...fresh, stoppedAt: NOW })).toMatchObject({ code: "stopped" });
    expect(checkUse(g, use, { ...fresh, stoppedAt: NOW - 1 }).ok).toBe(true);
  });

  it("fails closed on conditions", () => {
    const c = { ...g, when: [{ c: "checks.pass" }] };
    expect(checkUse(c, use, fresh)).toMatchObject({ code: "condition_unknown" });
    expect(checkUse(c, use, fresh, { "checks.pass": false })).toMatchObject({ code: "condition_failed" });
    expect(checkUse(c, use, fresh, { "checks.pass": true }).ok).toBe(true);
    expect(checkUse({ ...g, when: [{ c: "moon.full" }] }, use, fresh)).toMatchObject({ code: "condition_unknown" });
    expect(checkUse({ ...g, when: [{ c: "before", v: NOW + 5 }] }, use, fresh)).toMatchObject({ code: "condition_failed" });
  });

  it("refuses unknown versions", () => {
    expect(checkUse({ ...g, v: 1 }, use, fresh)).toMatchObject({ code: "bad_version" });
  });
});
