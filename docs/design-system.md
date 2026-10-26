# okayed design system

`packages/design` (`@okayed/design`) is okayed's own design system. It stands alone, and both apps (the web demo
and the playground) are built only from it. It has four layers:

| Layer | Path | What |
|---|---|---|
| Tokens | `src/styles/okayed.css` | Colour, type, radius and motion as CSS variables with shadcn's names, light and dark, plus Tailwind v4 `@theme`. |
| shadcn/ui | `src/ui/*` | The latest new-york-v4 components, copied from shadcn's repository as shadcn intends, with `cn` from the `cn` package. |
| AI Elements | `src/ai/*` | Conversation, message, tool call and shimmer, adapted from Vercel's AI Elements (Apache-2.0) to these tokens, without the heavy markdown and highlighting stack. |
| okayed | `src/okayed/*` | The pieces that are okayed's own: action tiles, tokens, the seal, the approval card, receipts, rule tiles and the Shortcuts-style rule editor. |

The same pieces install into any shadcn app from okayed's registry (below).

## The idea

An approval should feel like pressing a seal on one specific thing. Rules should feel like building a Shortcut:
pick a coloured action, tap the words that matter, and read back a sentence. So:

- **Quiet ground, loud decisions.** Neutrals are cool and calm. The only strong colours are the action tiles
  (what kind of thing) and the decision colours (what will happen).
- **One accent, for the act of approving.** Cobalt "seal" is the primary button, the seal stamp and the focus ring.
  Nothing else is cobalt.
- **Every value you can change is a token.** It's a tinted, bold inline pill with a small chevron, as Shortcuts
  shows variables. A value that can't change has no chevron.
- **Say what will happen, in words.** Each card leads with a sentence ("Deploy openmeadow.org to production"), and
  the chips under it say exactly what's pinned ("Only commit 3f9a1c2 · Once · For 15 minutes").

## Colour

All colours are OKLCH tokens, redefined under `.dark`. Components never use a literal colour.

| Token | Role |
|---|---|
| `--background`, `--card`, `--muted`, `--border` | Cool neutrals with a slight blue bias (hue 262–268). |
| `--primary` / `--seal` | Cobalt. Approve buttons, the seal, focus rings. |
| `--allow` | Green: allowed. |
| `--ask` | Amber: asks you. |
| `--deny` | Red: blocked, refused, taken back, high risk. |
| `--tile-<family>-from/to` | Gradient pairs for action tiles: `read` slate, `comment` sky, `merge` violet, `deploy` teal, `spend` coral, `policy` cobalt, `any` grey. |

Decision colours are semantic and never decorative. Tile colours mean only "what kind of action".

## Type

- **Onest** (variable) for everything you read. Headings use tight tracking (−0.015em) and `text-wrap: balance`.
- **JetBrains Mono** (variable) for ids, hashes, events and transcripts.
- Sizes: 15px chat text and 17px card sentences, with Tailwind's scale elsewhere. Numbers that line up use
  `tabular-nums`.

## Shape and motion

- The base radius is 14px (`--radius`). Cards and tiles use `rounded-2xl`, tokens `rounded-md`, chips and status pills
  `rounded-full`.
- Two animations, both turned off for `prefers-reduced-motion`:
  - `animate-rise`: a card arriving in the chat (6px, 360ms).
  - `animate-seal`: the seal pressing down (scale and rotate with a slight overshoot, 520ms).

  Nothing else moves except shadcn's own open and close transitions.

## Components

### Action tile — `ActionTile`

A rounded square with a gradient by family and a white icon (`lucide`). Sizes `sm` (28px), `md` (40px) and `lg`
(56px). An action looks the same everywhere: the merge tile in the chat, the library and the editor is one tile.

| Action | Icon | Family |
|---|---|---|
| `github.read` | book | read |
| `github.pr.comment` | message | comment |
| `github.pr.merge` | git merge | merge |
| `site.deploy` | rocket | deploy |
| `spend.money` | credit card | spend |
| a rule change | shield | policy |

### Token — `Token`, `Choice`

An inline value. Without `onClick` it's static; with `interactive` or `onClick` it's a button with a chevron.
`Choice` wraps a token in a popover list: the editor's way of changing one word.

### Approval card — `ApprovalCard`

From top to bottom:

1. Who: the agent's avatar, "wants to", and a risk badge.
2. What: a large action tile and the sentence, with targets as tokens.
3. Why: the agent's reason, quoted.
4. Scope chips: the commit, the use count, the time, the conditions.
5. "Left out of this request": a collapsible list of what was cut from the model's draft.
6. One decision: a full-width **Allow once** with the Face ID glyph; **Always allow…**, which opens the rule editor
   with the narrowest rule that covers requests like this one; a quiet **Don't allow**; and a link to allow without
   Face ID.

Once allowed, the seal presses down.

### Receipt — `ReceiptCard`

A ticket with a dashed tear line:

- the tile, what happened, and the agent
- how it was okayed: with Face ID, or by your rules
- the time, uses spent, the grant id, and an Active, Used, Expired or Taken back badge, with **Take back** while
  it's active

It carries the seal when you approved it yourself.

### Rule tile — `RuleTile`, `NewRuleTile`

A Shortcuts library tile: the family gradient, the icon, a decision pill (Allowed, Asks you, Blocked, Limit
reached), a name and a one-line summary. The last tile in the grid is a dashed "+ New rule".

### Rule editor — `RuleEditor`

A sheet with a stack of `Step`s joined by short connectors, each reading as part of one sentence:

> When **any agent** asks to **merge pull requests** in **adrianmross/okayed**, then **Allow** — only if
> **checks pass** · **30 times** · **for 2 weeks**

Below the steps are the plain-words rule and a live "Try it" from the same engine okayed runs. The editor takes
props and returns rules, so the web app saves to the server and the playground keeps them in memory. `title` and
`saveLabel` let it say more, as "Always allow" does with "Add rule and allow".

### Chat — `Conversation`, `Message`, `Tool`

AI Elements' structure:

- a conversation that sticks to the bottom
- user messages as cobalt bubbles, assistant messages as plain text
- each tool call as a collapsible row with its action tile and a status ("Waiting for you", "Done", "Not allowed")

The approval card and the receipt render directly under the tool call they belong to.

## Writing

- Name things the way people do: "Merge PR #182 in okayed", not `github.pr.merge`. Ids appear only in transcripts and
  signed records.
- Use the app's words, and keep the IAM ones for the API and docs:

  | Say | Not |
  |---|---|
  | request | — |
  | Allow · Ask me · Block; Allowed · Asks you · Blocked | approve, go ahead, never, deny |
  | rule | policy, standing policy |
  | permission | grant |
  | limit, points | budget, risk |
  | Take back | revoke |
  | Presets | posture |

- Buttons say what happens: "Allow once", "Always allow…", "Don't allow", "Take back", "Stop everything", "Add rule".
- After an action, confirm in a few words ("Rule saved.", "Taken back."). Errors say what to do next ("Set up Face
  ID first", "The approval took too long; try again").
- Say plainly that actions are simulated, once per screen at most.

## Accessibility

- Every interactive token, tile and step is a real `button` with a visible focus ring (`--ring`).
- Decision colours always come with words ("Goes ahead", "Asks you"); colour is never the only signal.
- Both themes are designed, and the theme follows the system (`followSystemTheme`).
- The chat is a `role="log"` region; toasts are announced.

## Install from the registry

The web build runs `packages/design/scripts/build-registry.mjs`, which turns the theme, the engine and each okayed
component into a shadcn registry item at `/r/`. Imports are rewritten to shadcn's aliases (`@/components/ui`,
`@/lib/utils`), okayed's own pieces land in `components/okayed/`, and the engine they use lands in `lib/okayed/engine/`.

```bash
npx shadcn add https://okayed.pages.dev/r/approval-card.json
```

Or add the namespace to `components.json` and install by name:

```json
{ "registries": { "@okayed": "https://okayed.pages.dev/r/{name}.json" } }
```

```bash
npx shadcn add @okayed/okayed      # everything: theme, engine, primitives, approval card, receipt, rule tile, rule editor
```

| Item | What |
|---|---|
| `okayed-theme` | The tokens, fonts, tile gradients and animations, merged into your CSS. |
| `okayed-engine` | The policy engine, pure TypeScript. |
| `okayed-primitives` | Action tiles, avatars, tokens, the seal, verdict pills, steps. |
| `approval-card`, `receipt-card`, `rule-tile`, `rule-editor` | The components, each with the shadcn pieces it needs. |

## Adding a shadcn component

The registry (`ui.shadcn.com`) may be unreachable from some build environments. In that case, copy the component
from `raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/<name>.tsx` into `src/ui/`, then
point its `@/registry/new-york-v4/ui/*` imports at `./*`. With the registry reachable, `npx shadcn add <name>` from
`apps/web` works too (`components.json` points at this package).
