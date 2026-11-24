# Mandate web app: design direction — Night Console

## The scene

A supporter or creator opening a precision financial instrument at night or at their desk: checking exact GNOT amounts, seeing the hard cap that the chain enforces, and watching the monthly rhythm of payments stay cleanly below that ceiling. Mandate is direct debit with an unbreakable cap — not a generic dashboard and not a warm-paper bounty board. Every screen treats the cap and the payment cadence as tangible, legible objects.

Dark theme is the primary voice (**Night Console**: deep obsidian ground, layered slate-navy surfaces with fine top-edge light catches, electric cyan for active flow and controls, and signal amber exclusively for the cap ceiling, warnings, and standby states). Light theme (**Daylight Console**) carries the exact same machined hierarchy on cool titanium paper with deep instrument teal and burnished amber.

## Colour (tokens in `src/styles.css`; AA contrast verified ≥ 4.5:1 for text, ≥ 3:1 for large type and control borders)

| Token | Dark (Night Console) | Light (Daylight Console) | Role |
|---|---|---|---|
| `--bg` | `#090c12` | `#eef2f6` | page ground (with subtle ambient top radial depth) |
| `--surface` | `#101622` | `#ffffff` | primary console cards, panels |
| `--surface-2` | `#161e2e` | `#e3e9f1` | recessed telemetry wells, meters, inputs |
| `--surface-3` | `#1d273b` | `#d8e0eb` | interactive hover wells |
| `--ink` | `#edf2f9` | `#0c131d` | primary text and numerals |
| `--ink-2` | `#96a7be` | `#425166` | secondary text, labels (≥ 6:1 on ground and surfaces) |
| `--line` / `--line-strong` | `#232e42` / `#32425e` | `#cdd6e2` / `#b4c0d0` | hairline structural dividers |
| `--field-line` | `#637590` | `#69798e` | input and control borders (≥ 3:1) |
| `--accent` | `#38e8d6` | `#006c64` | luminous cyan / machined teal: primary actions, active flow, focus |
| `--accent-ink` | `#041618` | `#ffffff` | text on primary accent |
| `--signal` / `--warn` | `#f5b544` | `#945400` | cap ceiling line, fee allowance, standby/waiting, caution |
| `--ok` | `#4be096` | `#0d6840` | active mandates, verified checks, confirmed payments |
| `--danger` | `#ff8484` | `#b82222` | read errors, destructive stop confirmations |

Status colour is always paired with a word and a geometric shape or beacon dot.

## Type

Two self-hosted SIL OFL 1.1 variable fonts committed in `public/fonts/` (Latin subset, ~52.5 KB total, `font-display: swap`, `font-src 'self'` in CSP):

- **Space Grotesk** (400–700): headings, display figures, and UI prose — geometric, tight-tracked (`-0.025em` to `-0.032em` on display), with unmistakable oversized tabular numerals (`clamp(2.1rem, 1.45rem + 2.4vw, 3.25rem)` for hero amounts and chain totals).
- **JetBrains Mono** (400–700): kickers, cap ceiling tags, period ticks, status stamps, wallet addresses, and structured ledger facts.

Body size `1rem` / `1.58` line-height, max prose measure `42rem`. All numeric readouts use `font-variant-numeric: tabular-nums`.

## Signature elements by screen

- **Shared shell**: Sticky translucent command bar with a 2px cyan-to-amber top hairline, custom capped-channel `M` emblem (amber ceiling bar over cyan M-pulse), active nav indicator line, live network beacon pill, and hardware-key wallet pill.
- **Home**: Split hero pairing the display statement with a **Standing-Order Specimen Console** (`1.00 GNOT / 30 days` pulsing below a dashed amber `1.1 GNOT` ceiling), followed by an upgraded **Payment Channel Schematic** (`FlowPicture`) with an overhead hard-cap ceiling band, chambered rulebook verifier (`who`, `how much`, `when`), and period timeline rail; numbered `01–04` honest-limits cards; and an oversized 4-cell chain telemetry strip.
- **Plan page**: Oversized financial header paired with the **Cap Ceiling Meter** (`CapMeter` splitting price vs fee allowance against the vertical amber ceiling pin), 4-cell telemetry bar, and a **Standing-Order Authorization Console** combining the recurring `RhythmStrip` timeline with a highlighted "Ready to sign" slip.
- **Waiting for approval (`NotLive`)**: Amber-edged **Console Standby Panel** with a `STANDBY · AWAITING PACKAGE APPROVAL` beacon, structured action rows, and a recessed mono realm-path readout.
- **My mandates**: Command-bar address lookup, a **16-segment Wallet Capacity Gauge** beside the active count, and tone-coded **Standing-Order Pass** cards (emerald / amber / slate left edge, status stamp, oversized price + cap chip, cadence rhythm strip, and recessed 4-cell facts grid).

## Motion

CSS only (zero animation libraries). Subtle upward hero stagger (`420ms ease-out`), cap-meter fill entrance, gentle period-bar rhythm pulse under the cap ceiling, the looping payment pulse & check illumination in `FlowPicture` (with an explicit Pause/Play button), tactile button press (`translateY(1px) scale(0.985)`), and wallet-step pulse ring. Under `@media (prefers-reduced-motion: reduce)`, every animation stops cleanly and every diagram renders complete and still.

## Voice

Plain words from `GLOSSARY.md`. Exact GNOT numbers first, approximate USD clearly marked, strangers' plan titles always rendered as plain text, and all risk, limit, and wallet wording kept exact.
