import { CATALOG, registeredPacks } from "@okayed/engine";
import { BookOpenIcon, CreditCardIcon, GitMergeIcon, MessageSquareTextIcon, PuzzleIcon, RocketIcon, ShieldCheckIcon, SparklesIcon, type LucideIcon } from "lucide-react";

export type Tone = "read" | "comment" | "merge" | "deploy" | "spend" | "policy" | "any";

export interface ActionMeta {
  act: string;
  /** "Merge a pull request" */
  title: string;
  /** "merge" */
  verb: string;
  /** "merging pull requests" */
  noun: string;
  icon: LucideIcon;
  tone: Tone;
  /** Where it happens, as a card's header names it: "GitHub", "Sites", "Payments", a pack's title. */
  service: string;
}

/** How each action looks: one icon and one tile colour per family, everywhere it appears. */
export const ACTIONS: Record<string, ActionMeta> = {
  "github.read": { act: "github.read", title: "Read a repository", verb: "read", noun: "reading repositories", icon: BookOpenIcon, tone: "read", service: "GitHub" },
  "github.pr.comment": { act: "github.pr.comment", title: "Comment on a pull request", verb: "comment on", noun: "commenting on pull requests", icon: MessageSquareTextIcon, tone: "comment", service: "GitHub" },
  "github.pr.merge": { act: "github.pr.merge", title: "Merge a pull request", verb: "merge", noun: "merging pull requests", icon: GitMergeIcon, tone: "merge", service: "GitHub" },
  "site.deploy": { act: "site.deploy", title: "Deploy a site", verb: "deploy", noun: "deploying sites", icon: RocketIcon, tone: "deploy", service: "Sites" },
  "spend.money": { act: "spend.money", title: "Spend money", verb: "spend", noun: "spending money", icon: CreditCardIcon, tone: "spend", service: "Payments" },
};

export const ANY_ACTION: ActionMeta = { act: "*", title: "Anything", verb: "do", noun: "anything", icon: SparklesIcon, tone: "any", service: "Anything" };
export const POLICY_ACTION: ActionMeta = { act: "policy", title: "Change a rule", verb: "change", noun: "changing rules", icon: ShieldCheckIcon, tone: "policy", service: "Your rules" };

/** Actions from a registered capability pack: the engine's words, one neutral tile. */
function registered(act: string): ActionMeta | undefined {
  const spec = CATALOG[act];
  if (!spec) return undefined;
  const title = spec.title ?? `${spec.verb[0]!.toUpperCase()}${spec.verb.slice(1)}`;
  const service = registeredPacks().find((p) => p.id === spec.pack)?.title ?? act.split(".")[0]!;
  return { act, title, verb: spec.verb, noun: spec.noun, icon: PuzzleIcon, tone: "any", service };
}

export function actionMeta(act: string): ActionMeta {
  if (ACTIONS[act]) return ACTIONS[act];
  if (act === "policy") return POLICY_ACTION;
  const own = registered(act);
  if (own) return own;
  const prefix = act.replace(/\.?\*$/, "");
  const family = act.endsWith("*") ? (Object.values(ACTIONS).find((a) => a.act.startsWith(prefix)) ?? Object.keys(CATALOG).map(registered).find((a) => a?.act.startsWith(prefix))) : undefined;
  return family ? { ...family, title: `Anything in ${prefix}`, noun: `anything in ${prefix}` } : ANY_ACTION;
}
