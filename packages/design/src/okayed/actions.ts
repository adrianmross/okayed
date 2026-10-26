import { BookOpenIcon, CreditCardIcon, GitMergeIcon, MessageSquareTextIcon, RocketIcon, ShieldCheckIcon, SparklesIcon, type LucideIcon } from "lucide-react";

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
}

/** How each action looks: one icon and one tile colour per family, everywhere it appears. */
export const ACTIONS: Record<string, ActionMeta> = {
  "github.read": { act: "github.read", title: "Read a repository", verb: "read", noun: "reading repositories", icon: BookOpenIcon, tone: "read" },
  "github.pr.comment": { act: "github.pr.comment", title: "Comment on a pull request", verb: "comment on", noun: "commenting on pull requests", icon: MessageSquareTextIcon, tone: "comment" },
  "github.pr.merge": { act: "github.pr.merge", title: "Merge a pull request", verb: "merge", noun: "merging pull requests", icon: GitMergeIcon, tone: "merge" },
  "site.deploy": { act: "site.deploy", title: "Deploy a site", verb: "deploy", noun: "deploying sites", icon: RocketIcon, tone: "deploy" },
  "spend.money": { act: "spend.money", title: "Spend money", verb: "spend", noun: "spending money", icon: CreditCardIcon, tone: "spend" },
};

export const ANY_ACTION: ActionMeta = { act: "*", title: "Anything", verb: "do", noun: "anything", icon: SparklesIcon, tone: "any" };
export const POLICY_ACTION: ActionMeta = { act: "policy", title: "Change a rule", verb: "change", noun: "changing rules", icon: ShieldCheckIcon, tone: "policy" };

export function actionMeta(act: string): ActionMeta {
  if (ACTIONS[act]) return ACTIONS[act];
  if (act === "policy") return POLICY_ACTION;
  const family = Object.values(ACTIONS).find((a) => act.endsWith("*") && a.act.startsWith(act.replace(/\.?\*$/, "")));
  return family ? { ...family, title: `Anything in ${act.replace(/\.?\*$/, "")}`, noun: `anything in ${act.replace(/\.?\*$/, "")}` } : ANY_ACTION;
}
