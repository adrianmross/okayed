import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { Card, RequestRecord } from "@okayed/core";
import { Conversation, ConversationContent, ConversationScrollButton } from "@okayed/design/ai/conversation";
import { Message, MessageContent, MessageResponse } from "@okayed/design/ai/message";
import { Shimmer } from "@okayed/design/ai/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@okayed/design/ai/tool";
import { ActionTile, ApprovalCard, ReceiptCard, Step, Token, type ApprovalState } from "@okayed/design/okayed";
import { Button } from "@okayed/design/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@okayed/design/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@okayed/design/ui/toggle-group";
import { describeRule } from "@okayed/engine";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useAgent } from "agents/react";
import { ArrowUpIcon, MicIcon, ScanFaceIcon, SquareIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useRuleFromCard } from "../components/always-allow";
import { useApprovalStyle } from "../lib/style";
import { useOkayed } from "../lib/okayed";
import { passkeysSupported } from "../lib/passkey";

/** How each of the assistant's tools reads in the chat: its action, and a title from its input. */
const TOOLS: Record<string, { act: string; title: (i: Record<string, unknown>) => string }> = {
  read_repository: { act: "github.read", title: (i) => `Read ${i.repo ?? "a repository"}` },
  comment_on_pull_request: { act: "github.pr.comment", title: (i) => `Comment on PR #${i.number ?? "?"}` },
  merge_pull_request: { act: "github.pr.merge", title: (i) => `Merge PR #${i.number ?? "?"} in ${i.repo ?? "?"}` },
  deploy_site: { act: "site.deploy", title: (i) => `Deploy ${i.site ?? "a site"} to ${i.environment ?? "?"}` },
  buy: { act: "spend.money", title: (i) => `Buy ${i.item ?? "something"} for $${i.amount_usd ?? "?"}` },
  propose_policy: { act: "policy", title: () => "Suggest a rule" },
};

const SUGGESTIONS: [string, string][] = [
  ["github.pr.merge", "Merge PR #182 in okayed"],
  ["site.deploy", "Deploy openmeadow to production"],
  ["github.pr.comment", "Comment on PR #182: ship it"],
  ["spend.money", "Buy openmeadow.dev for $12"],
  ["policy", "Always allow merges in okayed for 2 weeks, up to 30 merges"],
  ["github.read", "Read the okayed repo"],
];

type View = "conversation" | "receipts" | "transcript";

export function ChatView() {
  const { session } = useOkayed();
  const url = new URL(session.api);
  const agent = useAgent({
    agent: "okayed-chat",
    name: session.userId,
    host: url.host,
    protocol: url.protocol === "https:" ? "wss" : "ws",
    query: { token: session.ownerToken },
  } as never);
  const chat = useAgentChat({ agent: agent as never, getInitialMessages: null });
  const [view, setView] = useState<View>("conversation");
  const busy = chat.status === "submitted" || chat.status === "streaming";
  const send = (text: string) => text.trim() && chat.sendMessage({ text: text.trim() });

  return (
    <div className="flex h-svh min-h-0 flex-1 flex-col md:h-[calc(100svh-1rem)]">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5 md:px-6">
        <div className="flex items-center gap-2">
          <ActionTile tone="policy" icon={<span className="font-semibold text-sm">A</span>} size="sm" />
          <div className="leading-tight">
            <div className="font-semibold">Assistant</div>
            <div className="hidden text-muted-foreground text-xs sm:block">{busy ? "working…" : "every action goes through okayed"}</div>
          </div>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => v && setView(v as View)} className="ml-auto">
          <ToggleGroupItem value="conversation">Chat</ToggleGroupItem>
          <ToggleGroupItem value="receipts">Receipts</ToggleGroupItem>
          <ToggleGroupItem value="transcript">Transcript</ToggleGroupItem>
        </ToggleGroup>
        <Button variant="ghost" size="icon-sm" aria-label="New chat" title="New chat" onClick={() => chat.clearHistory()}>
          <SquarePenIcon />
        </Button>
      </div>

      {view === "conversation" && (
        <Conversation className="min-h-0">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 md:px-6">
            {chat.messages.length === 0 ? (
              <Suggestions onPick={send} />
            ) : (
              chat.messages.map((m) => <ChatMessage key={m.id} message={m} respond={chat.addToolApprovalResponse} />)
            )}
            {chat.status === "submitted" && (
              <Message from="assistant">
                <Shimmer className="text-sm">Thinking…</Shimmer>
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}
      {view === "receipts" && <ChatReceipts messages={chat.messages} />}
      {view === "transcript" && <Transcript messages={chat.messages} />}

      <Composer busy={busy} onSend={send} onStop={chat.stop} />
    </div>
  );
}

function Suggestions({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-6 py-[8vh] text-center">
      <div className="space-y-2">
        <h2 className="font-semibold text-3xl">What should we do?</h2>
        <p className="mx-auto max-w-[46ch] text-muted-foreground">
          Ask for something that needs permission. Your rules decide whether it's allowed, and when they ask you, you allow it with Face ID right here.
        </p>
      </div>
      <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map(([act, text]) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="flex items-center gap-3 rounded-2xl border bg-card p-3 text-left text-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm"
          >
            <ActionTile act={act} size="sm" />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (t: string) => void; onStop: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };
  return (
    <div className="shrink-0 px-4 pt-2 pb-4 md:px-6">
      <form className="mx-auto max-w-3xl" onSubmit={(e) => (e.preventDefault(), submit())}>
        <InputGroup className="rounded-2xl bg-card shadow-sm">
          <InputGroupTextarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask the assistant to merge, deploy, comment or buy…"
            aria-label="Message the assistant"
            className="min-h-12 text-[15px]"
          />
          <InputGroupAddon align="block-end" className="justify-between">
            <span className="flex items-center gap-2 text-muted-foreground text-xs">
              <Mic onText={(t) => setText((x) => (x ? `${x} ${t}` : t))} />
              Actions are simulated. Permissions are real.
            </span>
            {busy ? (
              <InputGroupButton variant="secondary" size="sm" className="rounded-full" onClick={onStop}>Stop</InputGroupButton>
            ) : (
              <InputGroupButton type="submit" variant="default" size="icon-sm" className="rounded-full" disabled={!text.trim()} aria-label="Send">
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

/**
 * Say it instead of typing it: Whisper on Workers AI hears it, and the words land in the box for you to read before
 * sending. Nothing is sent or approved by voice alone.
 */
function Mic({ onText }: { onText: (t: string) => void }) {
  const okayed = useOkayed();
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [busy, setBusy] = useState(false);
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setBusy(true);
        try {
          const bytes = new Uint8Array(await new Blob(chunks, { type: r.mimeType }).arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const { text } = await okayed.call<{ text: string }>("POST", "/transcribe", { audio: btoa(bin) });
          if (text) onText(text);
          else toast("I didn't catch that.");
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      };
      r.start();
      setRec(r);
    } catch {
      toast.error("The microphone isn't available.");
    }
  };
  const stop = () => {
    rec?.stop();
    setRec(null);
  };
  return (
    <InputGroupButton type="button" size="icon-xs" variant={rec ? "destructive" : "ghost"} className="rounded-full" disabled={busy} onClick={rec ? stop : start} aria-label={rec ? "Stop recording" : "Say it"} title={rec ? "Stop recording" : "Say it"}>
      {rec ? <SquareIcon /> : <MicIcon />}
    </InputGroupButton>
  );
}

type Respond = (r: { id: string; approved: boolean; reason?: string }) => unknown;

function ChatMessage({ message, respond }: { message: UIMessage; respond: Respond }) {
  return (
    <Message from={message.role}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return message.role === "user" ? (
            <MessageContent key={i}>{part.text}</MessageContent>
          ) : (
            <MessageContent key={i}>
              <MessageResponse>{part.text}</MessageResponse>
            </MessageContent>
          );
        }
        if (isToolUIPart(part)) return <ToolCall key={part.toolCallId} part={part as ToolPart} respond={respond} />;
        return null;
      })}
    </Message>
  );
}

function stateOf(card: Card | undefined): ApprovalState {
  switch (card?.status) {
    case "confirming":
      return "approving";
    case "confirmed":
      return "approved";
    case "denied":
      return "denied";
    case "lapsed":
    case "closed":
      return "expired";
    default:
      return "pending";
  }
}

/** One tool call: the collapsible call itself, then whatever it needs from you, then its receipt. */
function ToolCall({ part, respond }: { part: ToolPart; respond: Respond }) {
  const okayed = useOkayed();
  const name = getToolName(part);
  const meta = TOOLS[name] ?? { act: "*", title: () => name };
  const input = (part.input ?? {}) as Record<string, unknown>;
  const req = okayed.requestByRef(part.toolCallId);
  const card = okayed.card(req?.cardId);
  const output = (part.state === "output-available" ? part.output : undefined) as { done?: boolean; grant?: string; summary?: string; card?: string; reason?: string } | undefined;
  const approval = "approval" in part ? (part.approval as { id: string; approved?: boolean; reason?: string } | undefined) : undefined;
  const [approving, setApproving] = useState(false);
  const { alwaysAllow, block, editor } = useRuleFromCard();
  const [style] = useApprovalStyle();

  // Once okayed has issued the permission, tell the chat it was approved so the assistant carries on.
  const respondedFor = useRef<string | null>(null);
  useEffect(() => {
    if (part.state !== "approval-requested" || !approval || respondedFor.current === approval.id) return;
    if (req?.status === "granted") {
      respondedFor.current = approval.id;
      void respond({ id: approval.id, approved: true });
    } else if (req?.status === "denied" || req?.status === "expired") {
      respondedFor.current = approval.id;
      void respond({ id: approval.id, approved: false, reason: req.reason ?? "You said no" });
    }
  }, [part.state, approval, req?.status, req?.reason, respond]);

  const approve = async (plain?: boolean) => {
    if (!card) return;
    setApproving(true);
    const ok = await okayed.approve(card.id, plain);
    if (!ok) setApproving(false);
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <Tool>
        <ToolHeader
          title={meta.title(input)}
          icon={<ActionTile act={meta.act} size="sm" />}
          state={part.state}
        />
        <ToolContent>
          <ToolInput input={part.input} />
          {req && (
            <p className="text-muted-foreground text-xs">
              okayed request <span className="font-mono">{req.request.id}</span> · {req.status}
              {approval?.reason ? ` · ${approval.reason}` : ""}
            </p>
          )}
          <ToolOutput output={part.state === "output-available" ? part.output : undefined} errorText={part.state === "output-error" ? part.errorText : undefined} />
        </ToolContent>
      </Tool>

      {part.state === "approval-requested" && card?.draft && (
        <ApprovalCard
          agent={card.draft.aud}
          act={card.draft.act}
          res={card.draft.res}
          uses={card.draft.uses}
          ttl={card.ttl ?? card.draft.exp - card.draft.nbf}
          when={card.draft.when}
          risk={card.draft.risk}
          why={req?.request.why}
          cuts={card.beyond}
          state={approving && stateOf(card) === "pending" ? "approving" : stateOf(card)}
          passkey={passkeysSupported() ? (okayed.snap?.passkeys.length ? "ready" : "setup") : "unsupported"}
          onApprove={() => approve()}
          onApprovePlain={() => approve(true)}
          onAlwaysAllow={(t) => alwaysAllow(card, t)}
          onBlock={(t) => block(card, t)}
          layout={style.layout}
          flow={style.flow}
          onDeny={() => card && okayed.deny(card.id)}
        />
      )}
      {editor}

      {part.state === "output-available" && name === "propose_policy" && output?.card && <RuleProposal cardId={output.card} />}

      {part.state === "output-available" && output?.done && output.grant && <ChatReceipt grantId={output.grant} req={req} title={output.summary ?? meta.title(input)} act={meta.act} />}

      {part.state === "output-available" && output?.done === false && <p className="text-muted-foreground text-sm">Didn't run: {output.reason}.</p>}
      {part.state === "output-denied" && <p className="text-muted-foreground text-sm">Not allowed{approval?.reason ? `: ${approval.reason}` : ""}.</p>}
    </div>
  );
}

function ChatReceipt({ grantId, req, title, act }: { grantId: string; req?: RequestRecord; title: string; act: string }) {
  const okayed = useOkayed();
  const g = okayed.grant(grantId);
  if (!g) return null;
  const via = g.grant.assurance.method === "webauthn" ? "with Face ID" : g.grant.assurance.method === "policy" ? "by your rules" : "by you";
  return (
    <ReceiptCard
      compact
      act={act}
      title={title.replace(/\.$/, "")}
      agent={g.grant.aud}
      how={via}
      at={g.grant.nbf}
      grantId={g.grant.id}
      used={g.used}
      uses={g.grant.uses}
      status={g.status}
      simulated
      sealed={g.grant.assurance.method !== "policy"}
      className={req ? "" : "opacity-90"}
    />
  );
}

/** A rule the assistant suggested: its steps, as in the editor, and one decision. */
function RuleProposal({ cardId }: { cardId: string }) {
  const okayed = useOkayed();
  const card = okayed.card(cardId);
  if (!card || card.kind !== "policy") return card ? <p className="text-muted-foreground text-sm">{card.sentence}</p> : null;
  const now = okayed.snap?.now ?? Date.now() / 1000;
  return (
    <div className="w-full max-w-md animate-rise space-y-2 rounded-2xl border bg-card p-4 shadow-sm">
      <div className="font-medium text-muted-foreground text-sm">The assistant suggests a rule</div>
      {(card.rules ?? []).map((r) => (
        <Step key={r.id} icon={<ActionTile act={r.act} size="sm" />} className="shadow-none">
          <Token tone={r.effect}>{r.effect === "ask" ? "Ask me" : r.effect === "allow" ? "Allow" : "Block"}</Token>
          <span className="text-muted-foreground"> · </span>
          {describeRule(r, now).replace(/^(Allow|Ask before|Block) /, "")}
        </Step>
      ))}
      {card.status === "open" ? (
        <div className="flex gap-2 pt-1">
          <Button className="flex-1 rounded-xl" onClick={() => okayed.approve(card.id)}><ScanFaceIcon />Add rule</Button>
          <Button variant="ghost" onClick={() => okayed.deny(card.id)}>Not now</Button>
        </div>
      ) : (
        <p className="pt-1 text-muted-foreground text-sm">{card.status === "confirmed" ? "Added. It's in Rules." : "Not added."}</p>
      )}
    </div>
  );
}

function ChatReceipts({ messages }: { messages: UIMessage[] }) {
  const okayed = useOkayed();
  const calls = messages.flatMap((m) => m.parts.filter(isToolUIPart)) as ToolPart[];
  const rows = calls
    .map((p) => ({ p, req: okayed.requestByRef(p.toolCallId) }))
    .filter((x) => x.req?.grantId);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6 md:px-6">
        {rows.length === 0 && <p className="py-16 text-center text-muted-foreground">No receipts in this chat yet. Everything that gets allowed leaves one.</p>}
        {rows.map(({ p, req }) => {
          const meta = TOOLS[getToolName(p)] ?? { act: "*", title: () => getToolName(p) };
          return <ChatReceipt key={p.toolCallId} grantId={req!.grantId!} req={req} act={meta.act} title={meta.title((p.input ?? {}) as Record<string, unknown>)} />;
        })}
      </div>
    </div>
  );
}

/** Everything that happened, as data: each message part, each tool's input and output, and okayed's request. */
function Transcript({ messages }: { messages: UIMessage[] }) {
  const okayed = useOkayed();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ol className="mx-auto max-w-3xl space-y-4 px-4 py-6 font-mono text-xs md:px-6">
        {messages.length === 0 && <li className="py-16 text-center font-sans text-muted-foreground text-sm">The transcript fills in as you chat.</li>}
        {messages.flatMap((m) =>
          m.parts.map((part, i) => {
            if (part.type === "text" && part.text.trim()) {
              return (
                <li key={`${m.id}-${i}`} className="grid grid-cols-[84px_1fr] gap-3">
                  <span className="text-muted-foreground">{m.role}</span>
                  <span className="whitespace-pre-wrap font-sans text-sm">{part.text}</span>
                </li>
              );
            }
            if (isToolUIPart(part)) {
              const req = okayed.requestByRef(part.toolCallId);
              const g = okayed.grant(req?.grantId);
              return (
                <li key={`${m.id}-${i}`} className="grid grid-cols-[84px_1fr] gap-3">
                  <span className="text-muted-foreground">tool</span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-3">
                    {JSON.stringify(
                      {
                        tool: getToolName(part),
                        call: part.toolCallId,
                        state: part.state,
                        input: part.input,
                        ...("approval" in part && part.approval ? { approval: part.approval } : {}),
                        ...(part.state === "output-available" ? { output: part.output } : {}),
                        ...(req ? { okayed: { request: req.request.id, status: req.status, act: req.request.act, res: req.request.res } } : {}),
                        ...(g ? { grant: { id: g.grant.id, assurance: g.grant.assurance.method, uses: `${g.used}/${g.grant.uses}`, event: g.event.id } } : {}),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </li>
              );
            }
            return null;
          }),
        )}
      </ol>
    </div>
  );
}
