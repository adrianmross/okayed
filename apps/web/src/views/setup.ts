import { ago, h } from "@okayed/ui";
import type { App } from "../app.ts";

let minted: { id: string; token: string } | null = null;

export function setupView(app: App, signOut: () => void): HTMLElement {
  const { snap, session } = app;
  const name = h("input", { class: "field", placeholder: "agent name, e.g. assistant", "aria-label": "Agent name" }) as HTMLInputElement;
  const repos = h("textarea", { class: "field", rows: "3", "aria-label": "Repositories" }, snap.targets.repos.join("\n")) as HTMLTextAreaElement;
  const sites = h("textarea", { class: "field", rows: "3", "aria-label": "Sites" }, snap.targets.sites.map((s) => `${s.host}: ${s.envs.join(", ")}`).join("\n")) as HTMLTextAreaElement;
  const addAgent = (e: Event) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    void app.call<{ id: string; token: string }>("POST", "/agents", { name: name.value.trim() }).then((j) => {
      minted = j;
      app.run("GET", "/state");
    });
  };
  const saveTargets = () =>
    app.run(
      "PUT",
      "/targets",
      {
        repos: repos.value.split(/\s+/).filter(Boolean),
        sites: sites.value
          .split("\n")
          .map((l) => l.split(":"))
          .filter(([host]) => host?.trim())
          .map(([host, envs]) => ({ host: host!.trim(), envs: (envs ?? "production").split(",").map((x) => x.trim()) })),
      },
      "Saved.",
    );
  const example = minted
    ? `curl -X POST ${session.api}/api/u/${snap.userId}/requests \\\n  -H 'authorization: Bearer ${minted.token}' \\\n  -d '{"act":"github.pr.merge","res":["github:OWNER/REPO/pull/1@<head sha>"],"why":"tests pass"}'`
    : "";

  return h(
    "div",
    { class: "cols" },
    h(
      "div",
      { class: "col" },
      h(
        "section",
        { class: "card" },
        h("h2", { class: "section-title", style: "margin:0" }, "Agents"),
        snap.agents.length
          ? snap.agents.map((a) => h("div", { class: "row" }, h("code", null, a.id), h("span", { class: "note" }, ago(a.createdAt, snap.now)), h("span", { class: "spacer" }), h("button", { class: "btn quiet", type: "button", onclick: () => app.run("DELETE", `/agents/${encodeURIComponent(a.id)}`, undefined, "Agent removed.") }, "Remove")))
          : h("div", { class: "note" }, "No agents yet."),
        h("form", { class: "compose", onsubmit: addAgent }, name, h("button", { class: "btn", type: "submit" }, "Add")),
        minted ? h("div", null, h("div", { class: "note" }, `Token for ${minted.id}, shown once. okayed keeps only its hash.`), h("pre", null, minted.token), h("pre", null, example)) : null,
      ),
      h(
        "section",
        { class: "card" },
        h("h2", { class: "section-title", style: "margin:0" }, "What okayed can bind your words to"),
        h("div", { class: "note" }, "Repositories, one per line (owner/repo). Requests add to these on their own."),
        repos,
        h("div", { class: "note" }, "Sites, one per line (host: env, env)."),
        sites,
        h("div", null, h("button", { class: "btn", type: "button", onclick: saveTargets }, "Save")),
      ),
    ),
    h(
      "div",
      { class: "col" },
      h(
        "section",
        { class: "card" },
        h("h2", { class: "section-title", style: "margin:0" }, "Emergency stop"),
        h("div", { class: "note" }, "Revokes every live grant and pauses auto-approval until you resume."),
        h(
          "div",
          null,
          snap.paused
            ? h("button", { class: "btn", type: "button", onclick: () => app.run("POST", "/resume", undefined, "Auto-approval resumed.") }, "Resume auto-approval")
            : h("button", { class: "btn", style: "color:var(--bad)", type: "button", onclick: () => app.run("POST", "/stop", { reason: "emergency stop" }, "Stopped. Every grant is revoked.") }, "Stop everything"),
        ),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", { class: "section-title", style: "margin:0" }, "This account"),
        h("div", { class: "note" }, "Tools verify grants at"),
        h("pre", null, `POST ${session.api}/api/u/${snap.userId}/verify`),
        h("div", { class: "note" }, "Issuer key (iss)"),
        h("pre", null, snap.issuer),
        h("details", null, h("summary", null, "Owner token (keep it secret)"), h("pre", null, session.ownerToken)),
        h("div", null, h("button", { class: "btn quiet", type: "button", onclick: signOut }, "Sign out on this device")),
      ),
    ),
  );
}
