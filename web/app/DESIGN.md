# Mandate web app: design direction — Night Console

## The scene

A supporter or creator opening a precision financial console at night or at their desk: checking exact GNOT amounts, seeing the hard cap enforced by the chain (and what happens beyond it), and inspecting the real rhythm of payments. Mandate is direct debit with an unbreakable cap — never a generic admin template and never warm-paper bounty cards.

Dark theme is the primary voice (**Night Console**: deep obsidian ground, layered slate-navy surfaces with fine top-edge light catches, electric cyan for active flow and primary actions, signal amber for the cap ceiling, warnings, and waiting-for-approval states). Light theme (**Daylight Console**) carries the exact same machined hierarchy on cool titanium paper with deep instrument teal and burnished amber.

## Truth rule

Every label, badge, bar, and count says only what is literally true on that screen:
- Illustrations and example cards say they are illustrations or examples (`How a payment moves · illustration`, `Example standing order`, `Example cap`); never fake telemetry or live-status claims.
- Pre-subscribe period bars on the Plan page are labelled `Preview` and compute possible payments from `floor((until - now - 1) / period) + 1`; all drawn bars remain visible at every width so the caption always matches what is drawn.
- Real mandate timelines on My mandates (`src/ui/mandateView.ts`) state only three facts: exact payments made (`pulls`, up to 6 marks + `+N earlier`, never inferred from dates), present state (`paid until <date>` with `carried over` when `pulls == 0`, or `payment due`), and payments still possible before `expiresAt` (only when active; stopped/cancelled/expired mandates show 0 possible marks and state why). The cap tag is shown only when an active permission exists.
- The 16-slot wallet capacity gauge counts the active mandates read, shows `at least N / 16` with dashed remaining slots when history is truncated, and preserves the near-limit warning whenever the read active count is at or above `maxActive - 2`.
- `CapMeter` and bar heights draw proportionally with a minimum visible sliver and an explicit `not to scale` badge whenever clamping is needed.
- Confirm panels never say `Ready to sign` while a button is disabled or waiting on a pending step.

## Colour (tokens in `src/styles.css`; WCAG AA verified ≥ 4.5:1 for text, ≥ 3:1 for control borders and focus rings)

| Token | Dark (Night Console) | Light (Daylight Console) | Role |
|---|---|---|---|
| `--bg` | `#090c12` | `#eef2f6` | page ground (subtle ambient radial top depth) |
| `--surface` | `#101622` | `#ffffff` | primary console cards, panels |
| `--surface-2` | `#161e2e` | `#e3e9f1` | recessed meters, timelines, inputs, wells |
| `--surface-3` | `#1d273b` | `#d8e0eb` | interactive hover wells |
| `--ink` | `#edf2f9` | `#0c131d` | primary text and numerals |
| `--ink-2` | `#96a7be` | `#425166` | secondary text and kickers (≥ 6.0:1 on all surfaces) |
| `--line` / `--line-strong` | `#232e42` / `#32425e` | `#cdd6e2` / `#b4c0d0` | structural dividers |
| `--field-line` | `#637590` | `#69798e` | interactive control and input borders (≥ 3.56:1 dark, ≥ 3.64:1 light) |
| `--accent` | `#38e8d6` | `#006c64` | cyan / machined teal: primary actions, active flow, focus rings |
| `--accent-ink` | `#041618` | `#ffffff` | text on primary accent |
| `--signal` / `--warn` | `#f5b544` | `#945400` | cap ceiling line, fee allowance, waiting for approval, cautions |
| `--ok` | `#4be096` | `#0d6840` | active mandates, paid periods, verified checks |
| `--danger` | `#ff8484` | `#b82222` | beyond-cap refused zone, read/display errors, destructive stop confirm |

Status colour is always paired with a word and a distinct shape, border style, or glyph (`✓`, `×`, `NOW`, dot).

## Type

Two self-hosted SIL OFL 1.1 variable fonts committed in `public/fonts/` (Latin subset, 53.7 KB total, `font-display: swap`, `font-src 'self'` in CSP):
- **Space Grotesk** (400–700): headings, oversized financial numerals (`--t-figure`), and body prose (`1rem` / `1.58`, measure `42rem`).
- **JetBrains Mono** (400–700): kickers, cap readouts, period ticks, status pills, addresses, and ledger tables.

## Signature components by screen

- **Shell**: Translucent sticky command bar with 2px cyan-to-amber hairline, capped-channel `M` emblem, active nav bar, network pill, theme switcher, wallet readout, and full-width alert slot for wallet errors and persistent pending-step banners.
- **Home**: Split hero pairing the display headline with an explicitly labelled `Example standing order` card, the ceiling-banded `FlowPicture` illustration (pausable), `01–04` honest-limits cards, oversized 4-cell chain totals, and plan cards.
- **All plans**: 4-cell page summary strip (real counts from the loaded page), plan cards with cap readouts, and button pager controls.
- **Plan page**: Oversized price header with `CapMeter` (price + fee allowance → amber cap pin → coral-hatched beyond-cap zone labelled `"Above the cap: refused by the chain"`), 4-cell telemetry bar, `Plan terms` card with labelled period `Preview`, framed `Steps` approval progress panel, and wallet states (`Ready to sign`, recovery, blocked, refused, stopped on chain, pending, wrong network, missing/locked wallet).
- **My mandates**: Command-bar address form, 16-slot `SlotGauge` (with `unknown` fallback), tone-coded standing-order passes with data-driven `MandatePeriods` (distinct paid / current `NOW` / upcoming / stopped bars), recessed facts grid, stop confirmation, and amber loose-permission cards.
- **Creator**: Identity bar with live collector-key status pill, 4-cell totals, `CreatorChart` paired horizontal bar chart (`This period` vs `Last period` from real counts), tone-coded collector key card with blocked-key notice, and responsive plans table that stacks cleanly on phones.
- **How it works, Waiting for approval, 404 & Error recovery**: `FlowPicture` + `01–04` architecture step cards + 2-column FAQ grid; amber `Waiting for approval` standby card (`NotLive`); `404 · Page not found` panel; and coral-edged `ErrorCard` shared by `Boundary` and `ReadFailed`.

## Motion

CSS only. One-shot entrances (page fade-in, hero stagger, cap-meter fill, period-bar rise) and tactile hover/press feedback. The only continuous page loop is the `FlowPicture` payment travel, which stops via its `Pause the picture` button; transient loading/wallet-approval indicators stop when idle. Under `@media (prefers-reduced-motion: reduce)`, every animation stops and transitions collapse to instant state changes.
