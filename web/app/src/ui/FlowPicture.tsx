// The picture of the flow: the supporter sets a cap once, the creator's
// collector asks for each period's payment, and the realm checks who, how
// much and when before the coins move. CSS animates it (styles.css,
// "flow-"); under prefers-reduced-motion it is a still picture.

import { useState } from "react";
import { Icon } from "./parts";

export function FlowPicture({ amount = "1", period = "month", cap = "1.1" }: { amount?: string; period?: string; cap?: string }) {
  const label =
    `How a payment moves. Once: the supporter allows the creator’s collector at most ${cap} GNOT a ${period}, ` +
    `through Mandate only, until they stop. Then every ${period}: the collector asks for ${amount} GNOT, ` +
    `Mandate checks who is asking, how much and whether it is due, and the coins go straight to the creator.`;
  const [paused, setPaused] = useState(false);
  return (
    <figure className={paused ? "flow flow-paused" : "flow"}>
      <svg viewBox="0 0 640 300" role="img" aria-label={label} className="flow-svg">
        {/* the cap, set once by the supporter */}
        <g className="flow-cap">
          <rect x="34" y="18" width="230" height="58" rx="14" className="flow-capbox" />
          <text x="149" y="42" textAnchor="middle" className="flow-small">
            set once, signed by you
          </text>
          <text x="149" y="63" textAnchor="middle" className="flow-strong">
            at most {cap} GNOT a {period}
          </text>
          <path d="M149 76 V112" className="flow-thread" />
        </g>

        {/* supporter */}
        <g className="flow-node">
          <circle cx="110" cy="170" r="46" className="flow-disc" />
          <path d="M88 160 h44 a6 6 0 0 1 6 6 v24 a6 6 0 0 1 -6 6 h-44 a6 6 0 0 1 -6 -6 v-24 a6 6 0 0 1 6 -6 Z M120 178 h10" className="flow-glyph" />
          <text x="110" y="240" textAnchor="middle" className="flow-label">
            Supporter
          </text>
        </g>

        {/* the realm */}
        <g className="flow-node">
          <circle cx="320" cy="170" r="58" className="flow-disc flow-realm" />
          <text x="320" y="158" textAnchor="middle" className="flow-strong">
            Mandate
          </text>
          {/* the three checks, drawn ticks (not a text glyph) */}
          {[
            ["who", 182],
            ["how much", 198],
            ["when", 214],
          ].map(([word, y], i) => (
            <g key={word} className={`flow-check flow-check-${i + 1}`}>
              <path d={`M282 ${Number(y) - 4} l3 3 6 -7`} className="flow-tick" />
              <text x="296" y={y}>
                {word}
              </text>
            </g>
          ))}
          <text x="320" y="252" textAnchor="middle" className="flow-label">
            the rulebook
          </text>
        </g>

        {/* creator */}
        <g className="flow-node">
          <circle cx="530" cy="170" r="46" className="flow-disc" />
          <path d="M530 150 l6 13 14 2 -10 10 2 14 -12 -7 -12 7 2 -14 -10 -10 14 -2 Z" className="flow-glyph" />
          <text x="530" y="240" textAnchor="middle" className="flow-label">
            Creator
          </text>
        </g>

        {/* the path of a payment */}
        <path d="M158 170 H260" className="flow-track" />
        <path d="M380 170 H482" className="flow-track" />
        <path id="flow-route" d="M158 170 H482" fill="none" stroke="none" />
        <g className="flow-coin">
          <circle r="11" className="flow-coin-disc" />
          <text y="4" textAnchor="middle" className="flow-coin-text">
            {amount}
          </text>
        </g>

        {/* every period */}
        <path d="M420 92 a24 24 0 1 1 -2 -10" className="flow-loop" />
        <path d="M420 74 l-2 8 -8 -3" className="flow-loop" />
        <text x="470" y="84" className="flow-small">
          every {period}, the creator’s
        </text>
        <text x="470" y="100" className="flow-small">
          collector asks for {amount} GNOT
        </text>
      </svg>

      {/* the same picture stacked, for narrow screens (CSS shows one of the two) */}
      <svg viewBox="0 0 340 540" role="img" aria-label={label} className="flow-svg flow-svg-narrow">
        <rect x="55" y="8" width="230" height="56" rx="14" className="flow-capbox" />
        <text x="170" y="31" textAnchor="middle" className="flow-small">
          set once, signed by you
        </text>
        <text x="170" y="52" textAnchor="middle" className="flow-strong">
          at most {cap} GNOT a {period}
        </text>
        <path d="M170 64 V88" className="flow-thread" />

        <circle cx="170" cy="130" r="40" className="flow-disc" />
        <path d="M150 121 h40 a5 5 0 0 1 5 5 v20 a5 5 0 0 1 -5 5 h-40 a5 5 0 0 1 -5 -5 v-20 a5 5 0 0 1 5 -5 Z M178 136 h9" className="flow-glyph" />
        <text x="222" y="135" className="flow-label">
          Supporter
        </text>

        <path d="M170 172 V222" className="flow-track" />
        <circle cx="170" cy="280" r="56" className="flow-disc flow-realm" />
        <text x="170" y="266" textAnchor="middle" className="flow-strong">
          Mandate
        </text>
        {[
          ["who", 288],
          ["how much", 304],
          ["when", 320],
        ].map(([word, y], i) => (
          <g key={word} className={`flow-check flow-check-${i + 1}`}>
            <path d={`M132 ${Number(y) - 4} l3 3 6 -7`} className="flow-tick" />
            <text x="146" y={y}>
              {word}
            </text>
          </g>
        ))}
        <text x="102" y="285" textAnchor="end" className="flow-label">
          the rulebook
        </text>

        <path d="M170 338 V388" className="flow-track" />
        <circle cx="170" cy="430" r="40" className="flow-disc" />
        <path d="M170 410 l6 13 14 2 -10 10 2 14 -12 -7 -12 7 2 -14 -10 -10 14 -2 Z" className="flow-glyph" />
        <text x="222" y="435" className="flow-label">
          Creator
        </text>

        <path id="flow-route-v" d="M170 172 V388" fill="none" stroke="none" />
        <g className="flow-coin flow-coin-v">
          <circle r="11" className="flow-coin-disc" />
          <text y="4" textAnchor="middle" className="flow-coin-text">
            {amount}
          </text>
        </g>
        <text x="170" y="500" textAnchor="middle" className="flow-small">
          every {period}, the creator’s collector
        </text>
        <text x="170" y="518" textAnchor="middle" className="flow-small">
          asks for {amount} GNOT
        </text>
      </svg>
      <figcaption className="muted small">
        <p>Nothing is locked up front: each payment goes from the supporter to the creator in one transaction, and the realm keeps nothing.</p>
        {/* the picture loops: a way to stop it (WCAG 2.2.2); hidden under reduced motion, where it is still */}
        <button type="button" className="btn btn-quiet flow-toggle" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          <Icon name={paused ? "play" : "pause"} />
          {paused ? "Play the picture" : "Pause the picture"}
        </button>
      </figcaption>
    </figure>
  );
}
