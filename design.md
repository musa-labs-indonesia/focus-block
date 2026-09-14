# Design — Focus Block

A locked design system for this app. Every view redesign reads this file before emitting code.
Do not regenerate per view — extend or amend this file when the system needs to grow.

## Genre

modern-minimal — the desktop-instrument school. A tool should read as an instrument, not as
literature: precise type, hairlines instead of boxes, colour only where it carries meaning.

## Audience and tone

Audience: the owner, plus people who are not technical. Anything about helpers, sudoers rules,
`/etc/hosts` or versions stays out of the way — a plain sentence in the interface, the mechanism in a
tooltip, the details behind a collapsed **Technical details** disclosure.

Tone: utilitarian. Present, precise, gone.

One job per view, and it must be answerable at a glance:

- **Focus** — what is blocked right now, and how long until it stops.
- **Settings** — what gets blocked, when, and whether it can act without a password.

## Macrostructure families

The catalog's macrostructures are landing-page shapes, so they are borrowed here as skeletons.

- **App view (Focus)** — *Workbench*. One working surface. When a session runs, the live instrument
  (timer digits · what is blocked · when it ends) occupies the top of the view and the task list
  becomes a locked ledger under it. Idle, the instrument collapses to a single status line and the
  task list leads.
- **App view (Settings)** — *document sheet, two columns*. Grouped sections separated by hairline rules
  with a small caps label, in two columns from 1024px up and one column below that. Each column is ~530px,
  which keeps prose near a readable measure without leaving half the window empty. No cards, no borders on
  rows.
- **Modal (task editor)** — a raised sheet on a scrim: label above field, one column, no nested boxes.

Tasks are a **ledger (list)**, not a card grid: title, duration, domains, actions on one row with a
hairline between rows. The card grid was the templated-UI tell this redesign removes.

## Theme — Cobalt

Cool ink-blue accent on a near-white paper, with a true dark twin. Values live in
[`tokens.css`](tokens.css).

- `--paper` near-white, cool · `--paper-2` raised · `--paper-3` sunken
- `--ink` near-black with a blue cast · `--ink-2` secondary · `--ink-3` muted
- `--rule` hairline
- `--accent` ink blue · `--accent-ink` text on accent
- `--danger` · `--danger-paper` · `--warn` · `--warn-paper` · `--ok`
- `--focus` visible focus ring, always the accent

Accent budget: **≤ 5% of a viewport**. It marks the running session, the primary action, and focus.

## Typography

- Display: **Space Grotesk Variable**, weight 500–600, roman (italic is banned on headings)
- Body: **Inter Variable**, weight 400/500/600
- Mono: **JetBrains Mono Variable**, weight 500–700 — this is the **timer's** face, and it is the
  reason a mono is in the pairing: tabular digits that do not jitter as they count.
- Display tracking `-0.02em`; timer tracking `-0.03em`
- Scale anchor: `--text-timer` = `clamp(3.25rem, 7vw, 4.5rem)`, `font-variant-numeric: tabular-nums`

Bundle: `@fontsource-variable/{space-grotesk,inter,jetbrains-mono}`, imported in `src/main.tsx`. Web
fonts must be bundled — the CSP is `default-src 'self'`, so no remote font can load.

## Spacing

Tailwind's 4pt scale, plus named semantic tokens in `tokens.css` (`--space-2xs` … `--space-3xl`).
Views use named tokens or Tailwind's spacing utilities — never raw pixel values.

## Motion

- Easings: `--ease-out cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-in-out` for reversible moves
- Durations: `--dur-short 160ms`, `--dur-base 220ms`
- Reveal: none. Nothing fades in on load.
- Only the session progress line animates on its own, because its movement is information.
- Reduced motion: transitions collapse to opacity, ≤150ms (already enforced in `src/index.css`).
- `:focus-visible` never animates — the ring appears instantly.

## Microinteractions stance

- Silent success. Routine actions ("Task deleted", "Settings refreshed") do not toast. A toast is
  reserved for an outcome the user cannot see otherwise: a privileged write, a password refusal, a
  session that started or was refused.
- The live countdown is the only continuously animated element; it updates once per second.
- Hover states are instant; the only delayed appearance is a tooltip, at 300ms.

## Component voice

- Buttons: two shapes only. **Primary** = solid accent, no border. **Secondary** = paper background
  with a hairline border. Same height (44px minimum), same radius (`--radius-md`), same tracking.
- Chips: hairline only. A domain is data, not a state — dots are reserved for status, so a chip never
  carries one and a cloud of eight domains does not become a field of dots.
- Status: a word plus one dot. No emoji anywhere — emoji render differently on every OS, which is
  exactly what a cross-platform desktop tool cannot afford.
- Icons: hand-drawn 16px inline SVG, `currentColor`, no icon dependency.
- Section breaks: a 1px rule with a small caps label, or a hairline that spans the column.
- Technical strings (`/etc/hosts`, helper paths, marker names, versions) never appear in the main
  flow. They belong in a tooltip or the collapsed **Technical details** disclosure.

## States

Every interactive element ships all eight: default · hover · focus-visible · active · disabled ·
loading · error · success. The app's existing constraints are non-negotiable: skip link, `sr-only`
live region for toasts, `role="alert"` for errors, 44px hit targets, 3px focus ring, reduced-motion.

## Per-view allowances

- App views MUST NOT use enrichment: no gradients, no background grids, no illustrations. Function
  carries the view.
- Marketing pages (if ever added) may use Tier-A CSS art or Tier-B SVG.
- Email/docs: typography only.

## What views MUST share

- The wordmark and app name.
- The accent colour and its ≤5% budget.
- The three fonts, the display tracking, and the ledger voice.
- Button shapes, radius, and the 44px height.
- The hairline rule as the only divider language.
- The plain-language rule: mechanism is never in the main flow.

## What views MAY differ on

- Density: Focus uses a ledger row per task; Settings uses a two-column document with grouped sections.
- Whether the live instrument is expanded (Focus, session running) or collapsed (Focus, idle).
- Diagnostics depth: Settings may show a collapsed disclosure; Focus never shows one.

## Exports

`tokens.css` at the project root is the canonical source. Tailwind v4 consumes it through
`@theme inline` in `src/index.css`, so every utility resolves to a named token (`bg-paper`,
`text-ink-2`, `border-rule`, `font-display`, `text-timer`).
