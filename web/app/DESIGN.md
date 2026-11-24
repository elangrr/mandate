# Mandate web app: design direction

## The scene

A supporter at their desk, checking what they agreed to pay and when the next payment comes; a creator glancing at who paid this month. Daytime and evening, a laptop or a phone. They come to read numbers they can trust and to act once in a while. So: a calm instrument, not a campaign. Mode: **Operate** for plans, mandates and the creator page; **Read** for how it works; the home page persuades with facts, not with spectacle.

Not QuestMaster: no warm paper, no green-on-cream, no bounty-board cards. Mandate is a standing order on clean paper: cool neutral ground, ink type, one cobalt blue for what you can act on.

## Colour (tokens in styles.css; contrast checked, AA for text)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f4f6f8 | #0e1319 | page |
| `--surface` | #ffffff | #161d26 | panels, inputs |
| `--ink` | #111821 | #e8edf3 | text |
| `--ink-2` | #4a5664 | #a3afbd | secondary text (≥ 4.5:1 on bg and surface) |
| `--line` | #d9dfe6 | #263140 | borders, rules |
| `--accent` | #1f4fd1 | #7aa2ff | links, primary actions, focus |
| `--accent-ink` | #ffffff | #0b1220 | text on accent |
| `--ok` | #146c43 | #5fd39a | active, paid |
| `--warn` | #8a5300 | #f0b45a | stopped on chain, blocked key |
| `--danger` | #b42318 | #ff8a80 | read errors |

One accent only. No violet, no gradients, no glass. Status colour always comes with a word.

## Type

The platform's UI sans (no web fonts: the app loads nothing from third parties). Scale in rem, one step ratio about 1.25: 0.8125 (small), 1 (body), 1.125, 1.375, 1.75, 2.25, and a clamp(2rem, 1.4rem + 2.6vw, 3.1rem) display for the home heading only. Body line height 1.55, headings 1.15, measure 65ch. Numbers use tabular figures everywhere they line up. Addresses and keys are monospace because they are data.

## Space and shape

A 0.25rem base: 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4rem. Tight inside a group, generous between groups, more above a heading than below it. One radius scale: 0.5rem controls, 0.875rem panels, 999px pills. Borders are 1px `--line`; shadows only on lifted panels, soft and offset. Content width 68rem; text blocks 40rem. Every tap target at least 44px tall.

## Motion

One authored moment: the how-it-works picture, a coin travelling from supporter to creator while the three checks light in turn (CSS only). Everything else is quiet: a page fades in over 160 ms, links underline, buttons darken on hover and press down 1px. Ease-out, never bounce. Under `prefers-reduced-motion` the picture is still and nothing moves.

## Voice

Plain words from GLOSSARY.md. Second person, short sentences, the number first. Every state says what happens next ("Next payment from 24 Dec"), every error names the problem and the way out. No hype, no exclamation marks, no "seamless". GNOT amounts exact, the dollar figure marked as approximate. Plan titles are strangers' words: shown as plain text only. Examples are Fluxen's supporter pages only.
