import { brand, h, toast } from "@okayed/ui";
import { createUser, type Session } from "../session.ts";

export function welcome(defaultApi: string, onSession: (s: Session) => void): HTMLElement {
  const api = h("input", { class: "field", value: defaultApi, "aria-label": "API address" }) as HTMLInputElement;
  const user = h("input", { class: "field", placeholder: "user id", "aria-label": "User id" }) as HTMLInputElement;
  const token = h("input", { class: "field", placeholder: "owner token (own_…)", "aria-label": "Owner token" }) as HTMLInputElement;
  const base = () => api.value.trim().replace(/\/$/, "");
  const create = async () => {
    try {
      onSession(await createUser(base()));
    } catch (e) {
      toast(`Couldn't reach ${base()}: ${(e as Error).message}`);
    }
  };
  const join = () => {
    if (!user.value.trim() || !token.value.trim()) return toast("Paste both the user id and the owner token.");
    onSession({ api: base(), userId: user.value.trim(), ownerToken: token.value.trim() });
  };
  return h(
    "div",
    { class: "page", style: "max-width:640px;padding-top:10vh" },
    brand(),
    h("h1", { style: "font-size:32px" }, "Your okay, made exact."),
    h(
      "p",
      { class: "muted", style: "font-size:17px" },
      "You tell your agent “I approve merging #182”. okayed turns that into the narrowest grant it can mean: one PR, one commit, one use, fifteen minutes. You see it before it exists and can take it back at any time.",
    ),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: create }, "Create my okayed"), h("a", { class: "small", href: "https://github.com/adrianmross/okayed" }, "How it works")),
    h(
      "details",
      null,
      h("summary", null, "Use an existing account or another API"),
      h("div", { class: "col", style: "margin-top:8px" }, api, user, token, h("button", { class: "btn", type: "button", onclick: join }, "Use this account")),
    ),
  );
}
