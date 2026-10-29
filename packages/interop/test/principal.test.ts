import { describe, expect, it } from "vitest";
import { accessIdentity, fromAccessIdentity, fromOidcClaims, fromSamlAssertion, groupName, scopesOf } from "../src/index.ts";

describe("principals from anywhere", () => {
  it("read OIDC claims: Okta groups, Keycloak roles, Entra scp", () => {
    const okta = fromOidcClaims({ iss: "https://acme.okta.com", sub: "00u1", email: "ada@acme.dev", name: "Ada", groups: ["Release-Managers", "Everyone"], scope: "openid okayed" });
    expect(okta).toEqual({ id: "oidc:https://acme.okta.com#00u1", issuer: "https://acme.okta.com", subject: "00u1", email: "ada@acme.dev", name: "Ada", groups: ["release-managers", "everyone"], roles: [], scopes: ["openid", "okayed"], active: true });
    const keycloak = fromOidcClaims({ iss: "https://kc/realms/acme", sub: "x", realm_access: { roles: ["Deployer"] } });
    expect(keycloak.roles).toEqual(["deployer"]);
    expect(scopesOf({ scp: ["Files.Read", "Mail.Send"] })).toEqual(["Files.Read", "Mail.Send"]);
    // A namespaced claim (Auth0) is a key, not a path.
    expect(fromOidcClaims({ iss: "i", sub: "s", "https://acme.dev/groups": ["Ops"] }, { groups: ["https://acme.dev/groups"] }).groups).toEqual(["ops"]);
    expect(() => fromOidcClaims({ sub: "s" })).toThrow(/iss and sub/);
  });

  it("read SAML attributes, with directory names by their common name", () => {
    const p = fromSamlAssertion({
      issuer: "https://sts.windows.net/tenant/",
      nameId: "ada@acme.dev",
      attributes: {
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups": ["CN=Release Managers,OU=Groups,DC=acme,DC=dev", "ops"],
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/role": "Approver",
        "http://schemas.microsoft.com/identity/claims/displayname": "Ada Lovelace",
      },
    });
    expect(p).toMatchObject({ id: "saml:https://sts.windows.net/tenant/#ada@acme.dev", email: "ada@acme.dev", name: "Ada Lovelace", groups: ["release managers", "ops"], roles: ["approver"] });
    expect(groupName({ display: "Admins" })).toBe("admins");
    expect(groupName("  ")).toBeNull();
  });

  it("read Cloudflare Access's identity, groups from any IdP behind it", async () => {
    const identity = { user_uuid: "u-1", email: "ada@acme.dev", groups: [{ id: "g1", name: "Release Managers" }, { id: "g2", email: "ops@acme.dev" }] };
    expect(fromAccessIdentity(identity, "acme")).toMatchObject({ id: "oidc:https://acme.cloudflareaccess.com#u-1", groups: ["release managers", "ops@acme.dev"] });
    let asked: { url: string; cookie: string | null } | null = null;
    const f = (async (url: string, init?: RequestInit) => {
      asked = { url, cookie: new Headers(init?.headers).get("cookie") };
      return Response.json(identity);
    }) as typeof fetch;
    expect(await accessIdentity("acme", "tok", f)).toEqual(identity);
    expect(asked).toEqual({ url: "https://acme.cloudflareaccess.com/cdn-cgi/access/get-identity", cookie: "CF_Authorization=tok" });
  });
});
