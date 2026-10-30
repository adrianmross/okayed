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

1. Where: the service's tile and name ("Sites", "GitHub", a pack's title), "High risk" when it is, and ⓘ, which says
   how the answer is signed and what Always covers.
2. The question, in plain words: "Allow **Assistant** to **deploy** openmeadow.org to production?" The agent is in
   one tone, the verb in another, and each exact target is underlined (`ApprovalQuestion`).
3. The agent's reason, in grey, because it's their claim.
4. **Details**, a tap away: the scope chips (the commit, the use count, the time, the conditions), what was left out
   of the model's draft, Allow without Face ID, and Make a rule… (the rule editor, prefilled).
5. One decision: by default, swipe to decide (below). `flow`, `layout` and `actions` change how it looks and how it's
   made.
6. Decided, it folds to a line: a tick that draws itself and what happened (`Decided`, `DoneMark`).

A payment (`spend.money`) is a **money card** instead (`MoneyCard`): a deep green wallet card, the same in both
themes, with the amount big, what it's for, how it's paid, and **Swipe to pay** with **Not now** at the row's end. A
light sweeps across it once as it arrives. Decided, it folds to a small receipt that a tap opens again.

### Swipe to decide — `SwipeDecide`

Every approval's one gesture. The answer it names is a swipe right ("Swipe to allow", "Swipe to pay", "Swipe to
connect"). The other answer is never a plain swipe or a tap, so neither is ever given by accident.

| | On a card with Always | One row (no Always) |
|---|---|---|
| **Allow** | swipe right past 85% of the track | swipe right the full length; the track grows over Not now as you go |
| **Always**, for how long | hold Always: its spans pop up as chips (1d, 30d, ∞); rest on one, slide up into the track and swipe right. Or tap Always and pick from the spans that replace the pills | — |
| **Deny** | hold Deny: the track turns red, knob at the end; slide into it and swipe left. Rest on a chip on the way to block requests like this for that long. Or tap Deny (it reads Cancel) and swipe left | hold Not now and slide left the full length, or tap it and swipe left |

A chip is picked only when the finger rests on it (180 ms); passing over one picks nothing, and the pick stays until
another is rested on. Lifted anywhere short of a swipe, nothing happens. A tapped Deny goes back to Allow after a few
seconds with nothing done. The track always says what a swipe will do: "Pause on a choice" while nothing is picked,
then "Swipe to allow for 30 days". With the keyboard, Enter on the track answers what it says, and the pills and
spans are buttons. `light` puts it on a dark card. The rules are a pure, tested model (`swipe-model.ts`: `letGo`,
`chipsOf`, `holdMove`, `holdCommits`…) so other renderers can reuse them.

| Callback | Means |
|---|---|
| `onApprove()` | Allow this one request (Face ID follows). |
| `onApprovePlain()` | Allow it without Face ID. |
| `onDeny()` | Deny it. |
| `onAlwaysAllow(seconds)` / `onAlwaysAllow(null)` | Always, for that long or until removed: a rule, and this one allowed. |
| `onAlwaysAllow()` | Make a rule…: open the rule editor. |
| `onBlock(seconds)` / `onBlock(null)` | Held Deny, resting on a span: block requests like this for that long. |

`alwaysSpans` and `blockSpans` replace the chips: any list of `{ id, words, short?, icon?, says?, seconds }`.

### Buttons instead — `ApprovalActions`, `SlideToConfirm`, `HoldSlide`

For implementations that want buttons, `flow="tap"` or `flow="hold"` puts the classic decision area on the card:
**Allow once**, **Always allow…**, **Block…** and **Don't allow**, stacked (`layout="stack"`) or in one row
(`layout="row"`). `flow="hold"` makes Always allow… and Block… hold-and-slide buttons: hold, slide up a ladder of
durations (1 hour to always, `durations` to change it), then across. `SlideToConfirm` and `HoldSlide` are there on
their own too, and `actions` replaces the decision area entirely.

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
- Decision colours always come with words ("Allowed", "Asks you"); colour is never the only signal.
- Every gesture has a keyboard path (Enter, arrows, Escape) and a screen-reader name that says what it will do; no
  answer is ever a single tap.
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
npx shadcn add @okayed/okayed      # everything: theme, engine, primitives, swipe to decide, money card, approval card, receipt, rules
```

| Item | What |
|---|---|
| `okayed-theme` | The tokens, fonts, tile gradients and animations, merged into your CSS. |
| `okayed-engine` | The policy engine, pure TypeScript. |
| `okayed-primitives` | Action tiles, avatars, tokens, the seal, verdict pills, steps. |
| `swipe-decide` | Swipe to decide, and its gesture model. |
| `money-card`, `done-mark` | The payment card, and the decided mark. |
| `slide-to-confirm`, `hold-slide`, `approval-actions` | The button flows and their gestures. |
| `approval-card`, `receipt-card`, `rule-tile`, `rule-editor` | The components, each with the shadcn pieces it needs. |
| `approval-card-swipe`, `approval-card-pay`, `approval-card-row`, `approval-card-hold` | Examples of each configuration, in `components/okayed/examples/`, to start from. |

The playground's **Components** view shows every configuration live, with the calls each decision makes and the
command that installs it.

## Adding a shadcn component

The registry (`ui.shadcn.com`) may be unreachable from some build environments. In that case, copy the component
from `raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/<name>.tsx` into `src/ui/`, then
point its `@/registry/new-york-v4/ui/*` imports at `./*`. With the registry reachable, `npx shadcn add <name>` from
`apps/web` works too (`components.json` points at this package).
