import type { Connector, CredentialSource } from "@okayed/core";

/** Slack: post a message to one channel under a grant (the Slack pack's `slack.message.post`). */
export function slackPost(o: { workspace: string; credential: CredentialSource; fetch?: typeof fetch }): Connector<{ channel: string; text: string }> {
  const f = o.fetch ?? fetch;
  return {
    id: "slack/post",
    act: "slack.message.post",
    title: "Post a message to Slack",
    credential: o.credential,
    input(b) {
      const channel = String(b.channel ?? "").replace(/^#/, "").toLowerCase();
      const text = typeof b.text === "string" ? b.text : "";
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(channel) || !text.trim()) throw new Error("send a channel name and the text to post");
      if (b.workspace !== undefined && b.workspace !== o.workspace) throw new Error(`this tool posts to ${o.workspace} only`);
      return { channel, text: text.slice(0, 4000) };
    },
    resource: (i) => `slack:${o.workspace}/${i.channel}`,
    async perform(i, { token }) {
      const r = await f("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${token ?? ""}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: `#${i.channel}`, text: i.text }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string; channel?: string };
      if (!r.ok || !body.ok) throw new Error(`Slack: ${body.error ?? `HTTP ${r.status}`}`);
      return { posted: true, ts: body.ts };
    },
  };
}
